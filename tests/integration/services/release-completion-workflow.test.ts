import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MulticaAppendResponseResult,
  MulticaCommentPage,
  MulticaEnsureIssueResult,
  MulticaIssueSnapshot,
  MulticaReleaseConnector,
  MulticaReleaseReceiptWriteResult,
  MulticaResumeResult,
} from '../../../src/connectors/multica-cli-connector.js';
import {
  MULTICA_RELEASE_RECEIPT_METADATA_KEY,
  multicaReleaseReceiptMetadataValue,
} from '../../../src/connectors/multica-cli-connector.js';
import { releaseAcceptanceForApproval } from '../../../src/domain/release-acceptance.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
import type { Task } from '../../../src/domain/task.js';
import { completeRelease } from '../../../src/services/complete-release.js';
import { runReleaseOperator } from '../../../src/services/release-operator.js';
import { FileMulticaActionNotificationLedger } from '../../../src/storage/file-multica-action-notification-ledger.js';
import { FileMulticaResponseLedger } from '../../../src/storage/file-multica-response-ledger.js';
import {
  FileReleaseCompletionIntentLedger,
  FileReleasePhaseEvidenceLedger,
  FileReleaseReceiptLedger,
} from '../../../src/storage/file-release-receipt-ledger.js';
import { FileReleaseInvalidationLedger } from '../../../src/storage/file-release-invalidation-ledger.js';
import { FileReleaseProjectionMarkerStore } from '../../../src/storage/file-release-projection-marker.js';
import { createTestServiceContext, type TestServiceContext } from '../../helpers/service-context.js';

const TASK_ID = 'task-20260821-rel00002';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

class CountingReleaseConnector implements MulticaReleaseConnector {
  metadataWrites = 0;
  private metadata: string | null = null;

  async writeReleaseReceipt(
    _issueId: string,
    receipt: { receiptId: string; body: string },
  ): Promise<MulticaReleaseReceiptWriteResult> {
    const value = multicaReleaseReceiptMetadataValue(receipt);
    if (this.metadata === value) {
      return {
        status: 'written',
        metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
        metadataValue: value,
        deduplicated: true,
      };
    }
    this.metadataWrites += 1;
    this.metadata = value;
    return {
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: value,
      deduplicated: false,
    };
  }

  async listComments(): Promise<MulticaCommentPage> { return { comments: [] }; }
  async appendResponse(): Promise<MulticaAppendResponseResult> {
    throw new Error('release workflow must not append comments');
  }
  async resume(): Promise<MulticaResumeResult> { throw new Error('release workflow must not rerun'); }
  async runIds(): Promise<string[]> { return []; }
  async ensureIssue(): Promise<MulticaEnsureIssueResult> { throw new Error('not used'); }
  async inspect(): Promise<MulticaIssueSnapshot> { throw new Error('not used'); }
}

function releaseEvent(): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-release-0001',
    atlTaskId: TASK_ID,
    state: 'release_candidate_ready',
    summary: 'Fresh review passed',
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

function reviewTask(): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Staged release completion',
    body: '',
    status: 'review',
    reviewState: 'confirmed',
    projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    taskType: 'development',
    objective: 'Publish, verify, then complete from evidence',
    acceptanceCriteria: ['No duplicate external actions'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    executionLink: {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: `atl:${TASK_ID}`,
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-73',
      dispatchState: 'linked',
      remoteState: 'release_candidate_ready',
      lastCommentId: 'comment-release-0001',
      lastEventId: 'evt-release-0001',
      summary: null,
      artifactRefs: [],
      lastAttemptAt: '2026-08-21T01:00:00.000Z',
      lastSyncedAt: '2026-08-21T02:00:00.000Z',
    },
    actionRequest: {
      schemaVersion: 1,
      actionId: `action:${TASK_ID}:evt-release-0001`,
      eventId: 'evt-release-0001',
      type: 'release_candidate_ready',
      status: 'handled',
      title: 'Approve RC',
      summary: 'Fresh review passed',
      allowedActions: ['approve', 'rework', 'block', 'cancel'],
      multicaIssue: 'TEP-73',
      githubPr: '23',
      headSha: HEAD_SHA,
      notificationId: 'msg-approval-0001',
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
    updatedAt: '2026-08-21T02:00:00.000Z',
  };
}

describe('release to complete-release workflow', () => {
  let harness: TestServiceContext;
  let candidateRoot: string;

  beforeEach(async () => {
    harness = await createTestServiceContext({ now: new Date('2026-08-21T03:02:00.000Z') });
    candidateRoot = await mkdtemp(join(tmpdir(), 'paw-release-completion-'));
    const buildDir = join(candidateRoot, 'apps', 'agent-task-loop', 'build', 'obsidian-plugin');
    await mkdir(buildDir, { recursive: true });
    await mkdir(join(candidateRoot, 'plugin'), { recursive: true });
    await writeFile(join(buildDir, 'manifest.json'), JSON.stringify({ id: 'agent-task-loop', version: '0.9.1' }));
    for (const file of ['main.js', 'atl-runner.mjs', 'atl-dingtalk-bridge.mjs', 'atl-dingtalk-stream.mjs']) {
      await writeFile(join(buildDir, file), `built ${file}`);
    }
    await writeFile(join(buildDir, 'qianwen-accessibility-helper'), 'built helper');
    await chmod(join(buildDir, 'qianwen-accessibility-helper'), 0o755);
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(candidateRoot, { recursive: true, force: true });
  });

  it('publishes once, completes once, and replays without duplicate external actions', async () => {
    await harness.ctx.tasks.save(reviewTask());
    const runtimeRoot = join(harness.root, '.atl-runtime');
    const phaseLedger = new FileReleasePhaseEvidenceLedger(runtimeRoot);
    const finalLedger = new FileReleaseReceiptLedger(runtimeRoot);
    const connector = new CountingReleaseConnector();
    const calls = { merge: 0, live: 0, notify: 0 };
    const releaseDependencies = {
      ledger: phaseLedger,
      invalidations: new FileReleaseInvalidationLedger(runtimeRoot),
      projectionMarkers: new FileReleaseProjectionMarkerStore(runtimeRoot),
      connector,
      ports: {
        verificationRunner: {
          run: async (argv: readonly string[]) => ({
            command: argv.join(' '),
            exitCode: 0,
            stdout: argv[1] === 'rev-parse' ? HEAD_SHA : '',
            stderr: '',
            durationMs: 1,
          }),
        },
        nodeVersion: 'v24.15.0',
        workDir: candidateRoot,
        mergeAcceptedPr: async () => {
          calls.merge += 1;
          return {
            repository: 'PANGKAIFENG/personal-ai-workbench',
            pr: '23',
            headSha: HEAD_SHA,
            mergeSha: MERGE_SHA,
            prStatus: 'merged',
            issueStatus: 'closed',
          };
        },
        liveVerification: async () => {
          calls.live += 1;
          return {
            canaryTaskId: 'task-canary-0001',
            multicaIssueId: ISSUE_ID,
            multicaRunId: 'run-canary-0001',
            dingTalkMessageId: 'msg-release-0001',
            dingTalkStreamEventId: 'stream-approve-0001',
            passed: true,
            summary: 'Synthetic live verification passed',
          };
        },
        notifyDingTalk: async () => {
          calls.notify += 1;
          return { messageId: 'msg-release-0001' };
        },
      },
    };
    const releaseInput = {
      taskId: TASK_ID,
      currentEvent: releaseEvent(),
      freshReviewRef: 'TEP-72',
      vaultRoot: harness.root,
      plugin: {
        pluginDir: join(candidateRoot, 'plugin'),
        backupRoot: join(candidateRoot, 'backups'),
      },
    };

    const released = await runReleaseOperator(harness.ctx, releaseDependencies, releaseInput);
    const releaseReplay = await runReleaseOperator(harness.ctx, releaseDependencies, releaseInput);
    expect(released.status).toBe('released');
    expect(releaseReplay.status).toBe('replayed');
    expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    expect(await finalLedger.list()).toEqual([]);

    if (released.status !== 'released') throw new Error('release phase did not complete');
    const phaseReceipt = released.receipt;
    const completedEvent: MulticaEvent = {
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
    };
    const task = await harness.ctx.tasks.get(TASK_ID);
    await harness.ctx.tasks.save({
      ...task,
      executionLink: {
        ...task.executionLink!,
        remoteState: 'completed',
        lastEventId: completedEvent.eventId,
        lastSyncedAt: '2026-08-21T03:01:00.000Z',
      },
    });
    const notifications = new FileMulticaActionNotificationLedger(runtimeRoot);
    await notifications.save({
      schemaVersion: 1,
      idempotencyKey: `multica:${TASK_ID}:evt-release-0001:release_candidate_ready`,
      taskId: TASK_ID,
      eventId: 'evt-release-0001',
      state: 'release_candidate_ready',
      uuid: '01234567-89ab-5cde-8f01-234567890abc',
      status: 'sent',
      attemptedAt: '2026-08-21T02:01:00.000Z',
      errorCode: null,
      messageId: 'msg-approval-0001',
      draftTitle: 'Approve RC',
      draftText: 'Fresh review passed',
    });
    const responses = new FileMulticaResponseLedger(runtimeRoot);
    await responses.save({
      schemaVersion: 1,
      streamEventId: 'stream-approve-0001',
      taskId: TASK_ID,
      eventId: 'evt-release-0001',
      actionId: `action:${TASK_ID}:evt-release-0001`,
      action: 'approve',
      message: 'approve',
      trust: { senderUserId: 'trusted', conversationId: 'trusted', trusted: true },
      step: 'release_operator_started',
      terminalStep: 'release_operator_started',
      rejectedReason: null,
      receivedAt: '2026-08-21T02:04:00.000Z',
      recordedAt: '2026-08-21T02:04:10.000Z',
      confirmedAt: '2026-08-21T02:04:20.000Z',
      resumedAt: '2026-08-21T02:05:00.000Z',
      responseCommentId: 'comment-response-0001',
      baselineRunIds: ['run-baseline'],
      runIds: ['run-release'],
      remoteWriteUnknown: null,
      lastError: null,
    });
    const acceptance = releaseAcceptanceForApproval({
      event: releaseEvent(),
      streamEventId: 'stream-approve-0001',
      freshReviewRef: 'TEP-72',
      acceptedAt: phaseReceipt.startedAt,
    });
    const finalReceipt = {
      ...phaseReceipt,
      completedAt: '2026-08-21T03:02:00.000Z',
      readBack: {
        ...phaseReceipt.readBack!,
        atl: { ...phaseReceipt.readBack!.atl, taskStatus: 'review' },
      },
      postDeployment: {
        completedEventId: completedEvent.eventId,
        completedEventOccurredAt: completedEvent.occurredAt,
        multicaIssueId: ISSUE_ID,
        multicaIssueIdentifier: 'TEP-73',
        multicaIssueStatus: 'done' as const,
        remoteState: 'completed' as const,
        notificationLedgerKey: `multica:${TASK_ID}:evt-release-0001:release_candidate_ready`,
        notificationMessageId: 'msg-approval-0001',
        responseLedgerStreamEventId: 'stream-approve-0001',
        responseCommentId: 'comment-response-0001',
        independentReviewRef: 'TEP-72',
        receiptMetadataKey: phaseReceipt.readBack!.multica.receiptMetadataKey,
        receiptMetadataValue: phaseReceipt.readBack!.multica.receiptMetadataValue,
        readAt: '2026-08-21T03:01:00.000Z',
      },
    };
    const completionDependencies = {
      ledger: finalLedger,
      completionIntents: new FileReleaseCompletionIntentLedger(runtimeRoot),
      phaseEvidence: phaseLedger,
      notifications,
      responses,
      atlReadBack: (current: Task) => ({
        ...phaseReceipt.readBack!.atl,
        taskStatus: current.status,
        frontmatterPath: join(
          harness.root,
          '10_Tasks',
          'Archive',
          current.updatedAt.slice(0, 4),
          `${current.taskId}.md`,
        ),
      }),
    };

    const completed = await completeRelease(harness.ctx, completionDependencies, {
      schemaVersion: 1,
      acceptance,
      completedEvent,
      receipt: finalReceipt,
    });
    const completionReplay = await completeRelease(harness.ctx, completionDependencies, {
      schemaVersion: 1,
      acceptance,
      completedEvent,
      receipt: finalReceipt,
    });

    expect(completed.status).toBe('completed');
    expect(completionReplay.status).toBe('replayed');
    expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('done');
    expect(await finalLedger.list()).toHaveLength(1);
    expect(await phaseLedger.list()).toHaveLength(1);
    expect(calls).toEqual({ merge: 1, live: 1, notify: 1 });
    expect(connector.metadataWrites).toBe(1);
  });
});
