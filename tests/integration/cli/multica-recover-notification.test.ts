import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { actionRequestForEvent } from '../../../src/domain/action-request.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
import type { Task } from '../../../src/domain/task.js';
import { FileMulticaActionNotificationLedger } from '../../../src/storage/file-multica-action-notification-ledger.js';
import { MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const temporaryRoots: string[] = [];
const TASK_ID = 'task-20260821-synthetic-recovery';
const EVENT_ID = 'synthetic-notification-event-v1';

function event(): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    atlTaskId: TASK_ID,
    state: 'needs_decision',
    summary: 'Synthetic decision awaits a trusted reply.',
    decision: {
      question: 'Accept the synthetic result?',
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
    objective: 'Verify receipt recovery without delivery.',
    acceptanceCriteria: ['Bind one known receipt.'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: [],
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:notification-recovery',
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
      summary: 'Synthetic decision awaits a trusted reply.',
      artifactRefs: [],
      lastAttemptAt: '2026-08-21T17:45:00.000Z',
      lastSyncedAt: '2026-08-21T17:45:00.000Z',
    },
    actionRequest: actionRequestForEvent(event(), 'TST-42'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atl multica recover-notification', () => {
  it('binds a known receipt through stdin without any DingTalk configuration', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'atl-multica-recover-notification-'));
    temporaryRoots.push(vault);
    const tasks = new MarkdownTaskRepository(vault);
    const ledger = new FileMulticaActionNotificationLedger(join(vault, '.atl-runtime'));
    await tasks.save(task());
    await ledger.save({
      schemaVersion: 1,
      idempotencyKey: `multica:${TASK_ID}:${EVENT_ID}:needs_decision`,
      taskId: TASK_ID,
      eventId: EVENT_ID,
      state: 'needs_decision',
      uuid: '32a2e46c-56cf-5d20-a4e7-08e1b3ea422f',
      status: 'unknown',
      attemptedAt: '2026-08-21T17:48:35.425Z',
      errorCode: 'multica_notification_unknown',
      messageId: null,
      draftTitle: 'ATL needs your action',
      draftText: 'Synthetic notification body',
    });

    const receiptId = 'synthetic+process/query=';
    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'multica', 'recover-notification', '--stdin-json', '--json',
    ], {
      cwd: repositoryRoot,
      env: {
        ATL_VAULT_ROOT: vault,
        ATL_ALLOW_REAL_WRITES: undefined,
        ATL_DINGTALK_PROFILE: undefined,
        ATL_DINGTALK_ROBOT_CODE: undefined,
      },
      input: JSON.stringify({ taskId: TASK_ID, eventId: EVENT_ID, receiptId }),
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'recovered',
      taskId: TASK_ID,
      eventId: EVENT_ID,
      notificationId: receiptId,
    });
    expect((await tasks.get(TASK_ID)).actionRequest?.notificationId).toBe(receiptId);
    expect((await ledger.list())[0]).toMatchObject({
      status: 'sent',
      messageId: receiptId,
    });
  });
});
