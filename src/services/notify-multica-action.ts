import { createHash } from 'node:crypto';

import { hasControlCharacters } from '../dingtalk-profile.js';
import type { MulticaActionNotificationLedger } from '../storage/file-multica-action-notification-ledger.js';
import { multicaEventCommentIdempotencyKey, type MulticaEvent } from '../domain/multica-event.js';

// PAW-GOAL-003 T2 (TECH §6): only needs_decision / blocked /
// release_candidate_ready / failed notify the user's own bot. Ordinary
// progress lives in Multica comments and must never reach DingTalk.
export interface MulticaActionNotificationRecord {
  schemaVersion: 1;
  idempotencyKey: string;
  taskId: string;
  eventId: string;
  state: 'needs_decision' | 'blocked' | 'release_candidate_ready' | 'failed';
  uuid: string;
  status: 'sent' | 'failed' | 'conflict' | 'unknown';
  attemptedAt: string;
  errorCode: string | null;
  messageId: string | null;
  draftTitle: string;
  draftText: string;
}

// Reuses the existing self-bot delivery surface (DwsSelfAcceptanceDelivery).
export interface MulticaActionDelivery {
  send(message: {
    uuid: string;
    title: string;
    text: string;
  }): Promise<{ taskId: string | null; messageId: string | null }>;
}

export interface NotifyMulticaActionContext {
  ledger: MulticaActionNotificationLedger;
  delivery: MulticaActionDelivery;
  clock: () => Date;
}

export class MulticaActionNotNotifiableError extends Error {
  readonly code = 'multica_action_not_notifiable';

  constructor(state: string) {
    super(`Multica event state ${state} does not notify`);
    this.name = 'MulticaActionNotNotifiableError';
  }
}

function stableUuid(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
  ) return error.code;
  return 'multica_notification_failed';
}

function safeLine(value: string, maxLength: number): boolean {
  return value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacters(value)
    && !/\r|\n/u.test(value);
}

const ACTION_LABELS: Record<string, string> = {
  approve: '接受并发布',
  rework: '返工',
  block: '暂停',
  cancel: '取消',
};

function actionLabel(action: string): string {
  return action.startsWith('select:')
    ? `选择 ${action.slice('select:'.length)}`
    : ACTION_LABELS[action] ?? action;
}

function messageFor(input: {
  taskId: string;
  taskTitle: string;
  issueIdentifier: string;
  event: MulticaEvent;
}): { title: string; text: string; allowedActions: string[] } {
  const { event } = input;
  const options = event.decision?.options ?? [];
  const allowedActions = [
    ...(event.state === 'needs_decision'
      ? options.map((option) => `select:${option.id}`)
      : []),
    ...(event.state === 'release_candidate_ready' ? ['approve'] : []),
    ...((event.state === 'blocked' || event.state === 'failed')
      && event.recoverability?.recoverable === true ? ['rework'] : []),
    'block',
    'cancel',
  ];
  const safe = safeLine(input.taskId, 256)
    && safeLine(input.taskTitle, 120)
    && safeLine(input.issueIdentifier, 100)
    && safeLine(event.eventId, 200)
    && event.summary.length <= 2_000;
  if (!safe) {
    const error = new Error('Multica action notification payload rejected') as Error & {
      code: string;
    };
    error.code = 'multica_notification_payload_rejected';
    throw error;
  }
  const lines = [
    `标题：${input.taskTitle}`,
    `任务 ID：${input.taskId}`,
    `Multica Issue：${input.issueIdentifier}`,
    `事件：${event.eventId}（${event.state}）`,
    `摘要：${event.summary.split('\n')[0] ?? ''}`,
    '可用动作：',
    ...allowedActions.map((action) => `- ${actionLabel(action)}（回复 ${action} ${input.taskId}）`),
  ];
  const text = lines.join('\n');
  if (text.length > 12_000) {
    const error = new Error('Multica action notification payload rejected') as Error & {
      code: string;
    };
    error.code = 'multica_notification_payload_rejected';
    throw error;
  }
  return { title: 'ATL 需要你处理', text, allowedActions };
}

export async function notifyMulticaAction(
  context: NotifyMulticaActionContext,
  input: {
    taskId: string;
    taskTitle: string;
    issueIdentifier: string;
    event: MulticaEvent;
  },
): Promise<MulticaActionNotificationRecord> {
  const { event } = input;
  if (
    event.state !== 'needs_decision'
    && event.state !== 'blocked'
    && event.state !== 'release_candidate_ready'
    && event.state !== 'failed'
  ) {
    throw new MulticaActionNotNotifiableError(event.state);
  }
  const key = multicaEventCommentIdempotencyKey({
    taskId: input.taskId,
    eventId: event.eventId,
    state: event.state,
  });
  // Narrowed by the guard above: the record only models notifiable states.
  const notifiableState = event.state as MulticaActionNotificationRecord['state'];

  return context.ledger.withLock(async () => {
    const existing = await context.ledger.get(key);
    // A confirmed send and an ambiguous send are both terminal for automatic
    // delivery. DWS does not accept the stable UUID as an idempotency key, so
    // retrying `unknown` can duplicate a notification that actually arrived.
    // Unknown records resume only through explicit receipt recovery.
    if (existing?.status === 'sent' || existing?.status === 'unknown') return existing;
    const attemptedAt = context.clock().toISOString();
    const base = {
      schemaVersion: 1 as const,
      idempotencyKey: key,
      taskId: input.taskId,
      eventId: event.eventId,
      state: notifiableState,
      uuid: existing?.uuid ?? stableUuid(key),
      attemptedAt,
    };

    let message: { title: string; text: string };
    try {
      message = messageFor(input);
    } catch (error) {
      const failed: MulticaActionNotificationRecord = {
        ...base,
        status: 'failed',
        errorCode: safeErrorCode(error),
        messageId: null,
        draftTitle: 'ATL 需要你处理',
        draftText: 'payload rejected before delivery',
      };
      await context.ledger.save(failed);
      return failed;
    }

    await context.ledger.save({
      ...base,
      status: 'unknown',
      errorCode: 'multica_notification_unknown',
      messageId: null,
      draftTitle: message.title,
      draftText: message.text,
    });

    let delivery: { taskId: string | null; messageId: string | null };
    try {
      delivery = await context.delivery.send({ uuid: base.uuid, ...message });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const deliveryUnknown = errorCode === 'dingtalk_delivery_unknown';
      const failed: MulticaActionNotificationRecord = {
        ...base,
        status: deliveryUnknown ? 'unknown' : 'failed',
        errorCode: deliveryUnknown ? 'multica_notification_unknown' : errorCode,
        messageId: null,
        draftTitle: message.title,
        draftText: message.text,
      };
      await context.ledger.save(failed);
      return failed;
    }

    const deliveryReceiptId = delivery.messageId ?? delivery.taskId;
    if (deliveryReceiptId === null) {
      const unknown: MulticaActionNotificationRecord = {
        ...base,
        status: 'unknown',
        errorCode: 'multica_notification_unknown',
        messageId: null,
        draftTitle: message.title,
        draftText: message.text,
      };
      await context.ledger.save(unknown);
      return unknown;
    }
    const sent: MulticaActionNotificationRecord = {
      ...base,
      status: 'sent',
      errorCode: null,
      messageId: deliveryReceiptId,
      draftTitle: message.title,
      draftText: message.text,
    };
    await context.ledger.save(sent);
    return sent;
  });
}
