import { describe, expect, it } from 'vitest';

import {
  dwsCredentialArguments,
  loadDingTalkBotStreamConfig,
} from '../../../src/connectors/dingtalk-bot-stream-config.js';

function environment(): NodeJS.ProcessEnv {
  return {
    ATL_DINGTALK_PROFILE: 'ding-synthetic-corp:synthetic-user-001',
    ATL_DINGTALK_UNIFIED_APP_ID: '11111111-2222-4333-8444-555555555555',
    ATL_DINGTALK_ROBOT_CODE: 'ding-synthetic-atl-bot',
    ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'cid-synthetic-direct-chat',
    ATL_DINGTALK_BRIDGE_ENTRY: '/private/atl-dingtalk-bridge.mjs',
    ATL_DWS_EXECUTABLE: '/private/bin/dws',
    ATL_NODE_EXECUTABLE: '/private/bin/node',
  };
}

describe('loadDingTalkBotStreamConfig', () => {
  it('derives the trusted corporation and sender from one fixed DWS profile', () => {
    expect(loadDingTalkBotStreamConfig(environment())).toEqual({
      profile: 'ding-synthetic-corp:synthetic-user-001',
      unifiedAppId: '11111111-2222-4333-8444-555555555555',
      robotCode: 'ding-synthetic-atl-bot',
      policy: {
        robotCode: 'ding-synthetic-atl-bot',
        trustedCorpId: 'ding-synthetic-corp',
        trustedSenderUserId: 'synthetic-user-001',
        trustedConversationId: 'cid-synthetic-direct-chat',
      },
      bridgeEntry: '/private/atl-dingtalk-bridge.mjs',
      dwsExecutable: '/private/bin/dws',
      nodeExecutable: '/private/bin/node',
    });
  });

  it.each([
    ['ATL_DINGTALK_PROFILE', 'two,profiles'],
    ['ATL_DINGTALK_UNIFIED_APP_ID', 'not-an-app-id'],
    ['ATL_DINGTALK_ROBOT_CODE', 'bad code'],
    ['ATL_DINGTALK_TRUSTED_CONVERSATION_ID', ''],
    ['ATL_DINGTALK_BRIDGE_ENTRY', 'relative/bridge.mjs'],
    ['ATL_DWS_EXECUTABLE', 'dws'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadDingTalkBotStreamConfig({
      ...environment(),
      [key]: value,
    })).toThrow(key);
  });

  it('builds a secret-free DWS credential lookup command', () => {
    const config = loadDingTalkBotStreamConfig(environment());
    const args = dwsCredentialArguments(config);
    expect(args).toEqual([
      '--profile', 'ding-synthetic-corp:synthetic-user-001',
      '--format', 'json',
      'dev', 'app', 'credentials', 'get',
      '--unified-app-id', '11111111-2222-4333-8444-555555555555',
    ]);
    expect(args.join(' ')).not.toMatch(/secret/iu);
  });
});
