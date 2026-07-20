import type {
  DingTalkConnectionSummary,
  ReadOnlyDingTalkCalDavClient,
} from './dingtalk-caldav-client.js';
import type { DingTalkCredentialStore } from './dingtalk-credential-store.js';
import {
  parseDingTalkCalendarObjects,
  type DingTalkCalendarParseResult,
} from './dingtalk-calendar-parser.js';
import type {
  DingTalkCalendarSettings,
  DingTalkSyncResult,
} from './dingtalk-calendar-types.js';
import type { DingTalkCalendarWriter } from './dingtalk-calendar-writer.js';

const DAY_MILLISECONDS = 86_400_000;
const CONFIGURATION_ERROR = '请先补全钉钉日历连接设置';
const CONNECTION_ERROR = '钉钉日历连接失败，请检查连接设置后重试';

export interface DingTalkCalendarControllerDependencies {
  client: ReadOnlyDingTalkCalDavClient;
  writer: Pick<DingTalkCalendarWriter, 'apply'>;
  credentialStore: Pick<DingTalkCredentialStore, 'getPassword'>;
  getSettings: () => DingTalkCalendarSettings;
  saveSettings: (settings: DingTalkCalendarSettings) => Promise<void>;
  parse?: typeof parseDingTalkCalendarObjects;
  clock?: () => Date;
}

function syncWindow(now: Date, days: number): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return {
    start,
    end: new Date(start.getTime() + days * DAY_MILLISECONDS),
  };
}

function initialResult(startedAt: string): DingTalkSyncResult {
  return {
    startedAt,
    finishedAt: startedAt,
    added: 0,
    updated: 0,
    cancelled: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
  };
}

function configuredConnection(
  settings: DingTalkCalendarSettings,
  password: string | null,
): { serverUrl: string; username: string; password: string } | null {
  if (
    settings.serverUrl.trim() === ''
    || settings.username.trim() === ''
    || password === null
    || password === ''
  ) return null;
  return {
    serverUrl: settings.serverUrl,
    username: settings.username,
    password,
  };
}

export class DingTalkCalendarController {
  private readonly dependencies: DingTalkCalendarControllerDependencies;
  private readonly parse: typeof parseDingTalkCalendarObjects;
  private readonly clock: () => Date;
  private inFlight: Promise<DingTalkSyncResult> | null = null;

  constructor(dependencies: DingTalkCalendarControllerDependencies) {
    this.dependencies = dependencies;
    this.parse = dependencies.parse ?? parseDingTalkCalendarObjects;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async testConnection(): Promise<DingTalkConnectionSummary> {
    const settings = this.dependencies.getSettings();
    const password = await this.dependencies.credentialStore.getPassword();
    const connection = configuredConnection(settings, password);
    if (connection === null) throw new Error(CONFIGURATION_ERROR);
    try {
      return await this.dependencies.client.testConnection(connection);
    } catch {
      throw new Error(CONNECTION_ERROR);
    }
  }

  sync(): Promise<DingTalkSyncResult> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.runSync();
    this.inFlight = operation.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async clearImportHistory(): Promise<void> {
    const current = this.dependencies.getSettings();
    await this.dependencies.saveSettings({
      ...current,
      syncToken: null,
      lastSuccessfulSyncAt: null,
      lastResult: null,
      lastError: null,
      events: {},
    });
  }

  private async runSync(): Promise<DingTalkSyncResult> {
    const settings = this.dependencies.getSettings();
    const password = await this.dependencies.credentialStore.getPassword();
    const connection = configuredConnection(settings, password);
    if (connection === null) {
      await this.dependencies.saveSettings({ ...settings, lastError: CONFIGURATION_ERROR });
      throw new Error(CONFIGURATION_ERROR);
    }

    const startedAt = this.clock().toISOString();
    const result = initialResult(startedAt);
    const window = syncWindow(this.clock(), settings.syncWindowDays);
    let fetched;
    try {
      fetched = await this.dependencies.client.fetchPrimaryCalendar({
        ...connection,
        windowStart: window.start,
        windowEnd: window.end,
      });
    } catch {
      await this.dependencies.saveSettings({ ...settings, lastError: CONNECTION_ERROR });
      throw new Error(CONNECTION_ERROR);
    }

    let parsed: DingTalkCalendarParseResult;
    try {
      parsed = this.parse({
        calendarId: fetched.calendar.id,
        objects: fetched.objects,
        window,
      });
    } catch {
      parsed = {
        occurrences: [],
        issues: fetched.objects.map((object) => ({
          href: object.href,
          code: 'invalid_icalendar' as const,
        })),
      };
    }

    const events = { ...settings.events };
    result.errors += parsed.issues.length;
    for (const occurrence of parsed.occurrences) {
      const previous = settings.events[occurrence.eventKeyHash];
      try {
        const written = await this.dependencies.writer.apply(occurrence, previous);
        events[occurrence.eventKeyHash] = written.entry;
        result.conflicts += written.conflicts;
        const becameCancelled = occurrence.snapshot.state === 'cancelled'
          && previous?.remoteSnapshot.state !== 'cancelled';
        if (becameCancelled) result.cancelled += 1;
        else if (written.action === 'added') result.added += 1;
        else if (written.action === 'updated') result.updated += 1;
        else result.skipped += 1;
      } catch {
        result.errors += 1;
      }
    }

    result.finishedAt = this.clock().toISOString();
    const complete = result.errors === 0;
    await this.dependencies.saveSettings({
      ...settings,
      events,
      syncToken: complete
        ? (fetched.syncToken ?? settings.syncToken)
        : settings.syncToken,
      lastSuccessfulSyncAt: complete ? result.finishedAt : settings.lastSuccessfulSyncAt,
      lastResult: result,
      lastError: complete
        ? null
        : `同步完成，但有 ${result.errors} 个日程未能处理，将在下次重试`,
    });
    return result;
  }
}
