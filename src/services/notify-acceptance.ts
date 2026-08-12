import { createHash } from 'node:crypto';

import { hasControlCharacters } from '../dingtalk-profile.js';
import type {
  AcceptanceObject,
  AcceptanceObjectState,
} from '../domain/acceptance-object.js';

export const ACCEPTANCE_NAVIGATION = 'Obsidian -> ATL：工作沉淀 -> 待验收';

export interface AcceptanceNotificationRecord {
  schemaVersion: 1;
  idempotencyKey: string;
  objectType: AcceptanceObject['objectType'];
  objectId: string;
  version: number;
  uuid: string;
  status: 'sent' | 'failed' | 'conflict';
  attemptedAt: string;
  errorCode: string | null;
  taskId: string | null;
  messageId: string | null;
}

export interface AcceptanceNotificationLedger {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  get(idempotencyKey: string): Promise<AcceptanceNotificationRecord | null>;
  save(record: AcceptanceNotificationRecord): Promise<void>;
  list(): Promise<AcceptanceNotificationRecord[]>;
}

export interface AcceptanceDelivery {
  send(message: {
    uuid: string;
    title: string;
    text: string;
  }): Promise<{ taskId: string | null; messageId: string | null }>;
}

export interface NotifyAcceptanceContext {
  ledger: AcceptanceNotificationLedger;
  delivery: AcceptanceDelivery;
  target: { kind: 'self' } | { kind: 'user'; userId: string } | { kind: 'group'; groupId: string };
  listAcceptanceObjects(): Promise<AcceptanceObject[]>;
  clock: () => Date;
}

function idempotencyKey(object: AcceptanceObject): string {
  return `${object.objectType}:${object.objectId}:${object.version}`;
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

function stateLabel(state: AcceptanceObjectState): string {
  switch (state) {
    case 'pending': return '待验收';
    case 'later': return '稍后处理';
    case 'rejected': return '已退回';
  }
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
  ) return error.code;
  return 'acceptance_delivery_failed';
}

function baseRecord(
  object: AcceptanceObject,
  attemptedAt: string,
): Omit<AcceptanceNotificationRecord, 'status' | 'errorCode' | 'taskId' | 'messageId'> {
  const key = idempotencyKey(object);
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    objectType: object.objectType,
    objectId: object.objectId,
    version: object.version,
    uuid: stableUuid(key),
    attemptedAt,
  };
}

class AcceptancePayloadRejectedError extends Error {
  readonly code = 'acceptance_payload_rejected';

  constructor() {
    super('Acceptance notification payload rejected');
    this.name = 'AcceptancePayloadRejectedError';
  }
}

function assertSafePayload(object: AcceptanceObject): void {
  const title = object.title;
  const artifact = object.artifact;
  const unsafeSummary = artifact !== undefined && (
    artifact.summary.trim().length === 0
    || artifact.summary !== artifact.summary.trim()
    || artifact.summary.length > 300
    || hasControlCharacters(artifact.summary)
    || /\r|\n/u.test(artifact.summary)
    || /\b[a-z][a-z0-9+.-]*:\/\//iu.test(artifact.summary)
    || /(?:^|[\s(])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u.test(artifact.summary)
    || /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/iu.test(artifact.summary)
    || /\b(?:token|secret|app[_-]?secret|access[_-]?key)\b\s*[:=]/iu.test(artifact.summary)
    || !/^task-[a-z0-9-]+@v[1-9]\d*$/u.test(artifact.reference)
    || !Number.isSafeInteger(artifact.evidenceCount)
    || artifact.evidenceCount < 0
    || artifact.evidenceCount > 999
    || Object.values(artifact.checks).some((count) => (
      !Number.isSafeInteger(count) || count < 0 || count > 999
    ))
  );
  const unsafeTitle = (
    title.trim().length === 0
    || title !== title.trim()
    || title.length > 120
    || hasControlCharacters(title)
    || /\b[a-z][a-z0-9+.-]*:\/\//iu.test(title)
    || /(?:^|[\s(])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u.test(title)
    || /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/iu.test(title)
    || /\b(?:token|secret|app[_-]?secret|access[_-]?key)\b\s*[:=]/iu.test(title)
    || /(?:合同|回款|付款|支付|听记原文|转写原文|客户材料)/u.test(title)
    || /\d{6,}/u.test(title)
  );
  if (
    unsafeTitle
    || unsafeSummary
    || !Number.isSafeInteger(object.pendingCount)
    || object.pendingCount < 0
    || object.pendingCount > 999
  ) {
    throw new AcceptancePayloadRejectedError();
  }
}

function messageFor(object: AcceptanceObject): { title: string; text: string } {
  assertSafePayload(object);
  const artifactLines = object.artifact === undefined
    ? []
    : [
        `任务 ID：${object.objectId}`,
        `Artifact：${object.artifact.reference}`,
        `结果：${object.artifact.summary}`,
        `自检：通过 ${object.artifact.checks.met}；部分通过 ${object.artifact.checks.partial}；未通过 ${object.artifact.checks.notMet}；证据 ${object.artifact.evidenceCount}`,
      ];
  const actionLines = object.artifact === undefined
    ? []
    : [
        '回复操作：',
        `接受 ${object.objectId} v${object.version}`,
        `要求修改 ${object.objectId} v${object.version}：请说明需要修改的内容`,
        `阻塞 ${object.objectId} v${object.version}：请说明阻塞原因`,
        `取消 ${object.objectId} v${object.version}：请说明取消原因`,
      ];
  return {
    title: 'ATL 待验收通知',
    text: [
      `标题：${object.title}`,
      ...artifactLines,
      `状态：${stateLabel(object.state)}`,
      `待确认：${object.pendingCount} 项`,
      `位置：${ACCEPTANCE_NAVIGATION}`,
      ...actionLines,
    ].join('\n'),
  };
}

function sameObject(left: AcceptanceObject, right: AcceptanceObject): boolean {
  return left.objectType === right.objectType
    && left.objectId === right.objectId
    && left.version === right.version;
}

export async function notifyAcceptance(
  context: NotifyAcceptanceContext,
  object: AcceptanceObject,
): Promise<AcceptanceNotificationRecord> {
  return context.ledger.withLock(async () => {
    const key = idempotencyKey(object);
    const existing = await context.ledger.get(key);
    if (existing?.status === 'sent') return existing;
    const attemptedAt = context.clock().toISOString();
    const base = existing === null
      ? baseRecord(object, attemptedAt)
      : { ...existing, attemptedAt };

    const visible = await context.listAcceptanceObjects();
    const titleMatches = visible.filter((candidate) => candidate.title === object.title);
    if (titleMatches.length !== 1 || !sameObject(titleMatches[0]!, object)) {
      const conflict: AcceptanceNotificationRecord = {
        ...base,
        status: 'conflict',
        errorCode: 'acceptance_location_conflict',
        taskId: null,
        messageId: null,
      };
      await context.ledger.save(conflict);
      return conflict;
    }

    if (context.target.kind !== 'self') {
      const failed: AcceptanceNotificationRecord = {
        ...base,
        status: 'failed',
        errorCode: 'acceptance_recipient_not_self',
        taskId: null,
        messageId: null,
      };
      await context.ledger.save(failed);
      return failed;
    }

    try {
      const message = messageFor(object);
      const delivery = await context.delivery.send({ uuid: base.uuid, ...message });
      const sent: AcceptanceNotificationRecord = {
        ...base,
        status: 'sent',
        errorCode: null,
        taskId: delivery.taskId,
        messageId: delivery.messageId,
      };
      await context.ledger.save(sent);
      return sent;
    } catch (error) {
      const failed: AcceptanceNotificationRecord = {
        ...base,
        status: 'failed',
        errorCode: safeErrorCode(error),
        taskId: null,
        messageId: null,
      };
      await context.ledger.save(failed);
      return failed;
    }
  });
}
