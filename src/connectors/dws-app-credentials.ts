import { hasControlCharacters } from '../dingtalk-profile.js';

interface ExpectedDingTalkApp {
  unifiedAppId: string;
}

export interface DingTalkAppCredentials {
  clientId: string;
  clientSecret: string;
}

class DwsAppCredentialsError extends Error {
  readonly code = 'dingtalk_app_credentials_invalid';

  constructor() {
    super('DingTalk app credentials were unavailable or did not match the configured app');
    this.name = 'DwsAppCredentialsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDwsAppCredentials(
  stdout: string,
  expected: ExpectedDingTalkApp,
): DingTalkAppCredentials {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout) as unknown;
  } catch {
    throw new DwsAppCredentialsError();
  }
  const data = isRecord(envelope) && isRecord(envelope.data)
    ? envelope.data
    : null;
  const appKey = data === null
    ? null
    : typeof data.appKey === 'string' ? data.appKey : data.clientId;
  const appSecret = data === null
    ? null
    : typeof data.appSecret === 'string' ? data.appSecret : data.clientSecret;
  if (
    !isRecord(envelope)
    || envelope.ok !== true
    || envelope.outcome !== 'success'
    || data === null
    || data.unifiedAppId !== expected.unifiedAppId
    || typeof appKey !== 'string'
    || !/^[A-Za-z0-9_-]{4,256}$/u.test(appKey)
    || (typeof data.appKey === 'string'
      && typeof data.clientId === 'string'
      && data.appKey !== data.clientId)
    || typeof appSecret !== 'string'
    || appSecret.length < 8
    || appSecret.length > 512
    || hasControlCharacters(appSecret)
    || (typeof data.appSecret === 'string'
      && typeof data.clientSecret === 'string'
      && data.appSecret !== data.clientSecret)
  ) throw new DwsAppCredentialsError();
  return {
    clientId: appKey,
    clientSecret: appSecret,
  };
}
