import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';

import {
  createDAVClient,
  type DAVAccount,
  type DAVCalendar,
  type DAVCalendarObject,
} from 'tsdav';

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

export type DingTalkCalDavClientFactory = (
  input: Parameters<typeof createDAVClient>[0],
) => Promise<Pick<DavClient, 'createAccount' | 'fetchCalendars' | 'fetchCalendarObjects'>>;

export interface DingTalkCalDavConnection {
  serverUrl: string;
  username: string;
  password: string;
}

export interface DingTalkCalendarQuery extends DingTalkCalDavConnection {
  windowStart: Date;
  windowEnd: Date;
}

export interface DingTalkConnectionSummary {
  username: string;
  calendarName: string;
  availableCalendarNames: string[];
}

export interface DingTalkFetchedCalendar {
  calendar: {
    id: 'primary';
    displayName: string;
    url: string;
  };
  objects: ReadonlyArray<{
    href: string;
    etag: string | null;
    data: string;
  }>;
  syncToken: string | null;
}

export interface ReadOnlyDingTalkCalDavClient {
  testConnection(input: DingTalkCalDavConnection): Promise<DingTalkConnectionSummary>;
  fetchPrimaryCalendar(input: DingTalkCalendarQuery): Promise<DingTalkFetchedCalendar>;
}

const READ_ONLY_METHODS = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'PROPFIND',
  'REPORT',
]);

function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '[::1]'
    || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
}

function normalizedConnection(input: DingTalkCalDavConnection): DingTalkCalDavConnection {
  const serverUrl = input.serverUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('钉钉 CalDAV 地址无效');
  }
  if (
    (parsed.protocol !== 'https:' && !(
      parsed.protocol === 'http:' && loopbackHostname(parsed.hostname)
    ))
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('钉钉 CalDAV 必须使用 HTTPS');
  }
  const username = input.username.trim();
  if (username === '' || input.password === '') {
    throw new Error('钉钉 CalDAV 账号和密码不能为空');
  }
  return {
    serverUrl: parsed.toString().replace(/\/$/u, ''),
    username,
    password: input.password,
  };
}

function readOnlyFetch(fetchImplementation: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!READ_ONLY_METHODS.has(method)) {
      throw new Error(`DingTalk CalDAV transport is read-only; rejected ${method}`);
    }
    return fetchImplementation(input, init);
  };
}

function displayName(calendar: DAVCalendar): string {
  return typeof calendar.displayName === 'string'
    ? calendar.displayName.trim()
    : '';
}

function supportsEvents(calendar: DAVCalendar): boolean {
  return calendar.components === undefined
    || calendar.components.length === 0
    || calendar.components.includes('VEVENT');
}

function primaryScore(calendar: DAVCalendar): number {
  const name = displayName(calendar);
  if (/^(?:主日历|默认日历|钉钉日历|我的日历|primary|default)$/iu.test(name)) return 2;
  if (/(?:主日历|默认|primary|default)/iu.test(name)) return 1;
  if (/(?:^|\/)primary\/?$/iu.test(calendar.url)) return 1;
  return 0;
}

function selectPrimaryCalendar(calendars: readonly DAVCalendar[]): DAVCalendar {
  const candidates = calendars.filter(supportsEvents);
  if (candidates.length === 1) return candidates[0]!;
  const scored = candidates
    .map((calendar) => ({ calendar, score: primaryScore(calendar) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (scored.length > 0 && scored[0]?.score !== scored[1]?.score) {
    return scored[0]!.calendar;
  }
  if (candidates.length === 0) {
    throw new Error('钉钉账号没有可读取的主日历');
  }
  throw new Error('检测到多个日历，无法唯一确认钉钉主日历');
}

function normalizeObjects(objects: readonly DAVCalendarObject[]): DingTalkFetchedCalendar['objects'] {
  return objects.flatMap((object) => (
    typeof object.data === 'string'
      ? [{
          href: object.url,
          etag: typeof object.etag === 'string' ? object.etag : null,
          data: object.data,
        }]
      : []
  ));
}

export function createReadOnlyDingTalkCalDavClient(dependencies: {
  factory?: DingTalkCalDavClientFactory;
  fetch?: typeof globalThis.fetch;
} = {}): ReadOnlyDingTalkCalDavClient {
  const factory = dependencies.factory ?? createDAVClient;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;

  async function connect(input: DingTalkCalDavConnection): Promise<{
    client: Awaited<ReturnType<DingTalkCalDavClientFactory>>;
    account: DAVAccount;
    calendars: DAVCalendar[];
    primary: DAVCalendar;
    connection: DingTalkCalDavConnection;
  }> {
    const connection = normalizedConnection(input);
    const authorization = `Basic ${Buffer.from(
      `${connection.username}:${connection.password}`,
      'utf8',
    ).toString('base64')}`;
    const client = await factory({
      serverUrl: connection.serverUrl,
      credentials: {
        username: connection.username,
        password: connection.password,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: readOnlyFetch(fetchImplementation),
      fetchOptions: {
        headers: { Authorization: authorization },
      },
    });
    const account = await client.createAccount({
      account: { accountType: 'caldav' },
      loadCollections: false,
      loadObjects: false,
    });
    const calendars = await client.fetchCalendars({ account });
    return {
      client,
      account,
      calendars,
      primary: selectPrimaryCalendar(calendars),
      connection,
    };
  }

  return {
    async testConnection(input) {
      const { calendars, primary, connection } = await connect(input);
      return {
        username: connection.username,
        calendarName: displayName(primary) || '主日历',
        availableCalendarNames: calendars
          .filter(supportsEvents)
          .map((calendar) => displayName(calendar) || calendar.url),
      };
    },
    async fetchPrimaryCalendar(input) {
      if (
        !Number.isFinite(input.windowStart.getTime())
        || !Number.isFinite(input.windowEnd.getTime())
        || input.windowStart >= input.windowEnd
      ) {
        throw new Error('钉钉日历同步时间范围无效');
      }
      const { client, primary } = await connect(input);
      const objects = await client.fetchCalendarObjects({
        calendar: primary,
        timeRange: {
          start: input.windowStart.toISOString(),
          end: input.windowEnd.toISOString(),
        },
        expand: false,
      });
      return {
        calendar: {
          id: 'primary',
          displayName: displayName(primary) || '主日历',
          url: primary.url,
        },
        objects: normalizeObjects(objects),
        syncToken: typeof primary.syncToken === 'string' ? primary.syncToken : null,
      };
    },
  };
}
