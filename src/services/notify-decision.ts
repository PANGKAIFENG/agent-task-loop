import { createHash } from 'node:crypto';

import { hasControlCharacters } from '../dingtalk-profile.js';
import type { Task } from '../domain/task.js';

export interface DecisionNotificationRecord {
  schemaVersion: 1;
  idempotencyKey: string;
  taskId: string;
  decisionRequestId: string;
  uuid: string;
  status: 'sent' | 'failed' | 'conflict' | 'unknown';
  attemptedAt: string;
  errorCode: string | null;
  deliveryTaskId: string | null;
  messageId: string | null;
}

export interface DecisionNotificationLedger {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  get(idempotencyKey: string): Promise<DecisionNotificationRecord | null>;
  save(record: DecisionNotificationRecord): Promise<void>;
  list(): Promise<DecisionNotificationRecord[]>;
}

export interface DecisionDelivery {
  send(message: {
    uuid: string;
    title: string;
    text: string;
  }): Promise<{ taskId: string | null; messageId: string | null }>;
}

export interface NotifyDecisionContext {
  ledger: DecisionNotificationLedger;
  delivery: DecisionDelivery;
  target: { kind: 'self' };
  getTask(taskId: string): Promise<Task | null>;
  clock: () => Date;
}

const UNKNOWN_DELIVERY_ERROR_CODE = 'decision_delivery_unknown';

function idempotencyKey(task: Task): string {
  return `decision:${task.taskId}:${task.pendingDecision?.requestId ?? 'missing'}`;
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
  return 'decision_delivery_failed';
}

function sameDecision(left: Task | null, right: Task): boolean {
  return left !== null
    && left.status === 'waiting_for_decision'
    && right.status === 'waiting_for_decision'
    && left.pendingDecision !== null
    && left.pendingDecision !== undefined
    && right.pendingDecision !== null
    && right.pendingDecision !== undefined
    && left.pendingDecision.requestId === right.pendingDecision.requestId;
}

function safeLine(value: string, maxLength: number): boolean {
  return value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacters(value)
    && !/\r|\n/u.test(value);
}

function messageFor(task: Task): { title: string; text: string } {
  const decision = task.pendingDecision;
  const safe = task.status === 'waiting_for_decision'
    && decision !== null
    && decision !== undefined
    && safeLine(task.taskId, 256)
    && safeLine(task.title, 120)
    && safeLine(decision.requestId, 200)
    && safeLine(decision.question, 4_000)
    && decision.options.length > 0
    && decision.options.length <= 20
    && decision.options.every((option) => (
      safeLine(option.id, 200) && safeLine(option.label, 500)
    ));
  if (!safe || decision === null || decision === undefined) {
    const error = new Error('Decision notification payload rejected') as Error & {
      code: string;
    };
    error.code = 'decision_payload_rejected';
    throw error;
  }
  const options = decision.options.map((option, index) => (
    `${index + 1}. ${option.id}：${option.label}`
  ));
  const text = [
    `标题：${task.title}`,
    `任务 ID：${task.taskId}`,
    `问题：${decision.question}`,
    '选项：',
    ...options,
    `回复示例：1 ${task.taskId}`,
    '也可回复 A/B 或选项 ID；有多个待决策任务时请带任务 ID。',
  ].join('\n');
  if (text.length > 12_000) {
    const error = new Error('Decision notification payload rejected') as Error & {
      code: string;
    };
    error.code = 'decision_payload_rejected';
    throw error;
  }
  return { title: 'ATL 需要你决策', text };
}

export async function notifyDecision(
  context: NotifyDecisionContext,
  task: Task,
): Promise<DecisionNotificationRecord> {
  return context.ledger.withLock(async () => {
    const key = idempotencyKey(task);
    const existing = await context.ledger.get(key);
    if (existing?.status === 'sent' || existing?.status === 'unknown') return existing;
    const attemptedAt = context.clock().toISOString();
    const base = {
      schemaVersion: 1 as const,
      idempotencyKey: key,
      taskId: task.taskId,
      decisionRequestId: task.pendingDecision?.requestId ?? 'missing',
      uuid: existing?.uuid ?? stableUuid(key),
      attemptedAt,
    };

    let current: Task | null;
    try {
      current = await context.getTask(task.taskId);
    } catch {
      current = null;
    }
    if (!sameDecision(current, task)) {
      const conflict: DecisionNotificationRecord = {
        ...base,
        status: 'conflict',
        errorCode: 'decision_location_conflict',
        deliveryTaskId: null,
        messageId: null,
      };
      await context.ledger.save(conflict);
      return conflict;
    }

    let message: { title: string; text: string };
    try {
      message = messageFor(task);
    } catch (error) {
      const failed: DecisionNotificationRecord = {
        ...base,
        status: 'failed',
        errorCode: safeErrorCode(error),
        deliveryTaskId: null,
        messageId: null,
      };
      await context.ledger.save(failed);
      return failed;
    }

    await context.ledger.save({
      ...base,
      status: 'unknown',
      errorCode: UNKNOWN_DELIVERY_ERROR_CODE,
      deliveryTaskId: null,
      messageId: null,
    });

    let delivery: { taskId: string | null; messageId: string | null };
    try {
      delivery = await context.delivery.send({ uuid: base.uuid, ...message });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const deliveryUnknown = errorCode === 'dingtalk_delivery_unknown';
      const failed: DecisionNotificationRecord = {
        ...base,
        status: deliveryUnknown ? 'unknown' : 'failed',
        errorCode: deliveryUnknown ? UNKNOWN_DELIVERY_ERROR_CODE : errorCode,
        deliveryTaskId: null,
        messageId: null,
      };
      await context.ledger.save(failed);
      return failed;
    }

    const sent: DecisionNotificationRecord = {
      ...base,
      status: 'sent',
      errorCode: null,
      deliveryTaskId: delivery.taskId,
      messageId: delivery.messageId,
    };
    await context.ledger.save(sent);
    return sent;
  });
}
