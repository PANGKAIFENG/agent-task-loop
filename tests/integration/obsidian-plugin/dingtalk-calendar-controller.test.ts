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
    autoCompleteThrough: null,
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
    readErrors: 0,
    syncToken: 'sync-token-new',
  };
}

function dependencies(options: {
  initial?: DingTalkCalendarSettings;
  parsed?: DingTalkCalendarParseResult;
  apply?: (value: DingTalkCalendarOccurrence, previous?: DingTalkEventLedgerEntry) => Promise<DingTalkCalendarWriteResult>;
  reconcile?: (previous: DingTalkEventLedgerEntry) => Promise<DingTalkCalendarWriteResult>;
  fetch?: () => Promise<DingTalkFetchedCalendar>;
  password?: string | null;
  getPassword?: () => Promise<string | null>;
  clock?: () => Date;
  timeZone?: string;
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
  const reconcile = vi.fn(options.reconcile ?? (async (previous) => ({
    action: 'skipped' as const,
    entry: previous,
    conflicts: 0,
  })));
  const beginReconciliation = vi.fn();
  const endReconciliation = vi.fn();
  const writer = {
    apply,
    beginReconciliation,
    endReconciliation,
    reconcile,
  } as Pick<
    DingTalkCalendarWriter,
    'apply' | 'beginReconciliation' | 'endReconciliation' | 'reconcile'
  >;
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
    timeZone: options.timeZone ?? 'Asia/Shanghai',
  });
  return {
    controller,
    client,
    apply,
    reconcile,
    parse,
    saveSettings,
    current: () => current,
  };
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
    const expectedStart = new Date('2026-07-20T04:00:00.000Z');
    expectedStart.setHours(0, 0, 0, 0);
    expectedStart.setDate(expectedStart.getDate() - 7);
    expect(query!.windowStart.toISOString()).toBe(expectedStart.toISOString());
    expect(query!.windowEnd.toISOString()).toBe('2026-10-18T04:00:00.000Z');
    expect((query!.windowEnd.getTime() - new Date('2026-07-20T04:00:00.000Z').getTime()) / 86_400_000).toBe(90);
    expect(context.current().events[occurrence().eventKeyHash]).toBeDefined();
    expect(context.current()).toMatchObject({
      syncToken: 'sync-token-new',
      autoCompleteThrough: '2026-07-20T04:00:00.000Z',
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
    expect(query?.windowEnd.toISOString()).toBe('2026-10-18T04:00:00.000Z');
  });

  it('includes the previous week without shortening the configured future window', async () => {
    const now = new Date('2026-07-21T10:30:00+08:00');
    const previousMondayMorning = new Date('2026-07-20T09:00:00+08:00');
    const context = dependencies({ clock: () => now });

    await context.controller.sync();

    const query = vi.mocked(context.client.fetchPrimaryCalendar).mock.calls[0]?.[0];
    expect(query!.windowStart.getTime()).toBeLessThanOrEqual(previousMondayMorning.getTime());
    expect(query!.windowEnd.toISOString()).toBe('2026-10-19T02:30:00.000Z');
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

  it('writes successful occurrences while keeping partial range reads retryable', async () => {
    const context = dependencies({
      fetch: async () => ({ ...fetched(), readErrors: 2 }),
    });

    const result = await context.controller.sync();

    expect(result).toMatchObject({ added: 1, errors: 2 });
    expect(context.current().events[occurrence().eventKeyHash]).toBeDefined();
    expect(context.current().autoCompleteThrough).toBe('2026-07-20T04:00:00.000Z');
    expect(context.current().lastSuccessfulSyncAt).toBeNull();
    expect(context.current().lastError).toContain('2');
  });

  it('backfills an ended stored event when no completion cursor exists', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    const context = dependencies({
      initial: settings({ events: { [stored.eventKeyHash]: previous } }),
      parsed: { occurrences: [], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
      reconcile: async (value) => ({
        action: 'updated',
        entry: value,
        conflicts: 0,
      }),
    });

    const result = await context.controller.sync();

    expect(context.apply).not.toHaveBeenCalled();
    expect(context.reconcile).toHaveBeenCalledWith(previous);
    expect(result).toMatchObject({ updated: 1, skipped: 0, errors: 0 });
    expect(context.current().autoCompleteThrough).toBe('2026-07-20T08:00:00.000Z');
  });

  it('does not read stored events whose end is already covered by the cursor', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: '2026-07-20T07:30:00.000Z',
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
    });

    const result = await context.controller.sync();

    expect(context.reconcile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, skipped: 0, errors: 0 });
    expect(context.current().autoCompleteThrough).toBe('2026-07-20T08:00:00.000Z');
  });

  it('reconciles a newly ended event once and excludes local no-ops from skipped', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    let now = new Date('2026-07-20T07:01:00.000Z');
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: '2026-07-20T06:30:00.000Z',
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [], issues: [] },
      clock: () => now,
    });

    const first = await context.controller.sync();
    now = new Date('2026-07-20T07:16:00.000Z');
    const second = await context.controller.sync();

    expect(context.reconcile).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ updated: 0, skipped: 0, errors: 0 });
    expect(second).toMatchObject({ updated: 0, skipped: 0, errors: 0 });
    expect(context.current().autoCompleteThrough).toBe('2026-07-20T07:16:00.000Z');
  });

  it('does not reconcile an ended event twice when CalDAV returned it', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: '2026-07-20T06:30:00.000Z',
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [stored], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
      apply: async () => ({ action: 'skipped', entry: previous, conflicts: 0 }),
    });

    const result = await context.controller.sync();

    expect(context.apply).toHaveBeenCalledOnce();
    expect(context.reconcile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, skipped: 1, errors: 0 });
  });

  it('keeps a failed local completion retryable without advancing its cursor or ledger', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    const cursor = '2026-07-20T06:30:00.000Z';
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: cursor,
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
      reconcile: async () => {
        throw new Error('synthetic local write failure');
      },
    });

    const result = await context.controller.sync();

    expect(result).toMatchObject({ updated: 0, skipped: 0, errors: 1 });
    expect(context.current().events[stored.eventKeyHash]).toEqual(previous);
    expect(context.current().autoCompleteThrough).toBe(cursor);
  });

  it('does not advance the cursor when an ended returned event fails to write', async () => {
    const stored = occurrence();
    const previous = entry(stored);
    const cursor = '2026-07-20T06:30:00.000Z';
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: cursor,
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [stored], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
      apply: async () => {
        throw new Error('synthetic returned-event write failure');
      },
    });

    const result = await context.controller.sync();

    expect(result.errors).toBe(1);
    expect(context.current().events[stored.eventKeyHash]).toEqual(previous);
    expect(context.current().autoCompleteThrough).toBe(cursor);
  });

  it('leaves locally deleted event mirrors tombstoned without filesystem reconciliation', async () => {
    const stored = occurrence();
    const previous = {
      ...entry(stored),
      taskPath: null,
      locallyDeletedAt: '2026-07-20T06:00:00.000Z',
    };
    const context = dependencies({
      initial: settings({ events: { [stored.eventKeyHash]: previous } }),
      parsed: { occurrences: [], issues: [] },
      clock: () => new Date('2026-07-20T08:00:00.000Z'),
    });

    await context.controller.sync();

    expect(context.reconcile).not.toHaveBeenCalled();
    expect(context.current().events[stored.eventKeyHash]).toEqual(previous);
  });

  it('uses the configured timezone to reconcile an all-day event at local midnight', async () => {
    const stored = occurrence({
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-21',
        end: '2026-07-22',
        allDay: true,
      },
    });
    const previous = entry(stored);
    const context = dependencies({
      initial: settings({
        autoCompleteThrough: '2026-07-21T15:30:00.000Z',
        events: { [stored.eventKeyHash]: previous },
      }),
      parsed: { occurrences: [], issues: [] },
      clock: () => new Date('2026-07-21T16:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    await context.controller.sync();

    expect(context.reconcile).toHaveBeenCalledWith(previous);
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
      initial: settings({
        autoCompleteThrough: '2026-07-20T08:00:00.000Z',
        events: { [existing.eventKeyHash]: entry(existing) },
      }),
    });
    await context.controller.clearImportHistory();

    expect(context.current().events).toEqual({});
    expect(context.current().syncToken).toBeNull();
    expect(context.current().autoCompleteThrough).toBeNull();
    expect(context.apply).not.toHaveBeenCalled();
    expect(context.client.fetchPrimaryCalendar).not.toHaveBeenCalled();
  });
});
