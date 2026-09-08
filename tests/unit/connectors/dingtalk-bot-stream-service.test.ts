import { describe, expect, it, vi } from 'vitest';

import {
  DingTalkBotStreamService,
  FetchDingTalkSessionReplySender,
  type DingTalkRobotStreamClient,
  type DingTalkSessionReplySender,
} from '../../../src/connectors/dingtalk-bot-stream-service.js';
import type { DingTalkRobotStreamEnvelope } from '../../../src/connectors/dingtalk-bot-stream.js';

const policy = {
  robotCode: 'ding-synthetic-atl-bot',
  trustedCorpId: 'ding-synthetic-corp',
  trustedSenderUserId: 'synthetic-user-001',
  trustedConversationId: 'cid-synthetic-direct-chat',
};

function envelope(
  overrides: Record<string, unknown> = {},
  transportMessageId = 'transport-message-001',
): DingTalkRobotStreamEnvelope {
  return {
    headers: {
      messageId: transportMessageId,
      topic: '/v1.0/im/bot/messages/get',
    },
    data: JSON.stringify({
      conversationId: 'cid-synthetic-direct-chat',
      conversationType: '1',
      msgId: 'robot-message-001',
      senderStaffId: 'synthetic-user-001',
      senderCorpId: 'ding-synthetic-corp',
      robotCode: 'ding-synthetic-atl-bot',
      msgtype: 'text',
      text: { content: '接受 task-synthetic-001 v1' },
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      ...overrides,
    }),
  };
}

function clientFixture() {
  const acknowledgements: Array<{ messageId: string; result: unknown }> = [];
  let callback: ((message: DingTalkRobotStreamEnvelope) => Promise<void>) | undefined;
  const client: DingTalkRobotStreamClient = {
    registerCallbackListener(_topic, listener) {
      callback = listener;
      return this;
    },
    async connect() {},
    disconnect() {},
    async getAccessToken() { return 'synthetic-access-token'; },
    socketCallBackResponse(messageId, result) {
      acknowledgements.push({ messageId, result });
    },
  };
  return {
    client,
    acknowledgements,
    dispatch: async (message: DingTalkRobotStreamEnvelope) => {
      if (callback === undefined) throw new Error('Listener was not registered');
      await callback(message);
    },
  };
}

describe('DingTalkBotStreamService', () => {
  it('runs the ATL bridge, replies through the bot session, and acknowledges once', async () => {
    const fixture = clientFixture();
    const runBridge = vi.fn(async () => 'Artifact 已验收。');
    const sendReply = vi.fn(async () => ({ processQueryKey: 'synthetic-query' }));
    const replySender: DingTalkSessionReplySender = { send: sendReply };
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge,
      replySender,
    });

    await service.start();
    await fixture.dispatch(envelope());

    expect(runBridge).toHaveBeenCalledWith({
      eventId: 'robot-message-001',
      senderUserId: 'synthetic-user-001',
      conversationId: 'cid-synthetic-direct-chat',
      message: '接受 task-synthetic-001 v1',
    });
    expect(sendReply).toHaveBeenCalledWith({
      accessToken: 'synthetic-access-token',
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      text: 'Artifact 已验收。',
    });
    expect(fixture.acknowledgements).toEqual([{
      messageId: 'transport-message-001',
      result: { processQueryKey: 'synthetic-query' },
    }]);
  });

  it('acknowledges an untrusted callback without running or replying', async () => {
    const fixture = clientFixture();
    const runBridge = vi.fn(async () => 'should not run');
    const sendReply = vi.fn(async () => ({}));
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge,
      replySender: { send: sendReply },
    });

    await service.start();
    await fixture.dispatch(envelope({ senderStaffId: 'untrusted-user' }));

    expect(runBridge).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
    expect(fixture.acknowledgements).toEqual([{
      messageId: 'transport-message-001',
      result: { ignored: true },
    }]);
  });

  it('returns a generic bot-visible failure without leaking bridge details', async () => {
    const fixture = clientFixture();
    const runBridge = vi.fn(async () => {
      throw new Error('SECRET_SENTINEL internal bridge details');
    });
    const sendReply = vi.fn(async () => ({ delivered: true }));
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge,
      replySender: { send: sendReply },
    });

    await service.start();
    await fixture.dispatch(envelope());

    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({
      text: 'ATL 暂时无法处理这条回复，请稍后重试。',
    }));
    expect(JSON.stringify(sendReply.mock.calls)).not.toContain('SECRET_SENTINEL');
    expect(fixture.acknowledgements).toHaveLength(1);
  });

  it('does not acknowledge when the bot reply cannot be delivered', async () => {
    const fixture = clientFixture();
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge: async () => 'handled',
      replySender: {
        async send() { throw new Error('network unavailable'); },
      },
    });

    await service.start();
    await expect(fixture.dispatch(envelope())).rejects.toThrow('DingTalk reply delivery failed');
    expect(fixture.acknowledgements).toEqual([]);
  });

  it('coalesces concurrent retries for the same robot message', async () => {
    const fixture = clientFixture();
    const bridge = Promise.withResolvers<string>();
    const runBridge = vi.fn(() => bridge.promise);
    const sendReply = vi.fn(async () => ({ processQueryKey: 'synthetic-query' }));
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge,
      replySender: { send: sendReply },
    });

    await service.start();
    const first = fixture.dispatch(envelope());
    const retry = fixture.dispatch(envelope({}, 'transport-message-002'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(runBridge).toHaveBeenCalledOnce();
    bridge.resolve('Artifact 已验收。');
    await Promise.all([first, retry]);
    expect(sendReply).toHaveBeenCalledOnce();
    expect(fixture.acknowledgements).toHaveLength(2);
    expect(fixture.acknowledgements.map(({ messageId }) => messageId)).toEqual([
      'transport-message-001',
      'transport-message-002',
    ]);
  });

  it('allows a failed delivery to be retried by a later Stream callback', async () => {
    const fixture = clientFixture();
    const runBridge = vi.fn(async () => 'handled');
    const sendReply = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({ delivered: true });
    const service = new DingTalkBotStreamService({
      client: fixture.client,
      policy,
      runBridge,
      replySender: { send: sendReply },
    });

    await service.start();
    await expect(fixture.dispatch(envelope())).rejects.toThrow(
      'DingTalk reply delivery failed',
    );
    await fixture.dispatch(envelope({}, 'transport-message-002'));

    expect(runBridge).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(fixture.acknowledgements).toEqual([{
      messageId: 'transport-message-002',
      result: { delivered: true },
    }]);
  });
});

describe('FetchDingTalkSessionReplySender', () => {
  it('rejects an HTTP 200 DingTalk business failure', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      errcode: 40035,
      errmsg: 'invalid parameter',
    }), { status: 200 }));
    const sender = new FetchDingTalkSessionReplySender(fetcher as typeof fetch);

    await expect(sender.send({
      accessToken: 'synthetic-access-token',
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      text: 'Artifact 已验收。',
    })).rejects.toThrow('DingTalk reply delivery failed');
  });

  it('returns one bounded successful DingTalk response', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      processQueryKey: 'synthetic-query',
    }), { status: 200 }));
    const sender = new FetchDingTalkSessionReplySender(fetcher as typeof fetch);

    await expect(sender.send({
      accessToken: 'synthetic-access-token',
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      text: 'Artifact 已验收。',
    })).resolves.toEqual({ processQueryKey: 'synthetic-query' });
  });
});
