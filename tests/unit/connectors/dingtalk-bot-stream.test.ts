import { describe, expect, it } from 'vitest';

import {
  parseTrustedDingTalkRobotMessage,
  type DingTalkRobotStreamEnvelope,
} from '../../../src/connectors/dingtalk-bot-stream.js';

const policy = {
  robotCode: 'ding-synthetic-atl-bot',
  trustedCorpId: 'ding-synthetic-corp',
  trustedSenderUserId: 'synthetic-user-001',
  trustedConversationId: 'cid-synthetic-direct-chat',
};

function envelope(overrides: Record<string, unknown> = {}): DingTalkRobotStreamEnvelope {
  return {
    headers: {
      messageId: 'transport-message-001',
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
      text: { content: ' 接受 task-synthetic-001 v1 ' },
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      ...overrides,
    }),
  };
}

describe('parseTrustedDingTalkRobotMessage', () => {
  it('projects one trusted direct text callback into an ATL reply event', () => {
    expect(parseTrustedDingTalkRobotMessage(envelope(), policy)).toEqual({
      kind: 'accepted',
      transportMessageId: 'transport-message-001',
      sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      event: {
        eventId: 'robot-message-001',
        senderUserId: 'synthetic-user-001',
        conversationId: 'cid-synthetic-direct-chat',
        message: '接受 task-synthetic-001 v1',
      },
    });
  });

  it.each([
    ['sender', { senderStaffId: 'other-user' }],
    ['conversation', { conversationId: 'cid-other-chat' }],
    ['corporation', { senderCorpId: 'ding-other-corp' }],
    ['robot', { robotCode: 'ding-other-bot' }],
    ['group chat', { conversationType: '2' }],
  ])('ignores an untrusted %s without projecting a reply', (_name, overrides) => {
    expect(parseTrustedDingTalkRobotMessage(envelope(overrides), policy)).toMatchObject({
      kind: 'ignored',
      transportMessageId: 'transport-message-001',
    });
  });

  it.each([
    ['missing event id', { msgId: '' }],
    ['unsupported message type', { msgtype: 'picture', text: undefined }],
    ['control characters', { text: { content: '接受\u0000task' } }],
    ['oversized text', { text: { content: 'x'.repeat(2_001) } }],
    ['foreign webhook host', { sessionWebhook: 'https://example.com/callback' }],
  ])('ignores invalid input: %s', (_name, overrides) => {
    expect(parseTrustedDingTalkRobotMessage(envelope(overrides), policy)).toMatchObject({
      kind: 'ignored',
    });
  });
});
