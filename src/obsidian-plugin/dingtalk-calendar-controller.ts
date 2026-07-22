import type {
  DingTalkConnectionSummary,
  ReadOnlyDingTalkCalDavClient,
} from './dingtalk-caldav-client.js';
import type { DingTalkCredentialStore } from './dingtalk-credential-store.js';
import {
  parseDingTalkCalendarObjects,
  type DingTalkCalendarParseResult,
} from './dingtalk-calendar-parser.js';
import { eventHasEnded } from './dingtalk-calendar-merge.js';
import type {
  DingTalkCalendarSettings,
  DingTalkEventLedgerEntry,
  DingTalkRemoteSnapshot,
  DingTalkSyncResult,
} from './dingtalk-calendar-types.js';
import type { DingTalkCalendarWriter } from './dingtalk-calendar-writer.js';
import { resolveSystemTimeZone } from './system-time-zone.js';

const DAY_MILLISECONDS = 86_400_000;
const SYNC_LOOKBACK_DAYS = 7;
const CONFIGURATION_ERROR = '请先补全钉钉日历连接设置';
const CONNECTION_ERROR = '钉钉日历连接失败，请检查连接设置后重试';

export interface DingTalkCalendarControllerDependencies {
  client: ReadOnlyDingTalkCalDavClient;
  writer: Pick<
    DingTalkCalendarWriter,
    'apply' | 'beginReconciliation' | 'endReconciliation' | 'reconcile'
  >;
  credentialStore: Pick<DingTalkCredentialStore, 'getPassword'>;
  getSettings: () => DingTalkCalendarSettings;
  saveSettings: (settings: DingTalkCalendarSettings) => Promise<void>;
  parse?: typeof parseDingTalkCalendarObjects;
  clock?: () => Date;
  timeZone?: string;
}

function syncWindow(now: Date, days: number): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - SYNC_LOOKBACK_DAYS);
  return {
    start,
    end: new Date(now.getTime() + days * DAY_MILLISECONDS),
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

function snapshotNeedsLocalCompletion(
  snapshot: DingTalkRemoteSnapshot,
  cursor: string | null,
  through: Date,
  timeZone: string,
): boolean {
  if (
    snapshot.state !== 'active'
    || !eventHasEnded(snapshot, through, timeZone)
  ) return false;
  return cursor === null
    || !eventHasEnded(snapshot, new Date(cursor), timeZone);
}

function needsLocalCompletion(
  entry: DingTalkEventLedgerEntry,
  cursor: string | null,
  through: Date,
  timeZone: string,
): boolean {
  return entry.locallyDeletedAt === null && snapshotNeedsLocalCompletion(
    entry.remoteSnapshot,
    cursor,
    through,
    timeZone,
  );
}

export class DingTalkCalendarController {
  private readonly dependencies: DingTalkCalendarControllerDependencies;
  private readonly parse: typeof parseDingTalkCalendarObjects;
  private readonly clock: () => Date;
  private readonly timeZone: string;
  private inFlight: Promise<DingTalkSyncResult> | null = null;

  constructor(dependencies: DingTalkCalendarControllerDependencies) {
    this.dependencies = dependencies;
    this.parse = dependencies.parse ?? parseDingTalkCalendarObjects;
    this.clock = dependencies.clock ?? (() => new Date());
    this.timeZone = dependencies.timeZone ?? resolveSystemTimeZone();
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
      autoCompleteThrough: null,
      lastSuccessfulSyncAt: null,
      lastResult: null,
      lastError: null,
      events: {},
    });
  }

  private async runSync(): Promise<DingTalkSyncResult> {
    const started = this.clock();
    const settings = this.dependencies.getSettings();
    const password = await this.dependencies.credentialStore.getPassword();
    const connection = configuredConnection(settings, password);
    if (connection === null) {
      await this.dependencies.saveSettings({ ...settings, lastError: CONFIGURATION_ERROR });
      throw new Error(CONFIGURATION_ERROR);
    }

    const startedAt = started.toISOString();
    const result = initialResult(startedAt);
    const window = syncWindow(started, settings.syncWindowDays);
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
    const fetchedEventKeys = new Set<string>();
    let localCompletionFailed = false;
    result.errors += fetched.readErrors + parsed.issues.length;
    for (const occurrence of parsed.occurrences) {
      fetchedEventKeys.add(occurrence.eventKeyHash);
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
        if (snapshotNeedsLocalCompletion(
          occurrence.snapshot,
          settings.autoCompleteThrough,
          started,
          this.timeZone,
        )) localCompletionFailed = true;
      }
    }
    this.dependencies.writer.beginReconciliation();
    try {
      for (const [eventKeyHash, previous] of Object.entries(settings.events)) {
        if (fetchedEventKeys.has(eventKeyHash)) continue;
        if (!needsLocalCompletion(
          previous,
          settings.autoCompleteThrough,
          started,
          this.timeZone,
        )) continue;
        try {
          const written = await this.dependencies.writer.reconcile(previous);
          events[eventKeyHash] = written.entry;
          result.conflicts += written.conflicts;
          if (written.action === 'updated') result.updated += 1;
        } catch {
          result.errors += 1;
          localCompletionFailed = true;
        }
      }
    } finally {
      this.dependencies.writer.endReconciliation();
    }

    result.finishedAt = this.clock().toISOString();
    const complete = result.errors === 0;
    await this.dependencies.saveSettings({
      ...settings,
      events,
      autoCompleteThrough: localCompletionFailed
        ? settings.autoCompleteThrough
        : startedAt,
      syncToken: complete
        ? (fetched.syncToken ?? settings.syncToken)
        : settings.syncToken,
      lastSuccessfulSyncAt: complete ? result.finishedAt : settings.lastSuccessfulSyncAt,
      lastResult: result,
      lastError: complete
        ? null
        : `同步完成，但有 ${result.errors} 项读取或处理失败，将在下次重试`,
    });
    return result;
  }
}
