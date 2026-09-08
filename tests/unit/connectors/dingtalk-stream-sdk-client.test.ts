import { describe, expect, it, vi } from 'vitest';

import {
  DingTalkStreamSdkClientAdapter,
  type DingTalkStreamSdkClient,
} from '../../../src/connectors/dingtalk-stream-sdk-client.js';

function clientFixture() {
  let listener: ((message: {
    headers: {
      messageId: string;
      topic: string;
      appId: string;
      connectionId: string;
      contentType: string;
      time: string;
    };
    data: string;
    specVersion: string;
    type: string;
  }) => void) | undefined;
  const client: DingTalkStreamSdkClient = {
    registerCallbackListener(_topic, callback) {
      listener = callback;
    },
    async connect() {},
    disconnect() {},
    async getAccessToken() { return 'synthetic-access-token'; },
    socketCallBackResponse() {},
  };
  return {
    client,
    dispatch(message: { headers: { messageId: string; topic: string }; data: string }) {
      listener?.({
        headers: {
          ...message.headers,
          appId: 'synthetic-app',
          connectionId: 'synthetic-connection',
          contentType: 'application/json',
          time: '2026-08-14T00:00:00.000Z',
        },
        data: message.data,
        specVersion: '1.0',
        type: 'CALLBACK',
      });
    },
  };
}

describe('DingTalkStreamSdkClientAdapter', () => {
  it('converts the SDK envelope and reports rejected asynchronous callbacks', async () => {
    const fixture = clientFixture();
    const report = vi.fn();
    const adapter = new DingTalkStreamSdkClientAdapter(fixture.client, report);
    adapter.registerCallbackListener('/v1.0/im/bot/messages/get', async () => {
      throw new Error('synthetic rejection');
    });

    fixture.dispatch({
      headers: {
        messageId: 'transport-message-001',
        topic: '/v1.0/im/bot/messages/get',
      },
      data: '{"synthetic":true}',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(report).toHaveBeenCalledWith('dingtalk_stream_callback_failed');
  });

  it('rejects malformed access tokens without exposing their value', async () => {
    const fixture = clientFixture();
    const client: DingTalkStreamSdkClient = {
      ...fixture.client,
      async getAccessToken() { return 'bad\naccess-token'; },
    };
    const adapter = new DingTalkStreamSdkClientAdapter(client, vi.fn());
    await expect(adapter.getAccessToken()).rejects.toThrow('DingTalk access token was unavailable');
  });
});
