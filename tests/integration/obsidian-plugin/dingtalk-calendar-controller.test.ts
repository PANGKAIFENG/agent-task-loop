import { describe, expect, it, vi } from 'vitest';

import type {
  DingTalkFetchedCalendar,
  ReadOnlyDingTalkCalDavClient,
} from '../../../src/obsidian-plugin/dingtalk-caldav-client.js';
import {
  DingTalkCalendarController,
} from '../../../src/obsidian-plugin/dingtalk-calendar-controller.js';
import type {
  DingTalkCalendarOccurrence,
  DingTalkCalendarParseResult,
} from '../../../src/obsidian-plugin/dingtalk-calendar-parser.js';
import type {
  DingTalkCalendarSettings,
  DingTalkEventLedgerEntry,
} from '../../../src/obsidian-plugin/dingtalk-calendar-types.js';
import type {
  DingTalkCalendarWriteResult,
  DingTalkCalendarWriter,
} from '../../../src/obsidian-plugin/dingtalk-calendar-writer.js';

function settings(overrides: Partial<DingTalkCalendarSettings> = {}): DingTalkCalendarSettings {
  return {
    stateVersion: 1,
    enabled: true,
    serverUrl: 'https://calendar.example.com/caldav',
    username: 'synthetic@example.com',
    calendarId: 'primary',
    syncWindowDays: 90,
    intervalMinutes: 15,
    syncToken: 'sync-token-old',
    lastSuccessfulSyncAt: null,
    lastResult: null,
    lastError: null,
    events: {},
    ...overrides,
  };
}

function occurrence(overrides: Partial<DingTalkCalendarOccurrence> = {}): DingTalkCalendarOccurrence {
  return {
    eventKeyHash: `sha256:${'a'.repeat(64)}`,
    remoteUid: 'synthetic-event@example.com',
    recurrenceId: null,
    href: '/primary/synthetic.ics',
    etag: 'etag-1',
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    snapshot: {
      title: 'Synthetic meeting',
      start: '2026-07-20T14:00:00+08:00',
      end: '2026-07-20T15:00:00+08:00',
      allDay: false,
      description: null,
      location: null,
      state: 'active',
    },
    ...overrides,
  };
}

function entry(value: DingTalkCalendarOccurrence): DingTalkEventLedgerEntry {
  return {
    eventKeyHash: value.eventKeyHash,
    remoteUid: value.remoteUid,
    recurrenceId: value.recurrenceId,
    href: value.href,
    etag: value.etag,
    taskPath: `TaskNotes/DingTalk/${value.eventKeyHash.replace(':', '-')}.md`,
    remoteSnapshotHash: value.snapshotHash,
    remoteSnapshot: value.snapshot,
    lastSeenAt: '2026-07-20T01:00:00.000Z',
    locallyDeletedAt: null,
    cancelledBySync: value.snapshot.state === 'cancelled',
  };
}

function fetched(): DingTalkFetchedCalendar {
  return {
    calendar: {
      id: 'primary',
      displayName: '主日历',
      url: 'https://calendar.example.com/primary/',
    },
    objects: [{ href: '/primary/synthetic.ics', etag: 'etag-1', data: 'synthetic' }],
    syncToken: 'sync-token-new',
  };
}

function dependencies(options: {
  initial?: DingTalkCalendarSettings;
  parsed?: DingTalkCalendarParseResult;
  apply?: (value: DingTalkCalendarOccurrence, previous?: DingTalkEventLedgerEntry) => Promise<DingTalkCalendarWriteResult>;
  fetch?: () => Promise<DingTalkFetchedCalendar>;
  password?: string | null;
  getPassword?: () => Promise<string | null>;
  clock?: () => Date;
} = {}) {
  let current = options.initial ?? settings();
  const saveSettings = vi.fn(async (next: DingTalkCalendarSettings) => {
    current = next;
  });
  const client: ReadOnlyDingTalkCalDavClient = {
    testConnection: vi.fn(async () => ({
      username: current.username,
      calendarName: '主日历',
      availableCalendarNames: ['主日历'],
    })),
    fetchPrimaryCalendar: vi.fn(options.fetch ?? (async () => fetched())),
  };
  const value = occurrence();
  const parse = vi.fn(() => options.parsed ?? { occurrences: [value], issues: [] });
  const apply = vi.fn(options.apply ?? (async (next) => ({
    action: 'added' as const,
    entry: entry(next),
    conflicts: 0,
  })));
  const writer = { apply } as Pick<DingTalkCalendarWriter, 'apply'>;
  const controller = new DingTalkCalendarController({
    client,
    writer,
    credentialStore: {
      getPassword: options.getPassword
        ?? (async () => options.password ?? 'synthetic-password'),
    },
    getSettings: () => current,
    saveSettings,
    parse,
    clock: options.clock ?? (() => new Date('2026-07-20T04:00:00.000Z')),
  });
  return { controller, client, apply, parse, saveSettings, current: () => current };
}

describe('DingTalkCalendarController', () => {
  it('runs a bounded first sync and persists only successful writer entries', async () => {
    const context = dependencies();
    const result = await context.controller.sync();

    expect(result).toMatchObject({ added: 1, updated: 0, skipped: 0, errors: 0 });
    expect(context.client.fetchPrimaryCalendar).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'synthetic@example.com',
      password: 'synthetic-password',
    }));
    const query = vi.mocked(context.client.fetchPrimaryCalendar).mock.calls[0]?.[0];
    expect(query!.windowStart.toISOString()).toBe('2026-07-20T04:00:00.000Z');
    expect(query!.windowEnd.toISOString()).toBe('2026-10-18T04:00:00.000Z');
    expect((query!.windowEnd.getTime() - query!.windowStart.getTime()) / 86_400_000).toBe(90);
    expect(context.current().events[occurrence().eventKeyHash]).toBeDefined();
    expect(context.current()).toMatchObject({
      syncToken: 'sync-token-new',
      lastSuccessfulSyncAt: '2026-07-20T04:00:00.000Z',
      lastError: null,
    });
  });

  it('returns the same promise for duplicate sync requests', async () => {
    let release!: (value: DingTalkFetchedCalendar) => void;
    const pending = new Promise<DingTalkFetchedCalendar>((resolve) => {
      release = resolve;
    });
    const context = dependencies({ fetch: () => pending });

    const first = context.controller.sync();
    const second = context.controller.sync();
    expect(second).toBe(first);
    release(fetched());
    await first;
    expect(context.client.fetchPrimaryCalendar).toHaveBeenCalledTimes(1);
  });

  it('anchors the query window before credential lookup can delay the sync', async () => {
    let now = new Date('2026-07-20T04:00:00.000Z');
    const context = dependencies({
      clock: () => now,
      getPassword: async () => {
        now = new Date('2026-07-20T04:00:05.000Z');
        return 'synthetic-password';
      },
    });

    await context.controller.sync();

    const query = vi.mocked(context.client.fetchPrimaryCalendar).mock.calls[0]?.[0];
    expect(query?.windowStart.toISOString()).toBe('2026-07-20T04:00:00.000Z');
  });

  it('keeps failed snapshots retryable while saving successful occurrences', async () => {
    const successful = occurrence();
    const failed = occurrence({
      eventKeyHash: `sha256:${'c'.repeat(64)}`,
      remoteUid: 'failed-event@example.com',
      snapshotHash: `sha256:${'d'.repeat(64)}`,
    });
    const oldFailed = entry({
      ...failed,
      snapshotHash: `sha256:${'e'.repeat(64)}`,
      snapshot: { ...failed.snapshot, title: 'Old remote title' },
    });
    const context = dependencies({
      initial: settings({ events: { [failed.eventKeyHash]: oldFailed } }),
      parsed: { occurrences: [successful, failed], issues: [{ href: '/broken.ics', code: 'invalid_icalendar' }] },
      apply: async (value) => {
        if (value.eventKeyHash === failed.eventKeyHash) throw new Error('synthetic write failure');
        return { action: 'updated', entry: entry(value), conflicts: 1 };
      },
    });

    const result = await context.controller.sync();
    expect(result).toMatchObject({ updated: 1, conflicts: 1, errors: 2 });
    expect(context.current().events[failed.eventKeyHash]).toEqual(oldFailed);
    expect(context.current().events[successful.eventKeyHash]).toBeDefined();
    expect(context.current().syncToken).toBe('sync-token-old');
    expect(context.current().lastSuccessfulSyncAt).toBeNull();
    expect(context.current().lastError).toContain('2');
  });

  it('counts a remote cancellation without deleting the local TaskNotes file', async () => {
    const cancelled = occurrence({
      snapshotHash: `sha256:${'f'.repeat(64)}`,
      snapshot: { ...occurrence().snapshot, state: 'cancelled' },
    });
    const previous = entry(occurrence());
    const context = dependencies({
      initial: settings({ events: { [cancelled.eventKeyHash]: previous } }),
      parsed: { occurrences: [cancelled], issues: [] },
      apply: async (value) => ({ action: 'updated', entry: entry(value), conflicts: 0 }),
    });

    await expect(context.controller.sync()).resolves.toMatchObject({ cancelled: 1 });
    expect(context.current().events[cancelled.eventKeyHash]?.taskPath).not.toBeNull();
  });

  it('rejects incomplete configuration before network access and redacts the error', async () => {
    const context = dependencies({
      initial: settings({ serverUrl: '' }),
      password: null,
    });
    await expect(context.controller.sync()).rejects.toThrow('连接设置');
    expect(context.client.fetchPrimaryCalendar).not.toHaveBeenCalled();
    expect(context.current().lastError).toContain('连接设置');
  });

  it('clears import history without deleting imported files', async () => {
    const existing = occurrence();
    const context = dependencies({
      initial: settings({ events: { [existing.eventKeyHash]: entry(existing) } }),
    });
    await context.controller.clearImportHistory();

    expect(context.current().events).toEqual({});
    expect(context.current().syncToken).toBeNull();
    expect(context.apply).not.toHaveBeenCalled();
    expect(context.client.fetchPrimaryCalendar).not.toHaveBeenCalled();
  });
});
