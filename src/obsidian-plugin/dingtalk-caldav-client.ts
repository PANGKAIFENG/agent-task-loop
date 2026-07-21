import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

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

function assertAllowedOrigin(url: URL, allowedOrigin: string): void {
  if (url.origin !== allowedOrigin) {
    throw new Error('DingTalk CalDAV transport rejected cross-origin request');
  }
}

function readOnlyFetch(
  fetchImplementation: typeof globalThis.fetch,
  allowedOrigin: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    if (!READ_ONLY_METHODS.has(method)) {
      throw new Error(`DingTalk CalDAV transport is read-only; rejected ${method}`);
    }
    assertAllowedOrigin(new URL(request.url), allowedOrigin);
    return fetchImplementation(request);
  };
}

function toResponseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, String(value));
    }
  }
  return result;
}

function redirectedMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

async function sendNodeDavRequest(
  request: Request,
  allowedOrigin: string,
  redirectCount: number,
): Promise<Response> {
  const url = new URL(request.url);
  assertAllowedOrigin(url, allowedOrigin);
  const body = request.body === null
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  if (body !== undefined && !request.headers.has('content-length')) {
    headers['content-length'] = String(body.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = send(url, {
      method: request.method,
      headers,
      signal: request.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.once('error', reject);
      incoming.once('end', () => {
        try {
          const status = incoming.statusCode ?? 500;
          const responseHeaders = toResponseHeaders(incoming.headers);
          const location = responseHeaders.get('location');
          if (REDIRECT_STATUSES.has(status) && location !== null) {
            if (request.redirect === 'error') {
              reject(new TypeError('DingTalk CalDAV transport rejected redirect'));
              return;
            }
            if (request.redirect === 'follow') {
              if (redirectCount >= MAX_REDIRECTS) {
                reject(new TypeError('DingTalk CalDAV transport exceeded redirect limit'));
                return;
              }
              const redirectUrl = new URL(location, request.url);
              assertAllowedOrigin(redirectUrl, allowedOrigin);
              const method = redirectedMethod(status, request.method);
              const redirectHeaders = new Headers(request.headers);
              const dropsBody = method === 'GET' || method === 'HEAD';
              if (dropsBody) {
                redirectHeaders.delete('content-length');
                redirectHeaders.delete('content-type');
              }
              const redirectInit: RequestInit = {
                method,
                headers: redirectHeaders,
                redirect: request.redirect,
                signal: request.signal,
              };
              if (!dropsBody && body !== undefined) redirectInit.body = body;
              resolve(sendNodeDavRequest(
                new Request(redirectUrl, redirectInit),
                allowedOrigin,
                redirectCount + 1,
              ));
              return;
            }
          }
          const hasNoBody = request.method === 'HEAD'
            || status === 204
            || status === 205
            || status === 304;
          const response = new Response(hasNoBody ? null : Buffer.concat(chunks), {
            status,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          });
          Object.defineProperty(response, 'url', { value: request.url });
          Object.defineProperty(response, 'redirected', { value: redirectCount > 0 });
          resolve(response);
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

function createNodeDavFetch(allowedOrigin: string): typeof globalThis.fetch {
  return async (input, init) => sendNodeDavRequest(
    new Request(input, init),
    allowedOrigin,
    0,
  );
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

  async function connect(input: DingTalkCalDavConnection): Promise<{
    client: Awaited<ReturnType<DingTalkCalDavClientFactory>>;
    account: DAVAccount;
    calendars: DAVCalendar[];
    primary: DAVCalendar;
    connection: DingTalkCalDavConnection;
  }> {
    const connection = normalizedConnection(input);
    const allowedOrigin = new URL(connection.serverUrl).origin;
    const fetchImplementation = dependencies.fetch ?? createNodeDavFetch(allowedOrigin);
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
      fetch: readOnlyFetch(fetchImplementation, allowedOrigin),
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

  async function fetchObjectsWithCompatibility(
    client: Awaited<ReturnType<DingTalkCalDavClientFactory>>,
    primary: DAVCalendar,
    input: DingTalkCalendarQuery,
  ): Promise<DAVCalendarObject[]> {
    const query = {
      calendar: primary,
      timeRange: {
        start: input.windowStart.toISOString(),
        end: input.windowEnd.toISOString(),
      },
      expand: false,
      // DingTalk may expose event resources without an .ics suffix.
      urlFilter: () => true,
    };
    const ranged = await client.fetchCalendarObjects(query);
    if (ranged.length > 0) return ranged;

    // Some DingTalk CalDAV deployments accept the REPORT but ignore its
    // VEVENT time-range filter. Fetch the collection once and let the local
    // parser apply the same bounded window before writing anything.
    return client.fetchCalendarObjects({
      calendar: primary,
      expand: false,
      urlFilter: () => true,
    });
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
      const objects = await fetchObjectsWithCompatibility(client, primary, input);
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
