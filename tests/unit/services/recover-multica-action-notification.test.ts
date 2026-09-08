import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { actionRequestForEvent } from '../../../src/domain/action-request.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
import type { Task } from '../../../src/domain/task.js';
import {
  MulticaNotificationRecoveryRejectedError,
  recoverMulticaActionNotification,
} from '../../../src/services/recover-multica-action-notification.js';
import { FileMulticaActionNotificationLedger } from '../../../src/storage/file-multica-action-notification-ledger.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const TASK_ID = 'task-20260821-synthetic-recovery';
const EVENT_ID = 'synthetic-notification-event-v1';
const RECEIPT_ID = 'process+query/key=';

function event(): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    atlTaskId: TASK_ID,
    state: 'needs_decision',
    summary: 'Live verification awaits one trusted decision.',
    decision: {
      question: 'Accept the live verification?',
      options: [{ id: 'accept', label: 'Accept' }],
    },
    recoverability: null,
    artifactRefs: [],
    release: null,
    occurredAt: '2026-08-21T17:45:00.000Z',
  };
}

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Synthetic notification recovery',
    body: '',
    status: 'waiting_for_decision',
    reviewState: 'confirmed',
    projectId: '22222222-2222-4222-8222-222222222222',
    taskType: 'development',
    objective: 'Verify the real roundtrip.',
    acceptanceCriteria: ['One receipt and one trusted reply.'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: [],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:paw003-live',
    possibleDuplicateIds: [],
    priority: 'urgent',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-21T15:40:00.000Z',
    createdAt: '2026-08-21T15:40:00.000Z',
    updatedAt: '2026-08-21T17:45:00.000Z',
    executionLink: {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: `atl:${TASK_ID}`,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      issueId: '33333333-3333-4333-8333-333333333333',
      issueIdentifier: 'TST-42',
      dispatchState: 'linked',
      remoteState: 'needs_decision',
      lastCommentId: '44444444-4444-4444-8444-444444444444',
      lastEventId: EVENT_ID,
      summary: 'Live verification awaits one trusted decision.',
      artifactRefs: [],
      lastAttemptAt: '2026-08-21T17:45:00.000Z',
      lastSyncedAt: '2026-08-21T17:45:00.000Z',
    },
    actionRequest: actionRequestForEvent(event(), 'TST-42'),
  };
}

describe('recoverMulticaActionNotification', () => {
  let harness: TestServiceContext;
  let ledger: FileMulticaActionNotificationLedger;

  beforeEach(async () => {
    harness = await createTestServiceContext({ now: new Date('2026-08-21T18:00:00.000Z') });
    ledger = new FileMulticaActionNotificationLedger(`${harness.root}/.atl-runtime`);
    await harness.ctx.tasks.createIfSourceKeyAbsent(task());
    await ledger.save({
      schemaVersion: 1,
      idempotencyKey: `multica:${TASK_ID}:${EVENT_ID}:needs_decision`,
      taskId: TASK_ID,
      eventId: EVENT_ID,
      state: 'needs_decision',
      uuid: '1ab6fa44-3948-53aa-ba3f-f2c31f87700b',
      status: 'unknown',
      attemptedAt: '2026-08-21T17:48:35.425Z',
      errorCode: 'multica_notification_unknown',
      messageId: null,
      draftTitle: 'ATL needs your action',
      draftText: 'Synthetic notification body',
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('binds a known asynchronous receipt without invoking delivery', async () => {
    const result = await recoverMulticaActionNotification(harness.ctx, { ledger }, {
      taskId: TASK_ID,
      eventId: EVENT_ID,
      receiptId: RECEIPT_ID,
    });

    expect(result).toEqual({
      status: 'recovered',
      taskId: TASK_ID,
      eventId: EVENT_ID,
      state: 'needs_decision',
      notificationId: RECEIPT_ID,
      taskProjectionUpdated: true,
    });
    expect((await ledger.list())[0]).toMatchObject({
      status: 'sent',
      errorCode: null,
      messageId: RECEIPT_ID,
      attemptedAt: '2026-08-21T17:48:35.425Z',
    });
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId)
      .toBe(RECEIPT_ID);
  });

  it('is idempotent for the same receipt', async () => {
    const input = { taskId: TASK_ID, eventId: EVENT_ID, receiptId: RECEIPT_ID };
    await recoverMulticaActionNotification(harness.ctx, { ledger }, input);
    const replay = await recoverMulticaActionNotification(harness.ctx, { ledger }, input);

    expect(replay.status).toBe('already_recovered');
    expect(replay.taskProjectionUpdated).toBe(false);
    expect((await ledger.list())).toHaveLength(1);
  });

  it('rejects a mismatched event without changing the unknown record', async () => {
    await expect(recoverMulticaActionNotification(harness.ctx, { ledger }, {
      taskId: TASK_ID,
      eventId: 'different-event',
      receiptId: RECEIPT_ID,
    })).rejects.toBeInstanceOf(MulticaNotificationRecoveryRejectedError);

    expect((await ledger.list())[0]).toMatchObject({ status: 'unknown', messageId: null });
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId).toBeNull();
  });

  it('rejects a different receipt after recovery', async () => {
    await recoverMulticaActionNotification(harness.ctx, { ledger }, {
      taskId: TASK_ID,
      eventId: EVENT_ID,
      receiptId: RECEIPT_ID,
    });

    await expect(recoverMulticaActionNotification(harness.ctx, { ledger }, {
      taskId: TASK_ID,
      eventId: EVENT_ID,
      receiptId: 'different-receipt',
    })).rejects.toThrow('different notification receipt');
  });
});
