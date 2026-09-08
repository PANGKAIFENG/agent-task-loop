import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('keeps acceptance notifications disabled without a DingTalk profile', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
    }).dingtalkProfile).toBeNull();
  });

  it('defaults Multica dispatch to the governed PAW squad', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
    }).multicaDispatch.squadId).toBe('acc15624-c025-4fa8-bc61-e74a1a7725c9');
  });

  it('rejects a malformed Multica squad id', () => {
    expect(() => loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
      ATL_MULTICA_SQUAD_ID: 'not-a-squad',
    })).toThrow('ATL_MULTICA_SQUAD_ID');
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

  it('accepts one explicit DingTalk robot code', () => {
    expect(loadConfig({
      ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
      ATL_DINGTALK_ROBOT_CODE: 'ding-synthetic-atl-bot',
    }).dingtalkRobotCode).toBe('ding-synthetic-atl-bot');
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

  it.each(['bad code', 'abc', 'ding\nrobot'])(
    'rejects an invalid DingTalk robot code: %j',
    (robotCode) => {
      expect(() => loadConfig({
        ATL_VAULT_ROOT: '/tmp/synthetic-atl-vault',
        ATL_DINGTALK_ROBOT_CODE: robotCode,
      })).toThrow('ATL_DINGTALK_ROBOT_CODE');
    },
  );
});
