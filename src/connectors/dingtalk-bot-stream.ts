import { hasControlCharacters } from '../dingtalk-profile.js';

export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get';

export interface DingTalkRobotStreamEnvelope {
  headers: {
    messageId: string;
    topic: string;
  };
  data: string;
}

export interface DingTalkBotStreamPolicy {
  robotCode: string;
  trustedCorpId: string;
  trustedSenderUserId: string;
  trustedConversationId: string;
}

export interface DingTalkReplyEvent {
  eventId: string;
  senderUserId: string;
  conversationId: string;
  message: string;
}

export type ParsedDingTalkRobotMessage = {
  kind: 'accepted';
  transportMessageId: string;
  sessionWebhook: string;
  event: DingTalkReplyEvent;
} | {
  kind: 'ignored';
  transportMessageId: string | null;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9_:+./=-]+$/u.test(value);
}

function safeText(value: unknown): string | null {
  if (!isRecord(value) || typeof value.content !== 'string') return null;
  const text = value.content.trim();
  if (
    text.length === 0
    || text.length > 2_000
    || hasControlCharacters(text)
  ) return null;
  return text;
}

function safeSessionWebhook(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === 'api.dingtalk.com'
      || url.hostname === 'oapi.dingtalk.com';
    const trustedPath = url.pathname.startsWith('/v1.0/robot/')
      || url.pathname.startsWith('/robot/');
    if (
      url.protocol !== 'https:'
      || url.port !== ''
      || url.username !== ''
      || url.password !== ''
      || !trustedHost
      || !trustedPath
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function ignored(
  envelope: DingTalkRobotStreamEnvelope,
  reason: string,
): ParsedDingTalkRobotMessage {
  return {
    kind: 'ignored',
    transportMessageId: boundedIdentifier(envelope.headers?.messageId)
      ? envelope.headers.messageId
      : null,
    reason,
  };
}

export function parseTrustedDingTalkRobotMessage(
  envelope: DingTalkRobotStreamEnvelope,
  policy: DingTalkBotStreamPolicy,
): ParsedDingTalkRobotMessage {
  if (
    envelope.headers?.topic !== DINGTALK_ROBOT_TOPIC
    || !boundedIdentifier(envelope.headers?.messageId)
  ) return ignored(envelope, 'invalid_transport');

  let payload: unknown;
  try {
    payload = JSON.parse(envelope.data) as unknown;
  } catch {
    return ignored(envelope, 'invalid_json');
  }
  if (!isRecord(payload)) return ignored(envelope, 'invalid_payload');
  if (
    payload.robotCode !== policy.robotCode
    || payload.senderCorpId !== policy.trustedCorpId
    || payload.senderStaffId !== policy.trustedSenderUserId
    || payload.conversationId !== policy.trustedConversationId
    || payload.conversationType !== '1'
  ) return ignored(envelope, 'untrusted_source');
  if (
    payload.msgtype !== 'text'
    || !boundedIdentifier(payload.msgId)
    || !boundedIdentifier(payload.senderStaffId)
    || !boundedIdentifier(payload.conversationId)
  ) return ignored(envelope, 'invalid_message');
  const message = safeText(payload.text);
  const sessionWebhook = safeSessionWebhook(payload.sessionWebhook);
  if (message === null || sessionWebhook === null) {
    return ignored(envelope, 'invalid_message');
  }
  return {
    kind: 'accepted',
    transportMessageId: envelope.headers.messageId,
    sessionWebhook,
    event: {
      eventId: payload.msgId,
      senderUserId: payload.senderStaffId,
      conversationId: payload.conversationId,
      message,
    },
  };
}
