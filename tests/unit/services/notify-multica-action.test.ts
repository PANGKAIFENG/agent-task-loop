import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MulticaActionNotNotifiableError,
  notifyMulticaAction,
  type MulticaActionDelivery,
  type MulticaActionNotificationRecord,
} from '../../../src/services/notify-multica-action.js';
import { FileMulticaActionNotificationLedger } from '../../../src/storage/file-multica-action-notification-ledger.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';

const TASK_ID = 'task-20260820-abc00001';

function event(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-0001',
    atlTaskId: TASK_ID,
    state: 'needs_decision',
    summary: '选择 synthetic canary 的恢复策略',
    decision: {
      question: '真实 Vault 写入前选择恢复策略',
      options: [{ id: 'retry_with_fixture', label: '使用合成数据重试' }],
    },
    recoverability: null,
    artifactRefs: [],
    release: null,
    occurredAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

class ScriptedDelivery implements MulticaActionDelivery {
  sends: Array<{ uuid: string; title: string; text: string }> = [];
  attempts = 0;
  failWith: Error | null = null;
  messageId: string | null = 'ding-msg-1';
  taskId: string | null = null;

  async send(message: { uuid: string; title: string; text: string }) {
    this.attempts += 1;
    if (this.failWith !== null) {
      throw this.failWith;
    }
    this.sends.push(message);
    return { taskId: this.taskId, messageId: this.messageId };
  }
}

describe('notifyMulticaAction', () => {
  let ledgerRoot: string;
  let ledger: FileMulticaActionNotificationLedger;
  let delivery: ScriptedDelivery;
  let clockAt = 0;

  const context = () => ({
    ledger,
    delivery,
    clock: () => new Date('2026-08-20T12:00:00.000Z'),
  });

  beforeEach(async () => {
    ledgerRoot = await mkdtemp(join(tmpdir(), 'atl-multica-notifications-'));
    ledger = new FileMulticaActionNotificationLedger(ledgerRoot);
    delivery = new ScriptedDelivery();
    clockAt = 0;
    void clockAt;
  });

  afterEach(async () => {
    await rm(ledgerRoot, { recursive: true, force: true });
  });

  it('sends once under the stable key and records the read-back message id', async () => {
    const first = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });
    expect(first.status).toBe('sent');
    expect(first.messageId).toBe('ding-msg-1');
    expect(first.idempotencyKey).toBe(`multica:${TASK_ID}:evt-0001:needs_decision`);
    expect(first.draftText).toContain('TEP-42');
    expect(first.draftText).toContain('evt-0001');
    expect(first.draftText).toContain(`select:retry_with_fixture ${TASK_ID}`);

    const second = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });
    expect(second.status).toBe('sent');
    expect(delivery.sends).toHaveLength(1);
  });

  it('never notifies for completed events or ordinary progress', async () => {
    await expect(notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 't',
      issueIdentifier: 'TEP-42',
      event: event({ state: 'completed', decision: null }),
    })).rejects.toThrow(MulticaActionNotNotifiableError);
    expect(delivery.sends).toHaveLength(0);
  });

  it('records an asynchronous task receipt when DingTalk omits a message id', async () => {
    delivery.messageId = null;
    delivery.taskId = 'synthetic-process-query-key';

    const record = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });

    expect(record.status).toBe('sent');
    expect(record.messageId).toBe('synthetic-process-query-key');
  });

  it('keeps a successful delivery without any receipt id unknown', async () => {
    delivery.messageId = null;
    delivery.taskId = null;

    const record = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });

    expect(record.status).toBe('unknown');
    expect(record.errorCode).toBe('multica_notification_unknown');
    expect(record.messageId).toBeNull();
  });

  it('does not resend an unknown delivery before its receipt is recovered', async () => {
    const uncertain = new Error('lost') as Error & { code: string };
    uncertain.code = 'dingtalk_delivery_unknown';
    delivery.failWith = uncertain;

    const record = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });
    expect(record.status).toBe('unknown');
    expect(record.errorCode).toBe('multica_notification_unknown');

    // Reconciliation may revisit the event, but an ambiguous send must wait
    // for receipt recovery because DWS has no client idempotency parameter.
    delivery.failWith = null;
    const retried: MulticaActionNotificationRecord = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });
    expect(retried).toEqual(record);
    expect(retried.status).toBe('unknown');
    expect(delivery.attempts).toBe(1);
    expect(delivery.sends).toHaveLength(0);
  });

  it('records a failed send with its error code', async () => {
    const failure = new Error('nope') as Error & { code: string };
    failure.code = 'dingtalk_delivery_failed';
    delivery.failWith = failure;

    const record = await notifyMulticaAction(context(), {
      taskId: TASK_ID,
      taskTitle: 'Ship the action roundtrip',
      issueIdentifier: 'TEP-42',
      event: event(),
    });
    expect(record.status).toBe('failed');
    expect(record.errorCode).toBe('dingtalk_delivery_failed');
  });
});
