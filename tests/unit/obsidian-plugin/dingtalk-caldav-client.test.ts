import { describe, expect, it, vi } from 'vitest';

import {
  createReadOnlyDingTalkCalDavClient,
  type DingTalkCalDavClientFactory,
} from '../../../src/obsidian-plugin/dingtalk-caldav-client.js';

function createFactory(options?: {
  calendars?: Array<Record<string, unknown>>;
  objects?: Array<Record<string, unknown>>;
}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const factory: DingTalkCalDavClientFactory = async (input) => ({
    createAccount: async (accountInput) => {
      calls.push({ name: 'createAccount', input: accountInput as Record<string, unknown> });
      return {
        accountType: 'caldav',
        serverUrl: input.serverUrl,
        rootUrl: input.serverUrl,
        principalUrl: `${input.serverUrl}/principal`,
        homeUrl: `${input.serverUrl}/home`,
      };
    },
    fetchCalendars: async (calendarInput) => {
      calls.push({ name: 'fetchCalendars', input: calendarInput as Record<string, unknown> });
      return (options?.calendars ?? [{
        url: `${input.serverUrl}/primary/`,
        displayName: '主日历',
        components: ['VEVENT'],
      }]) as never;
    },
    fetchCalendarObjects: async (calendarInput) => {
      calls.push({ name: 'fetchCalendarObjects', input: calendarInput as Record<string, unknown> });
      return (options?.objects ?? [{
        url: `${input.serverUrl}/primary/event.ics`,
        etag: 'etag-1',
        data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }]) as never;
    },
  });
  return { calls, factory };
}

describe('read-only DingTalk CalDAV client', () => {
  it('discovers the primary calendar and bounds the event query', async () => {
    const { calls, factory } = createFactory();
    const client = createReadOnlyDingTalkCalDavClient({ factory });
    const result = await client.fetchPrimaryCalendar({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
      windowStart: new Date('2026-07-20T00:00:00Z'),
      windowEnd: new Date('2026-10-18T00:00:00Z'),
    });

    expect(result.calendar).toMatchObject({ id: 'primary', displayName: '主日历' });
    expect(result.objects).toHaveLength(1);
    const query = calls.find((call) => call.name === 'fetchCalendarObjects');
    expect(query?.input).toMatchObject({
      timeRange: {
        start: '2026-07-20T00:00:00.000Z',
        end: '2026-10-18T00:00:00.000Z',
      },
      expand: false,
    });
  });

  it('uses Basic credentials and rejects any write method at the transport boundary', async () => {
    const fetchCalls: Array<{ method: string; headers: HeadersInit | undefined }> = [];
    const factory: DingTalkCalDavClientFactory = async (input) => {
      const fetch = input.fetch;
      expect(fetch).toBeDefined();
      await expect(fetch?.('https://calendar.example.com', { method: 'PUT' })).rejects.toThrow(
        'read-only',
      );
      fetchCalls.push({ method: 'PROPFIND', headers: input.fetchOptions?.headers });
      return {
        createAccount: async () => ({
          accountType: 'caldav',
          serverUrl: input.serverUrl,
          rootUrl: input.serverUrl,
          principalUrl: `${input.serverUrl}/principal`,
          homeUrl: `${input.serverUrl}/home`,
        }),
        fetchCalendars: async () => [{
          url: `${input.serverUrl}/primary/`,
          displayName: '主日历',
          components: ['VEVENT'],
        }] as never,
        fetchCalendarObjects: async () => [] as never,
      };
    };
    const client = createReadOnlyDingTalkCalDavClient({ factory });
    await client.testConnection({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('user@example.com:synthetic-password').toString('base64')}`,
    });
  });

  it('rejects insecure remote URLs and ambiguous calendars', async () => {
    const factory = vi.fn<DingTalkCalDavClientFactory>();
    const client = createReadOnlyDingTalkCalDavClient({ factory });
    await expect(client.testConnection({
      serverUrl: 'http://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
    })).rejects.toThrow('HTTPS');
    expect(factory).not.toHaveBeenCalled();

    const ambiguous = createFactory({ calendars: [
      { url: 'https://calendar.example.com/a', displayName: '工作', components: ['VEVENT'] },
      { url: 'https://calendar.example.com/b', displayName: '私人', components: ['VEVENT'] },
    ] });
    const ambiguousClient = createReadOnlyDingTalkCalDavClient({ factory: ambiguous.factory });
    await expect(ambiguousClient.testConnection({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
    })).rejects.toThrow('主日历');
  });
});
