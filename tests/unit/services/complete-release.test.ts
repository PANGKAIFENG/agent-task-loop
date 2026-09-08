import { describe, expect, it } from 'vitest';

import { postDeploymentAcceptance } from '../../../src/domain/post-deployment-acceptance.js';
import { releaseAcceptanceForApproval } from '../../../src/domain/release-acceptance.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
import type { ReleaseReceipt } from '../../../src/domain/release-receipt.js';
import type { Task } from '../../../src/domain/task.js';
import {
  completeRelease,
  type CompleteReleaseDependencies,
  type PostDeploymentCompletionEvidence,
} from '../../../src/services/complete-release.js';
import type { ReleaseReceiptLedger } from '../../../src/storage/file-release-receipt-ledger.js';
import type { TaskRepository } from '../../../src/storage/contracts.js';
import { FileReleaseCompletionIntentLedger } from '../../../src/storage/file-release-receipt-ledger.js';
import { FileMulticaActionNotificationLedger } from '../../../src/storage/file-multica-action-notification-ledger.js';
import { FileMulticaResponseLedger } from '../../../src/storage/file-multica-response-ledger.js';
import { FileReleaseReceiptLedger } from '../../../src/storage/file-release-receipt-ledger.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const TASK_ID = 'task-20260821-rel00001';
const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const FILE_SHA = 'd'.repeat(64);

function rcEvent(): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-rc-0001',
    atlTaskId: TASK_ID,
    state: 'release_candidate_ready',
    summary: 'Fresh CR passed',
    decision: null,
    recoverability: null,
    artifactRefs: [],
    release: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      issue: '22',
      pr: '23',
      headSha: HEAD_SHA,
    },
    occurredAt: '2026-08-21T02:00:00.000Z',
  };
}

const acceptance = releaseAcceptanceForApproval({
  event: rcEvent(),
  streamEventId: 'stream-approve-0001',
  freshReviewRef: 'TEP-69',
  acceptedAt: '2026-08-21T02:05:00.000Z',
});

function completedEvent(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-completed-0001',
    atlTaskId: TASK_ID,
    state: 'completed',
    summary: 'Release published and read back',
    decision: null,
    recoverability: null,
    artifactRefs: ['artifact://release/read-back'],
    release: null,
    occurredAt: '2026-08-21T03:00:00.000Z',
    ...overrides,
  };
}

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Release task',
    body: '',
    status: 'review',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Complete the published release',
    acceptanceCriteria: ['All read-back evidence is current'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    executionLink: {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: `atl:${TASK_ID}`,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-53',
      dispatchState: 'linked',
      remoteState: 'completed',
      lastCommentId: 'comment-completed-0001',
      lastEventId: 'evt-completed-0001',
      summary: null,
      artifactRefs: [],
      lastAttemptAt: '2026-08-21T01:00:00.000Z',
      lastSyncedAt: '2026-08-21T03:01:00.000Z',
    },
    actionRequest: {
      schemaVersion: 1,
      actionId: `action:${TASK_ID}:evt-rc-0001`,
      eventId: 'evt-rc-0001',
      type: 'release_candidate_ready',
      status: 'handled',
      title: 'Accept release candidate',
      summary: 'Fresh CR passed',
      allowedActions: ['approve', 'rework', 'block', 'cancel'],
      multicaIssue: 'TEP-53',
      githubPr: '23',
      headSha: HEAD_SHA,
      notificationId: 'msg-notify-0001',
      handledStreamEventId: 'stream-approve-0001',
      handledTerminalStep: 'release_operator_started',
    },
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `test:${TASK_ID}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-21T00:00:00.000Z',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T03:01:00.000Z',
    ...overrides,
  };
}

function receipt(): ReleaseReceipt {
  const receiptId = `release-receipt:${acceptance.acceptanceId}`;
  const metadataValue = JSON.stringify({
    schema_version: 1,
    receipt_id: receiptId,
    body: 'published',
  });
  return {
    schemaVersion: 1,
    receiptId,
    acceptanceId: acceptance.acceptanceId,
    atlTaskId: TASK_ID,
    eventId: acceptance.eventId,
    headSha: HEAD_SHA,
    status: 'passed',
    startedAt: '2026-08-21T02:06:00.000Z',
    completedAt: '2026-08-21T03:02:00.000Z',
    rejectionReason: null,
    verification: {
      nodeVersion: 'v24.15.0',
      headCheck: { command: 'git rev-parse HEAD', observedHeadSha: HEAD_SHA, matched: true },
      candidateCheck: {
        statusCommand: 'git status --porcelain=v1 --untracked-files=all',
        cleanBefore: true,
        cleanAfter: true,
        postHeadCommand: 'git rev-parse HEAD',
        observedHeadShaAfter: HEAD_SHA,
        headMatchedAfter: true,
      },
      commands: [{ command: 'pnpm test', exitCode: 0, durationMs: 10, outputTail: 'passed' }],
    },
    merge: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      pr: '23',
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      prStatus: 'merged',
      issueStatus: 'closed',
    },
    plugin: {
      backup: null,
      install: {
        pluginDir: '/synthetic/plugins/agent-task-loop',
        manifest: 'agent-task-loop',
        version: '0.9.1',
        fileHashes: [
          { path: 'main.js', sha256: FILE_SHA, mode: 0o644 },
          { path: 'qianwen-accessibility-helper', sha256: FILE_SHA, mode: 0o755 },
        ],
        installedAt: '2026-08-21T02:30:00.000Z',
      },
      rollback: null,
    },
    liveVerification: {
      canaryTaskId: 'task-20260821-canary001',
      multicaIssueId: ISSUE_ID,
      multicaRunId: 'run-0001',
      dingTalkMessageId: 'msg-notify-0001',
      dingTalkStreamEventId: 'stream-approve-0001',
      passed: true,
      summary: 'Synthetic live verification passed',
    },
    readBack: {
      github: {
        repository: 'PANGKAIFENG/personal-ai-workbench',
        mergeSha: MERGE_SHA,
        prStatus: 'merged',
        issueStatus: 'closed',
        headSha: HEAD_SHA,
      },
      multica: {
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-53',
        receiptMetadataKey: 'atl_release_receipt',
        receiptMetadataValue: metadataValue,
      },
      dingtalk: { messageId: 'msg-notify-0001', streamEventId: 'stream-approve-0001' },
      atl: {
        taskId: TASK_ID,
        taskStatus: 'review',
        frontmatterPath: '/synthetic/vault/10_Tasks/Active/project/task.md',
        finalSummary: 'Published release completed from immutable evidence',
      },
    },
    postDeployment: {
      completedEventId: 'evt-completed-0001',
      completedEventOccurredAt: '2026-08-21T03:00:00.000Z',
      multicaIssueId: ISSUE_ID,
      multicaIssueIdentifier: 'TEP-53',
      multicaIssueStatus: 'done',
      remoteState: 'completed',
      notificationLedgerKey: `multica:${TASK_ID}:evt-rc-0001:release_candidate_ready`,
      notificationMessageId: 'msg-notify-0001',
      responseLedgerStreamEventId: 'stream-approve-0001',
      responseCommentId: 'comment-response-0001',
      independentReviewRef: 'TEP-69',
      receiptMetadataKey: 'atl_release_receipt',
      receiptMetadataValue: metadataValue,
      readAt: '2026-08-21T03:02:00.000Z',
    },
  };
}

function completionPorts() {
  return {
    atlReadBack: (task: Task) => ({
      taskId: task.taskId,
      taskStatus: task.status,
      frontmatterPath: task.status === 'done'
        ? '/synthetic/vault/10_Tasks/Archive/2026/task.md'
        : '/synthetic/vault/10_Tasks/Active/project/task.md',
      finalSummary: 'Published release completed from immutable evidence',
    }),
  };
}

function evidence(overrides: Partial<PostDeploymentCompletionEvidence> = {}): PostDeploymentCompletionEvidence {
  return {
    schemaVersion: 1,
    acceptance,
    completedEvent: completedEvent(),
    receipt: receipt(),
    ...overrides,
  };
}

const completionLineageConflicts: Array<{
  field: string;
  mutate: (value: ReleaseReceipt) => ReleaseReceipt;
}> = [
  {
    field: 'merge SHA',
    mutate: (value) => ({
      ...value,
      merge: { ...value.merge!, mergeSha: 'f'.repeat(40) },
    }),
  },
  {
    field: 'plugin hash',
    mutate: (value) => {
      if (value.plugin?.install === null || value.plugin?.install === undefined) {
        throw new Error('test fixture requires a plugin install receipt');
      }
      return {
        ...value,
        plugin: {
          ...value.plugin,
          install: {
            ...value.plugin.install,
            fileHashes: value.plugin.install.fileHashes.map((entry, index) => (
              index === 0 ? { ...entry, sha256: 'e'.repeat(64) } : entry
            )),
          },
        },
      };
    },
  },
  {
    field: 'Multica metadata',
    mutate: (value) => ({
      ...value,
      readBack: {
        ...value.readBack!,
        multica: {
          ...value.readBack!.multica,
          receiptMetadataValue: JSON.stringify({
            schema_version: 1,
            receipt_id: value.receiptId,
            body: 'conflicting-published-read-back',
          }),
        },
      },
    }),
  },
  {
    field: 'ATL final summary',
    mutate: (value) => ({
      ...value,
      readBack: {
        ...value.readBack!,
        atl: {
          ...value.readBack!.atl,
          finalSummary: 'Conflicting terminal summary',
        },
      },
    }),
  },
];

async function completionDependencies(
  root: string,
  ledger: ReleaseReceiptLedger = new FileReleaseReceiptLedger(`${root}/.atl-runtime`),
) {
  const completionIntents = new FileReleaseCompletionIntentLedger(`${root}/.atl-runtime`);
  const notifications = new FileMulticaActionNotificationLedger(`${root}/.atl-runtime`);
  const responses = new FileMulticaResponseLedger(`${root}/.atl-runtime`);
  await notifications.save({
    schemaVersion: 1,
    idempotencyKey: `multica:${TASK_ID}:evt-rc-0001:release_candidate_ready`,
    taskId: TASK_ID,
    eventId: 'evt-rc-0001',
    state: 'release_candidate_ready',
    uuid: '01234567-89ab-5cde-8f01-234567890abc',
    status: 'sent',
    attemptedAt: '2026-08-21T02:01:00.000Z',
    errorCode: null,
    messageId: 'msg-notify-0001',
    draftTitle: 'Accept release candidate',
    draftText: 'Fresh CR passed',
  });
  await responses.save({
    schemaVersion: 1,
    streamEventId: 'stream-approve-0001',
    taskId: TASK_ID,
    eventId: 'evt-rc-0001',
    actionId: `action:${TASK_ID}:evt-rc-0001`,
    action: 'approve',
    message: 'approve',
    trust: {
      senderUserId: 'trusted-user',
      conversationId: 'trusted-conversation',
      trusted: true,
    },
    step: 'release_operator_started',
    terminalStep: 'release_operator_started',
    rejectedReason: null,
    receivedAt: '2026-08-21T02:04:00.000Z',
    recordedAt: '2026-08-21T02:04:10.000Z',
    confirmedAt: '2026-08-21T02:04:20.000Z',
    resumedAt: '2026-08-21T02:05:00.000Z',
    responseCommentId: 'comment-response-0001',
    baselineRunIds: ['run-baseline'],
    runIds: ['run-release-operator'],
    remoteWriteUnknown: null,
    lastError: null,
  });
  return {
    ledger,
    completionIntents,
    notifications,
    responses,
    atlReadBack: completionPorts().atlReadBack,
  };
}

async function alreadyPublishedDependencies(
  root: string,
  ledger: ReleaseReceiptLedger = new FileReleaseReceiptLedger(`${root}/.atl-runtime`),
) {
  const completionIntents = new FileReleaseCompletionIntentLedger(`${root}/.atl-runtime`);
  const notifications = new FileMulticaActionNotificationLedger(`${root}/.atl-runtime`);
  const responses = new FileMulticaResponseLedger(`${root}/.atl-runtime`);
  await notifications.save({
    schemaVersion: 1,
    idempotencyKey: `multica:${TASK_ID}:evt-live-decision:needs_decision`,
    taskId: TASK_ID,
    eventId: 'evt-live-decision',
    state: 'needs_decision',
    uuid: '11234567-89ab-5cde-8f01-234567890abc',
    status: 'sent',
    attemptedAt: '2026-08-21T01:50:00.000Z',
    errorCode: null,
    messageId: 'msg-live-decision',
    draftTitle: 'Accept live verification',
    draftText: 'Accept the already-published live verification',
  });
  await responses.save({
    schemaVersion: 1,
    streamEventId: 'stream-live-accept',
    taskId: TASK_ID,
    eventId: 'evt-live-decision',
    actionId: `action:${TASK_ID}:evt-live-decision`,
    action: 'select:accept',
    message: `select:accept ${TASK_ID}`,
    trust: {
      senderUserId: 'trusted-user',
      conversationId: 'trusted-conversation',
      trusted: true,
    },
    step: 'supervisor_resumed',
    terminalStep: 'supervisor_resumed',
    rejectedReason: null,
    receivedAt: '2026-08-21T02:05:00.000Z',
    recordedAt: '2026-08-21T02:05:10.000Z',
    confirmedAt: '2026-08-21T02:05:20.000Z',
    resumedAt: '2026-08-21T02:05:30.000Z',
    responseCommentId: 'comment-live-response',
    baselineRunIds: ['run-baseline'],
    runIds: ['run-baseline', 'run-resumed'],
    remoteWriteUnknown: null,
    lastError: null,
  });
  return {
    ledger,
    completionIntents,
    notifications,
    responses,
    atlReadBack: completionPorts().atlReadBack,
  };
}

describe('completeRelease', () => {
  it('completes an already-published task from its trusted needs_decision acceptance without phase evidence', async () => {
    const harness = await createTestServiceContext();
    try {
      const publishedAcceptance = postDeploymentAcceptance({
        atlTaskId: TASK_ID,
        eventId: 'evt-live-decision',
        headSha: HEAD_SHA,
        streamEventId: 'stream-live-accept',
        freshReviewRef: 'TEP-75',
        repository: 'PANGKAIFENG/personal-ai-workbench',
        githubIssue: '22',
        githubPr: '20',
        acceptedAt: '2026-08-21T02:05:00.000Z',
      });
      await harness.ctx.tasks.save(reviewTask({
        actionRequest: {
          schemaVersion: 1,
          actionId: `action:${TASK_ID}:evt-live-decision`,
          eventId: 'evt-live-decision',
          type: 'needs_decision',
          status: 'handled',
          title: 'Accept live verification',
          summary: 'The already-published live verification is ready for acceptance',
          allowedActions: ['select:accept', 'select:rework', 'block', 'cancel'],
          multicaIssue: 'TEP-53',
          githubPr: null,
          headSha: null,
          notificationId: 'msg-live-decision',
          handledStreamEventId: 'stream-live-accept',
          handledTerminalStep: 'supervisor_resumed',
        },
      }));
      const publishedReceipt = {
        ...receipt(),
        receiptId: `release-receipt:${publishedAcceptance.acceptanceId}`,
        acceptanceId: publishedAcceptance.acceptanceId,
        eventId: publishedAcceptance.eventId,
        merge: {
          ...receipt().merge!,
          pr: '20',
        },
        readBack: {
          ...receipt().readBack!,
          dingtalk: { messageId: 'msg-live-decision', streamEventId: 'stream-live-accept' },
        },
        postDeployment: {
          ...receipt().postDeployment!,
          notificationLedgerKey: `multica:${TASK_ID}:evt-live-decision:needs_decision`,
          notificationMessageId: 'msg-live-decision',
          responseLedgerStreamEventId: 'stream-live-accept',
          responseCommentId: 'comment-live-response',
          independentReviewRef: 'TEP-75',
        },
      };
      const metadataValue = JSON.stringify({
        schema_version: 1,
        receipt_id: publishedReceipt.receiptId,
        body: 'already-published completion',
      });
      publishedReceipt.readBack.multica.receiptMetadataValue = metadataValue;
      publishedReceipt.postDeployment.receiptMetadataValue = metadataValue;

      const result = await completeRelease(
        harness.ctx,
        await alreadyPublishedDependencies(harness.root),
        {
          schemaVersion: 1,
          acceptance: publishedAcceptance,
          completedEvent: completedEvent(),
          receipt: publishedReceipt,
        },
      );
      expect(result.status).toBe('completed');
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
    } finally {
      await harness.cleanup();
    }
  });

  it('combines release-phase evidence into one final receipt and replays without phase writes', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const phaseLedger = new FileReleaseReceiptLedger(runtimeRoot, 'multica-release-phase-evidence.json');
      const phase = {
        ...receipt(),
        completedAt: '2026-08-21T02:59:00.000Z',
        readBack: {
          ...receipt().readBack!,
          atl: { ...receipt().readBack!.atl, taskStatus: 'review' },
        },
        postDeployment: undefined,
      };
      await phaseLedger.save(phase);
      const dependencies: CompleteReleaseDependencies = await completionDependencies(
        harness.root,
        finalLedger,
      );
      dependencies.phaseEvidence = phaseLedger;

      const completed = await completeRelease(harness.ctx, dependencies, evidence());
      const replay = await completeRelease(harness.ctx, dependencies, evidence());

      expect(completed.status).toBe('completed');
      expect(replay.status).toBe('replayed');
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
      expect((await finalLedger.list())).toHaveLength(1);
      expect((await phaseLedger.get(acceptance.acceptanceId))?.postDeployment).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it('journals the factual review intent, then persists a final done read-back', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const ledger = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);

      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root, ledger),
        evidence(),
      );

      expect(result.status).toBe('completed');
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
      expect((await ledger.get(acceptance.acceptanceId))?.readBack?.atl).toEqual({
        taskId: TASK_ID,
        taskStatus: 'done',
        frontmatterPath: '/synthetic/vault/10_Tasks/Archive/2026/task.md',
        finalSummary: 'Published release completed from immutable evidence',
      });
    } finally {
      await harness.cleanup();
    }
  });

  it('fails closed on stale or conflicting evidence and leaves review unchanged', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root),
        evidence({ completedEvent: completedEvent({ eventId: 'evt-stale' }) }),
      );

      expect(result).toMatchObject({ status: 'rejected' });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it('fails closed when trusted notification and response ledger rows are missing', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const result = await completeRelease(harness.ctx, {
        ledger: new FileReleaseReceiptLedger(runtimeRoot),
        completionIntents: new FileReleaseCompletionIntentLedger(runtimeRoot),
        notifications: new FileMulticaActionNotificationLedger(runtimeRoot),
        responses: new FileMulticaResponseLedger(runtimeRoot),
        atlReadBack: (task) => ({
          ...receipt().readBack!.atl,
          taskStatus: task.status,
        }),
      }, evidence());

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('ledger record is missing'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it('replays an identical completion without another ledger write', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const stored = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);
      let saves = 0;
      const ledger: ReleaseReceiptLedger = {
        get: (id) => stored.get(id),
        list: () => stored.list(),
        save: async (value) => {
          saves += 1;
          await stored.save(value);
        },
      };
      const dependencies = await completionDependencies(harness.root, ledger);
      await completeRelease(harness.ctx, dependencies, evidence());

      const replay = await completeRelease(harness.ctx, dependencies, evidence());

      expect(replay.status).toBe('replayed');
      expect(saves).toBe(1);
    } finally {
      await harness.cleanup();
    }
  });

  it('recovers a crash after intent persistence without fabricating a done read-back', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const ledger = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);
      const intents = new FileReleaseCompletionIntentLedger(`${harness.root}/.atl-runtime`);
      await intents.save(receipt());

      const recovered = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, ledger)),
          completionIntents: intents,
        },
        evidence(),
      );

      expect(recovered.status).toBe('completed');
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
    } finally {
      await harness.cleanup();
    }
  });

  it('recovers a crash after the done projection by writing the actual final read-back', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask({
        status: 'done',
        updatedAt: receipt().completedAt,
      }));
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const ledger = new FileReleaseReceiptLedger(runtimeRoot);
      const intents = new FileReleaseCompletionIntentLedger(runtimeRoot);
      await intents.save(receipt());

      const recovered = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, ledger)),
          completionIntents: intents,
        },
        evidence(),
      );

      expect(recovered.status).toBe('completed');
      expect((await ledger.get(acceptance.acceptanceId))?.readBack?.atl.taskStatus).toBe('done');
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects caller-supplied done as a pre-transition read-back', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const claimedDone = {
        ...receipt(),
        readBack: {
          ...receipt().readBack!,
          atl: { ...receipt().readBack!.atl, taskStatus: 'done' },
        },
      };

      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root),
        evidence({ receipt: claimedDone }),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('current review state'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects an existing different receipt instead of overwriting it', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const ledger = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);
      await ledger.save({ ...receipt(), completedAt: '2026-08-21T03:03:00.000Z' });

      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root, ledger),
        evidence(),
      );

      expect(result).toMatchObject({ status: 'rejected', reason: expect.stringContaining('conflict') });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps review when the projected ATL read-back fails before the final receipt', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const dependencies = await completionDependencies(harness.root, finalLedger);
      dependencies.atlReadBack = () => {
        throw new Error('synthetic ATL read-back failure');
      };

      const result = await completeRelease(harness.ctx, dependencies, evidence());

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('ATL projected read-back failed'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
      expect(await finalLedger.get(acceptance.acceptanceId)).toBeNull();
      expect(await dependencies.completionIntents.get(acceptance.acceptanceId)).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps review when final receipt persistence fails', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const stored = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);
      const failingLedger: ReleaseReceiptLedger = {
        get: (id) => stored.get(id),
        list: () => stored.list(),
        save: async () => {
          throw new Error('synthetic receipt persistence failure');
        },
      };

      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root, failingLedger),
        evidence(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('final release receipt persistence failed'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
      expect(await stored.get(acceptance.acceptanceId)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('replays a legacy done task and final receipt without a completion intent', async () => {
    const harness = await createTestServiceContext();
    try {
      const finalLedger = new FileReleaseReceiptLedger(`${harness.root}/.atl-runtime`);
      const finalReceipt = {
        ...receipt(),
        readBack: {
          ...receipt().readBack!,
          atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
        },
      };
      await harness.ctx.tasks.save(reviewTask({
        status: 'done',
        updatedAt: finalReceipt.completedAt,
      }));
      await finalLedger.save(finalReceipt);

      const result = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, finalLedger)),
          completionIntents: new FileReleaseCompletionIntentLedger(`${harness.root}/.atl-runtime`),
        },
        evidence({ receipt: finalReceipt }),
      );

      expect(result).toMatchObject({ status: 'replayed', receipt: finalReceipt });
      expect(await new FileReleaseCompletionIntentLedger(`${harness.root}/.atl-runtime`).get(acceptance.acceptanceId)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('recovers a legacy review task after receipt persistence without writing an intent', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const intents = new FileReleaseCompletionIntentLedger(runtimeRoot);
      const legacyReceipt = {
        ...receipt(),
        readBack: {
          ...receipt().readBack!,
          atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
        },
      };
      await finalLedger.save(legacyReceipt);

      const result = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, finalLedger)),
          completionIntents: intents,
        },
        evidence({ receipt: legacyReceipt }),
      );

      expect(result).toMatchObject({ status: 'completed', receipt: legacyReceipt });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
      expect(await intents.get(acceptance.acceptanceId)).toBeNull();
      expect(await finalLedger.get(acceptance.acceptanceId)).toEqual(legacyReceipt);
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects a review-shaped legacy receipt for a still-review task', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      await finalLedger.save(receipt());

      const result = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, finalLedger)),
          completionIntents: new FileReleaseCompletionIntentLedger(runtimeRoot),
        },
        evidence(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('current done state'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it('recovers a persisted final receipt by projecting a still-review task to done', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const intents = new FileReleaseCompletionIntentLedger(runtimeRoot);
      await intents.save(receipt());
      const finalReceipt = {
        ...receipt(),
        readBack: {
          ...receipt().readBack!,
          atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
        },
      };
      await finalLedger.save(finalReceipt);

      const result = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, finalLedger)),
          completionIntents: intents,
        },
        evidence(),
      );

      expect(result).toMatchObject({ status: 'replayed', receipt: finalReceipt });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps review after a task projection failure and recovers from the durable receipt', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const storedTasks = harness.ctx.tasks;
      let failDoneSave = true;
      const failingTasks: TaskRepository = {
        withTaskLock: (taskId, operation) => storedTasks.withTaskLock(taskId, operation),
        list: () => storedTasks.list(),
        get: (taskId) => storedTasks.get(taskId),
        findBySourceKey: (sourceKey) => storedTasks.findBySourceKey(sourceKey),
        createIfSourceKeyAbsent: (task) => storedTasks.createIfSourceKeyAbsent(task),
        save: async (task) => {
          if (task.status === 'done' && failDoneSave) {
            failDoneSave = false;
            throw new Error('synthetic task projection failure');
          }
          return storedTasks.save(task);
        },
        saveBody: (task) => storedTasks.saveBody(task),
      };
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const dependencies = await completionDependencies(harness.root, finalLedger);

      const failed = await completeRelease(
        { ...harness.ctx, tasks: failingTasks },
        dependencies,
        evidence(),
      );

      expect(failed).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('task done projection failed'),
      });
      expect((await storedTasks.get(TASK_ID)).status).toBe('review');
      expect(await finalLedger.get(acceptance.acceptanceId)).not.toBeNull();

      const recovered = await completeRelease(harness.ctx, dependencies, evidence());

      expect(recovered.status).toBe('replayed');
      expect((await storedTasks.get(TASK_ID)).status).toBe('done');
    } finally {
      await harness.cleanup();
    }
  });

  it('rejects a non-identical legacy replay without writing an intent', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const finalReceipt = {
        ...receipt(),
        readBack: {
          ...receipt().readBack!,
          atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
        },
      };
      await harness.ctx.tasks.save(reviewTask({ status: 'done' }));
      await finalLedger.save(finalReceipt);

      const result = await completeRelease(
        harness.ctx,
        await completionDependencies(harness.root, finalLedger),
        evidence({ receipt: { ...finalReceipt, completedAt: '2026-08-21T03:03:00.000Z' } }),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('legacy immutable release receipt conflict'),
      });
      expect(await new FileReleaseCompletionIntentLedger(runtimeRoot).get(acceptance.acceptanceId)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it('fails closed when the durable completion intent conflicts with the final receipt lineage', async () => {
    const harness = await createTestServiceContext();
    try {
      await harness.ctx.tasks.save(reviewTask());
      const runtimeRoot = `${harness.root}/.atl-runtime`;
      const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
      const intents = new FileReleaseCompletionIntentLedger(runtimeRoot);
      const intentReceipt = receipt();
      const finalReceipt = {
        ...intentReceipt,
        completedAt: '2026-08-21T03:03:00.000Z',
        readBack: {
          ...intentReceipt.readBack!,
          atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
        },
      };
      await intents.save(intentReceipt);
      await finalLedger.save(finalReceipt);

      const result = await completeRelease(
        harness.ctx,
        {
          ...(await completionDependencies(harness.root, finalLedger)),
          completionIntents: intents,
        },
        evidence(),
      );

      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('completion intent and final release receipt conflict'),
      });
      expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    } finally {
      await harness.cleanup();
    }
  });

  it.each(completionLineageConflicts)(
    'fails closed when completion intent and final receipt differ in $field',
    async ({ mutate }) => {
      const harness = await createTestServiceContext();
      try {
        await harness.ctx.tasks.save(reviewTask());
        const runtimeRoot = `${harness.root}/.atl-runtime`;
        const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
        const intents = new FileReleaseCompletionIntentLedger(runtimeRoot);
        const intentReceipt = receipt();
        const finalReceipt = mutate({
          ...intentReceipt,
          readBack: {
            ...intentReceipt.readBack!,
            atl: completionPorts().atlReadBack({ ...reviewTask(), status: 'done' }),
          },
        });
        await intents.save(intentReceipt);
        await finalLedger.save(finalReceipt);

        const result = await completeRelease(
          harness.ctx,
          {
            ...(await completionDependencies(harness.root, finalLedger)),
            completionIntents: intents,
          },
          evidence(),
        );

        expect(result).toMatchObject({
          status: 'rejected',
          reason: expect.stringContaining('completion intent and final release receipt conflict'),
        });
        expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
      } finally {
        await harness.cleanup();
      }
    },
  );
});
