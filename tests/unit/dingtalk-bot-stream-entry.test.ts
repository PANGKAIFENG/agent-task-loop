import { describe, expect, it, vi } from 'vitest';

import { startDingTalkBotStream } from '../../src/dingtalk-bot-stream-entry.js';
import type { DingTalkRobotStreamClient } from '../../src/connectors/dingtalk-bot-stream-service.js';
import type { DingTalkBotStreamConfig } from '../../src/connectors/dingtalk-bot-stream-config.js';

const config: DingTalkBotStreamConfig = {
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
  nodeExecutable: process.execPath,
};

describe('startDingTalkBotStream', () => {
  it('loads credentials once, starts the client, and keeps stop explicit', async () => {
    const connect = vi.fn(async () => {});
    const disconnect = vi.fn();
    const client: DingTalkRobotStreamClient = {
      registerCallbackListener() { return this; },
      connect,
      disconnect,
      async getAccessToken() { return 'synthetic-access-token'; },
      socketCallBackResponse() {},
    };
    const loadCredentials = vi.fn(async () => ({
      clientId: 'ding-synthetic-atl-bot',
      clientSecret: 'synthetic-secret',
    }));
    const createClient = vi.fn(() => client);
    const report = vi.fn();

    const runtime = await startDingTalkBotStream({
      loadConfig: () => config,
      loadCredentials,
      createClient,
      report,
    });

    expect(loadCredentials).toHaveBeenCalledWith(config);
    expect(createClient).toHaveBeenCalledWith({
      clientId: 'ding-synthetic-atl-bot',
      clientSecret: 'synthetic-secret',
    }, report);
    expect(connect).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('dingtalk_stream_started');
    runtime.stop();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
