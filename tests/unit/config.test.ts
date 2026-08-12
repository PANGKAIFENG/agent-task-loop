import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('keeps acceptance notifications disabled without a DingTalk profile', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
    }).dingtalkProfile).toBeNull();
  });

  it('ignores the removed legacy daily-limit environment variable', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
      ATL_DAILY_LIMIT: 'not-a-limit-anymore',
    })).not.toHaveProperty('dailyLimit');
  });

  it('accepts one explicit DingTalk profile', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
      ATL_DINGTALK_PROFILE: 'synthetic-current-profile',
    }).dingtalkProfile).toBe('synthetic-current-profile');
  });

  it.each([' corp-a', 'corp-a,corp-b', 'corp-a\ncorp-b'])(
    'rejects an ambiguous DingTalk profile: %j',
    (profile) => {
      expect(() => loadConfig({
        ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
        ATL_DINGTALK_PROFILE: profile,
      })).toThrow('ATL_DINGTALK_PROFILE');
    },
  );
});
