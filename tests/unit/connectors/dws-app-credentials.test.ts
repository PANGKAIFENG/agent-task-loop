import { describe, expect, it } from 'vitest';

import { parseDwsAppCredentials } from '../../../src/connectors/dws-app-credentials.js';

describe('parseDwsAppCredentials', () => {
  it('accepts the bounded DWS credential envelope for the configured app', () => {
    expect(parseDwsAppCredentials(JSON.stringify({
      ok: true,
      outcome: 'success',
      data: {
        appKey: 'ding-synthetic-app-key',
        appSecret: 'synthetic-secret-that-is-never-logged',
        name: 'ATL task assistant',
        unifiedAppId: '11111111-2222-4333-8444-555555555555',
      },
    }), {
      unifiedAppId: '11111111-2222-4333-8444-555555555555',
    })).toEqual({
      clientId: 'ding-synthetic-app-key',
      clientSecret: 'synthetic-secret-that-is-never-logged',
    });
  });

  it('rejects credentials for a different app without exposing the secret', () => {
    expect(() => parseDwsAppCredentials(JSON.stringify({
      ok: true,
      outcome: 'success',
      data: {
        appKey: 'ding-other-bot',
        appSecret: 'SECRET_SENTINEL',
        unifiedAppId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    }), {
      unifiedAppId: '11111111-2222-4333-8444-555555555555',
    })).toThrowError(expect.objectContaining({
      message: expect.not.stringContaining('SECRET_SENTINEL'),
    }));
  });

  it('accepts the documented clientId and clientSecret aliases', () => {
    expect(parseDwsAppCredentials(JSON.stringify({
      ok: true,
      outcome: 'success',
      data: {
        clientId: 'ding-synthetic-client-id',
        clientSecret: 'synthetic-client-secret',
        unifiedAppId: '11111111-2222-4333-8444-555555555555',
      },
    }), {
      unifiedAppId: '11111111-2222-4333-8444-555555555555',
    })).toEqual({
      clientId: 'ding-synthetic-client-id',
      clientSecret: 'synthetic-client-secret',
    });
  });

  it('rejects inconsistent credential aliases', () => {
    expect(() => parseDwsAppCredentials(JSON.stringify({
      ok: true,
      outcome: 'success',
      data: {
        appKey: 'ding-synthetic-app-key',
        clientId: 'ding-different-client-id',
        appSecret: 'synthetic-app-secret',
        clientSecret: 'synthetic-different-secret',
        unifiedAppId: '11111111-2222-4333-8444-555555555555',
      },
    }), {
      unifiedAppId: '11111111-2222-4333-8444-555555555555',
    })).toThrow('DingTalk app credentials were unavailable');
  });
});
