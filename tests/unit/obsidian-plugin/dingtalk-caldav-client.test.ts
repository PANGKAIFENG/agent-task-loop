import { createServer } from 'node:http';

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
  it('uses the desktop Node transport instead of the CORS-restricted renderer fetch', async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (request.url === '/dav/redirect') {
          response.writeHead(302, { Location: '/dav/principals/' });
          response.end();
          return;
        }
        response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        response.end('<d:multistatus xmlns:d="DAV:" />');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Test DAV server did not expose a TCP port');
    }

    const rendererFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new TypeError('Failed to fetch'),
    );
    vi.stubGlobal('fetch', rendererFetch);
    const factory: DingTalkCalDavClientFactory = async (input) => {
      const response = await input.fetch?.(
        `http://127.0.0.1:${address.port}/dav/redirect`,
        {
          method: 'PROPFIND',
          headers: { Depth: '0' },
          body: '<d:propfind xmlns:d="DAV:" />',
        },
      );
      expect(response?.status).toBe(207);
      expect(response?.url).toBe(`http://127.0.0.1:${address.port}/dav/principals/`);
      expect(response?.headers.get('content-type')).toContain('application/xml');
      expect(await response?.text()).toContain('multistatus');
      const manual = await input.fetch?.(
        `http://127.0.0.1:${address.port}/dav/redirect`,
        { method: 'PROPFIND', redirect: 'manual' },
      );
      expect(manual?.status).toBe(302);
      expect(manual?.headers.get('location')).toBe('/dav/principals/');
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

    try {
      const client = createReadOnlyDingTalkCalDavClient({ factory });
      await client.testConnection({
        serverUrl: `http://127.0.0.1:${address.port}`,
        username: 'synthetic-user',
        password: 'synthetic-password',
      });

      expect(rendererFetch).not.toHaveBeenCalled();
      expect(requests).toEqual([
        {
          method: 'PROPFIND',
          path: '/dav/redirect',
          body: '<d:propfind xmlns:d="DAV:" />',
        },
        {
          method: 'PROPFIND',
          path: '/dav/principals/',
          body: '<d:propfind xmlns:d="DAV:" />',
        },
        {
          method: 'PROPFIND',
          path: '/dav/redirect',
          body: '',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it('rejects DAV requests and redirects outside the configured origin', async () => {
    let foreignHits = 0;
    const foreignServer = createServer((_request, response) => {
      foreignHits += 1;
      response.writeHead(207, { 'Content-Type': 'application/xml' });
      response.end('<d:multistatus xmlns:d="DAV:" />');
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once('error', reject);
      foreignServer.listen(0, '127.0.0.1', resolve);
    });
    const foreignAddress = foreignServer.address();
    if (foreignAddress === null || typeof foreignAddress === 'string') {
      foreignServer.close();
      throw new Error('Foreign test server did not expose a TCP port');
    }

    const originServer = createServer((_request, response) => {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${foreignAddress.port}/credentials`,
      });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      originServer.once('error', reject);
      originServer.listen(0, '127.0.0.1', resolve);
    });
    const originAddress = originServer.address();
    if (originAddress === null || typeof originAddress === 'string') {
      originServer.close();
      foreignServer.close();
      throw new Error('Origin test server did not expose a TCP port');
    }

    const factory: DingTalkCalDavClientFactory = async (input) => {
      await expect(input.fetch?.(
        `http://127.0.0.1:${foreignAddress.port}/direct`,
        { method: 'PROPFIND' },
      )).rejects.toThrow('origin');
      await expect(input.fetch?.(
        `http://127.0.0.1:${originAddress.port}/redirect`,
        { method: 'PROPFIND' },
      )).rejects.toThrow('origin');
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

    try {
      const client = createReadOnlyDingTalkCalDavClient({ factory });
      await client.testConnection({
        serverUrl: `http://127.0.0.1:${originAddress.port}`,
        username: 'synthetic-user',
        password: 'synthetic-password',
      });
      expect(foreignHits).toBe(0);
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          originServer.close((error) => error === undefined ? resolve() : reject(error));
        }),
        new Promise<void>((resolve, reject) => {
          foreignServer.close((error) => error === undefined ? resolve() : reject(error));
        }),
      ]);
    }
  });

  it('rejects malformed redirect locations instead of leaving the request pending', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, { Location: 'http://[invalid' });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('Test DAV server did not expose a TCP port');
    }

    const factory: DingTalkCalDavClientFactory = async (input) => {
      const request = input.fetch?.(
        `http://127.0.0.1:${address.port}/redirect`,
        { method: 'PROPFIND' },
      );
      await expect(Promise.race([
        request,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('CalDAV transport remained pending')),
          250,
        )),
      ])).rejects.toThrow('Invalid URL');
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

    try {
      const client = createReadOnlyDingTalkCalDavClient({ factory });
      await client.testConnection({
        serverUrl: `http://127.0.0.1:${address.port}`,
        username: 'synthetic-user',
        password: 'synthetic-password',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

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

  it('falls back to a collection read when DingTalk ignores the time-range filter', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: DingTalkCalDavClientFactory = async (input) => ({
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
      fetchCalendarObjects: async (query) => {
        calls.push(query as Record<string, unknown>);
        if ('timeRange' in (query as Record<string, unknown>)) return [] as never;
        return [{
          url: `${input.serverUrl}/primary/event-without-ics-suffix`,
          etag: 'etag-1',
          data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
        }] as never;
      },
    });
    const client = createReadOnlyDingTalkCalDavClient({ factory });
    const result = await client.fetchPrimaryCalendar({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
      windowStart: new Date('2026-07-20T00:00:00Z'),
      windowEnd: new Date('2026-10-18T00:00:00Z'),
    });

    expect(result.objects).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ expand: false });
    expect(calls[0]).toHaveProperty('timeRange');
    expect(calls[1]).not.toHaveProperty('timeRange');
    expect(typeof calls[0]?.urlFilter).toBe('function');
    expect(typeof calls[1]?.urlFilter).toBe('function');
  });

  it('falls back to a collection read when DingTalk rejects the time-range query', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: DingTalkCalDavClientFactory = async (input) => ({
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
      fetchCalendarObjects: async (query) => {
        calls.push(query as Record<string, unknown>);
        if ('timeRange' in (query as Record<string, unknown>)) {
          throw new Error('synthetic time-range rejection');
        }
        return [{
          url: `${input.serverUrl}/primary/event-without-ics-suffix`,
          etag: 'etag-1',
          data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
        }] as never;
      },
    });
    const client = createReadOnlyDingTalkCalDavClient({ factory });

    const result = await client.fetchPrimaryCalendar({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
      windowStart: new Date('2026-07-13T00:00:00Z'),
      windowEnd: new Date('2026-10-19T00:00:00Z'),
    });

    expect(result.objects).toHaveLength(1);
    expect(result.readErrors).toBe(0);
    expect(calls).toHaveLength(10);
    expect(calls.slice(0, -1).every((call) => 'timeRange' in call)).toBe(true);
    expect(calls.at(-1)).not.toHaveProperty('timeRange');
  });

  it('splits a long sync window into bounded DingTalk time-range queries', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: DingTalkCalDavClientFactory = async (input) => ({
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
      fetchCalendarObjects: async (query) => {
        calls.push(query as Record<string, unknown>);
        return [{
          url: `${input.serverUrl}/primary/event-${calls.length}`,
          etag: `etag-${calls.length}`,
          data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
        }] as never;
      },
    });
    const client = createReadOnlyDingTalkCalDavClient({ factory });

    const result = await client.fetchPrimaryCalendar({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
      windowStart: new Date('2026-07-14T00:00:00Z'),
      windowEnd: new Date('2026-10-20T00:00:00Z'),
    });

    expect(result.objects).toHaveLength(9);
    expect(result.readErrors).toBe(0);
    expect(calls).toHaveLength(9);
    expect(calls[0]).toHaveProperty('timeRange', {
      start: '2026-07-14T00:00:00.000Z',
      end: '2026-07-15T00:00:00.000Z',
    });
    expect(calls[8]).toHaveProperty('timeRange', {
      start: '2026-07-22T00:00:00.000Z',
      end: '2026-10-20T00:00:00.000Z',
    });
  });

  it('returns successful ranges while counting failed historical ranges', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const factory: DingTalkCalDavClientFactory = async (input) => ({
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
      fetchCalendarObjects: async (query) => {
        calls.push(query as Record<string, unknown>);
        if (calls.length === 1) throw new Error('synthetic historical failure');
        return [{
          url: `${input.serverUrl}/primary/event-${calls.length}`,
          etag: `etag-${calls.length}`,
          data: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
        }] as never;
      },
    });
    const client = createReadOnlyDingTalkCalDavClient({ factory });

    const result = await client.fetchPrimaryCalendar({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
      windowStart: new Date('2026-07-14T00:00:00Z'),
      windowEnd: new Date('2026-10-14T00:00:00Z'),
    });

    expect(result.objects).toHaveLength(2);
    expect(result.readErrors).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => 'timeRange' in call)).toBe(true);
  });

  it('uses Basic credentials and rejects any write method at the transport boundary', async () => {
    const fetchCalls: Array<{ method: string; headers: HeadersInit | undefined }> = [];
    const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, {
      status: 204,
    }));
    const factory: DingTalkCalDavClientFactory = async (input) => {
      const fetch = input.fetch;
      expect(fetch).toBeDefined();
      await expect(fetch?.('https://calendar.example.com', { method: 'PUT' })).rejects.toThrow(
        'read-only',
      );
      await expect(fetch?.(new Request('https://calendar.example.com', {
        method: 'PUT',
      }))).rejects.toThrow('read-only');
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
    const client = createReadOnlyDingTalkCalDavClient({ factory, fetch: transport });
    await client.testConnection({
      serverUrl: 'https://calendar.example.com/caldav',
      username: 'user@example.com',
      password: 'synthetic-password',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('user@example.com:synthetic-password').toString('base64')}`,
    });
    expect(transport).not.toHaveBeenCalled();
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
