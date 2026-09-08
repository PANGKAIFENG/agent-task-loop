import {
  chmod,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  MulticaResponseDraft,
} from '../../../src/connectors/multica-cli-connector.js';
import {
  MULTICA_RELEASE_RECEIPT_METADATA_KEY,
  multicaReleaseReceiptMetadataValue,
} from '../../../src/connectors/multica-cli-connector.js';
import type { ActionRequest } from '../../../src/domain/action-request.js';
import type { ExecutionLink } from '../../../src/domain/execution-link.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
import type { Task } from '../../../src/domain/task.js';
import type { ReleaseReceipt } from '../../../src/domain/release-receipt.js';
import {
  runReleaseOperator,
  type ReleaseOperatorPorts,
} from '../../../src/services/release-operator.js';
import {
  defaultPluginInstallIo,
  type PluginInstallIo,
} from '../../../src/services/plugin-install.js';
import {
  FileReleaseInvalidationLedger,
} from '../../../src/storage/file-release-invalidation-ledger.js';
import {
  FileReleaseProjectionMarkerStore,
} from '../../../src/storage/file-release-projection-marker.js';
import type {
  ReleaseReceiptLedger,
} from '../../../src/storage/file-release-receipt-ledger.js';
import {
  FileReleaseReceiptLedger,
} from '../../../src/storage/file-release-receipt-ledger.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const TASK_ID = 'task-20260821-rel00001';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

interface StoredComment {
  commentId: string;
  body: string;
}

// T3.1 fake: the release surface records the receipt through issue METADATA
// and must never add a comment or trigger a run. The fake mirrors the real
// channel's semantics (typed row, byte-equal dedup, fail-closed conflicts)
// and keeps counters that let every test assert the comment/run invariants.
class FakeReleaseConnector implements MulticaReleaseConnector {
  comments: StoredComment[] = [];
  /** Issue id -> receipt reference recorded under the controlled key. */
  readonly metadata = new Map<string, string>();
  commentAddAttempts = 0;
  runTriggerAttempts = 0;

  async listComments(): Promise<MulticaCommentPage> {
    return {
      comments: this.comments.map((comment, index) => ({
        commentId: comment.commentId,
        parentCommentId: null,
        body: comment.body,
        createdAt: `2026-08-21T02:0${index}:00.000Z`,
        authorType: 'agent',
      })),
    };
  }

  async appendResponse(
    _issueId: string,
    response: MulticaResponseDraft,
  ): Promise<MulticaAppendResponseResult> {
    this.commentAddAttempts += 1;
    const marker = `[ATL_RESPONSE:${response.streamEventId}]`;
    const existing = this.comments.find((comment) => comment.body.includes(marker));
    if (existing !== undefined) {
      return { commentId: existing.commentId, deduplicated: true };
    }
    const commentId = `cmt-${String(this.comments.length + 1).padStart(4, '0')}`;
    this.comments.push({ commentId, body: `${marker}\n\n${response.body}` });
    return { commentId, deduplicated: false };
  }

  async writeReleaseReceipt(
    issueId: string,
    receipt: { receiptId: string; body: string },
  ): Promise<MulticaReleaseReceiptWriteResult> {
    const value = multicaReleaseReceiptMetadataValue(receipt);
    const existing = this.metadata.get(issueId);
    if (existing === value) {
      return {
        status: 'written',
        metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
        metadataValue: value,
        deduplicated: true,
      };
    }
    if (existing !== undefined) {
      let reference: { receipt_id?: string } | null = null;
      try {
        reference = JSON.parse(existing) as { receipt_id?: string };
      } catch {
        reference = null;
      }
      if (reference === null || reference.receipt_id === receipt.receiptId) {
        return {
          status: 'receipt_conflict',
          reason: `issue already records a different value for receipt ${receipt.receiptId}`,
        };
      }
    }
    this.metadata.set(issueId, value);
    return {
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: value,
      deduplicated: false,
    };
  }

  async resume(): Promise<MulticaResumeResult> {
    this.runTriggerAttempts += 1;
    throw new Error('resume is not part of the release surface');
  }

  async runIds(): Promise<string[]> {
    return Promise.resolve(['run-0001']);
  }

  async ensureIssue(): Promise<MulticaEnsureIssueResult> {
    throw new Error('ensureIssue is not part of the release surface');
  }

  async inspect(): Promise<MulticaIssueSnapshot> {
    throw new Error('inspect is not part of the release surface');
  }
}

function rcEvent(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-rc-0001',
    atlTaskId: TASK_ID,
    state: 'release_candidate_ready',
    summary: 'Fresh CR passed on the immutable candidate',
    decision: null,
    recoverability: null,
    artifactRefs: [],
    release: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      issue: null,
      pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
      headSha: HEAD_SHA,
    },
    occurredAt: '2026-08-21T02:00:00.000Z',
    ...overrides,
  };
}

function handledApproveRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    schemaVersion: 1,
    actionId: `action:${TASK_ID}:evt-rc-0001`,
    eventId: 'evt-rc-0001',
    type: 'release_candidate_ready',
    status: 'handled',
    title: 'RC 待验收：接受并发布',
    summary: 'Fresh CR passed on the immutable candidate',
    allowedActions: ['approve', 'rework', 'block', 'cancel'],
    multicaIssue: 'TEP-53',
    githubPr: '16',
    headSha: HEAD_SHA,
    notificationId: 'msg-notify-0001',
    handledStreamEventId: 'stream-approve-0001',
    handledTerminalStep: 'release_operator_started',
    ...overrides,
  };
}

function releasedTask(overrides: Partial<Task> = {}): Task {
  const executionLink: ExecutionLink = {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: `atl:${TASK_ID}`,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    issueId: ISSUE_ID,
    issueIdentifier: 'TEP-53',
    dispatchState: 'linked',
    remoteState: 'release_candidate_ready',
    lastCommentId: 'cmt-0001',
    lastEventId: 'evt-rc-0001',
    summary: null,
    artifactRefs: [],
    lastAttemptAt: '2026-08-21T01:00:00.000Z',
    lastSyncedAt: '2026-08-21T02:00:00.000Z',
  };
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'RC 与发布回读',
    body: '',
    status: 'review',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Publish the accepted RC and read back every system',
    acceptanceCriteria: ['Receipt complete and consistent with the accepted RC SHA'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    executionLink,
    actionRequest: handledApproveRequest(),
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
    ...overrides,
  };
}

function passingVerificationRunner(): ReleaseOperatorPorts['verificationRunner'] {
  const run = async (argv: readonly string[]) => ({
    command: argv.join(' '),
    exitCode: 0,
    stdout: argv[1] === 'rev-parse' ? HEAD_SHA : '',
    stderr: '',
    durationMs: 1,
  });
  return { run: async (argv) => run(argv) };
}

function passingPorts(overrides: Partial<ReleaseOperatorPorts> = {}): ReleaseOperatorPorts {
  return {
    verificationRunner: passingVerificationRunner(),
    nodeVersion: 'v24.15.0',
    workDir: '/candidate-checkout',
    mergeAcceptedPr: async () => ({
      repository: 'PANGKAIFENG/personal-ai-workbench',
      pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      prStatus: 'merged',
      issueStatus: 'closed',
    }),
    liveVerification: async () => ({
      canaryTaskId: 'task-20260821-canary001',
      multicaIssueId: ISSUE_ID,
      multicaRunId: 'run-0001',
      dingTalkMessageId: 'msg-notice-0001',
      dingTalkStreamEventId: 'stream-approve-0001',
      passed: true,
      summary: 'canary projected its terminal event and read back every system',
    }),
    notifyDingTalk: async () => ({ messageId: 'msg-notice-0001' }),
    ...overrides,
  };
}

describe('runReleaseOperator', () => {
  let harness: TestServiceContext;
  let pluginRoot: string;
  let connector: FakeReleaseConnector;
  let ledger: FileReleaseReceiptLedger;
  let invalidations: FileReleaseInvalidationLedger;
  let projectionMarkers: FileReleaseProjectionMarkerStore;

  beforeEach(async () => {
    harness = await createTestServiceContext();
    pluginRoot = await mkdtemp(join(tmpdir(), 'paw-t3-release-'));
    const buildDir = join(
      pluginRoot,
      'apps',
      'agent-task-loop',
      'build',
      'obsidian-plugin',
    );
    await mkdir(buildDir, { recursive: true });
    await mkdir(join(pluginRoot, 'plugins', 'agent-task-loop'), { recursive: true });
    await writeFile(
      join(buildDir, 'manifest.json'),
      `${JSON.stringify({ id: 'agent-task-loop', version: '0.9.1' })}\n`,
    );
    await writeFile(join(buildDir, 'main.js'), 'built main bytes');
    await writeFile(join(buildDir, 'atl-runner.mjs'), 'built runner bytes');
    await writeFile(join(buildDir, 'atl-dingtalk-bridge.mjs'), 'built bridge bytes');
    await writeFile(join(buildDir, 'atl-dingtalk-stream.mjs'), 'built stream bytes');
    await writeFile(join(buildDir, 'qianwen-accessibility-helper'), 'built qianwen helper');
    await chmod(join(buildDir, 'qianwen-accessibility-helper'), 0o755);
    await writeFile(
      join(pluginRoot, 'plugins', 'agent-task-loop', 'main.js'),
      'old main bytes',
    );
    connector = new FakeReleaseConnector();
    ledger = new FileReleaseReceiptLedger(join(harness.root, '.atl-runtime'));
    invalidations = new FileReleaseInvalidationLedger(join(harness.root, '.atl-runtime'));
    projectionMarkers = new FileReleaseProjectionMarkerStore(join(harness.root, '.atl-runtime'));
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(pluginRoot, { recursive: true, force: true });
    await rm(`${pluginRoot}-outside-build`, { recursive: true, force: true });
  });

  function dependencies(ports: ReleaseOperatorPorts = passingPorts()) {
    ports.workDir = pluginRoot;
    return { ledger, invalidations, projectionMarkers, connector, ports };
  }

  function pluginInput() {
    return {
      pluginDir: join(pluginRoot, 'plugins', 'agent-task-loop'),
      backupRoot: join(pluginRoot, 'backups'),
    };
  }

  it('publishes an accepted RC while leaving final receipt and done projection to complete-release', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const outcome = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('released');
    const receipt = outcome.status === 'released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('passed');
    expect(receipt?.merge?.mergeSha).toBe(MERGE_SHA);
    expect(receipt?.plugin?.install?.version).toBe('0.9.1');
    expect(receipt?.readBack?.atl.taskStatus).toBe('review');
    expect(receipt?.readBack?.multica.receiptMetadataKey).toBe(MULTICA_RELEASE_RECEIPT_METADATA_KEY);
    const reference = JSON.parse(receipt?.readBack?.multica.receiptMetadataValue ?? '{}') as {
      schema_version?: number;
      receipt_id?: string;
      body?: string;
    };
    expect(reference.schema_version).toBe(1);
    expect(reference.receipt_id).toBe(receipt?.receiptId);
    expect(reference.body).toContain('ATL 发布完成');
    expect(receipt?.readBack?.dingtalk.messageId).toBe('msg-notice-0001');
    // T3.1 invariants: the receipt went through issue metadata only — no
    // comment was written and no run was triggered on the connector surface.
    expect(connector.metadata.get(ISSUE_ID)).toBe(receipt?.readBack?.multica.receiptMetadataValue);
    expect(connector.comments).toEqual([]);
    expect(connector.commentAddAttempts).toBe(0);
    expect(connector.runTriggerAttempts).toBe(0);

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    expect(task.executionLink?.remoteState).toBe('release_candidate_ready');
    expect(await ledger.get(receipt!.acceptanceId)).toEqual(receipt);
  });

  it('replays a persisted receipt without re-executing release actions', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const first = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    const commentsAfterFirst = connector.comments.length;

    const second = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    expect(second.status).toBe('replayed');
    expect(connector.comments.length).toBe(commentsAfterFirst);
    expect(first.status).toBe('released');
  });

  it('rejects a stale acceptance: newer RC event means no publish', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const ports = passingPorts();
    const calls: string[] = [];
    ports.verificationRunner = {
      run: async (argv) => {
        calls.push(argv.join(' '));
        return { command: argv.join(' '), exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
      },
    };
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent({
        eventId: 'evt-rc-0002',
        occurredAt: '2026-08-21T03:00:00.000Z',
      }),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('stale_rejected');
    expect(receipt?.rejectionReason).toContain('stale_event');
    expect(receipt?.verification).toBeNull();
    expect(calls).toEqual([]);
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });

  it('rejects a stale head SHA on the same event id', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const outcome = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent({
        release: {
          repository: 'PANGKAIFENG/personal-ai-workbench',
          issue: null,
          pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
          headSha: 'b'.repeat(40),
        },
      }),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('stale_rejected');
    expect(receipt?.rejectionReason).toContain('stale_head_sha');
  });

  it('stops before merge and install when the fixed verification fails', async () => {
    await harness.ctx.tasks.save(releasedTask());
    let merged = false;
    const ports = passingPorts({
      verificationRunner: {
        run: async (argv) => ({
          command: argv.join(' '),
          exitCode: argv[0] === 'git' ? 0 : 1,
          stdout: argv[1] === 'rev-parse' ? HEAD_SHA : '',
          stderr: 'suite failed',
          durationMs: 1,
        }),
      },
      mergeAcceptedPr: async () => {
        merged = true;
        throw new Error('must not be reached');
      },
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(merged).toBe(false);
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('verification_failed');
    expect(receipt?.verification?.commands.at(-1)?.exitCode).toBe(1);
    expect(receipt?.merge).toBeNull();
    expect(receipt?.plugin).toBeNull();
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });

  it('rejects an uncommitted candidate before merge and install even when HEAD matches', async () => {
    await harness.ctx.tasks.save(releasedTask());
    let merged = false;
    const ports = passingPorts({
      verificationRunner: {
        run: async (argv) => ({
          command: argv.join(' '),
          exitCode: 0,
          stdout: argv[1] === 'rev-parse'
            ? HEAD_SHA
            : argv[1] === 'status'
              ? ' M apps/agent-task-loop/src/services/release-operator.ts\n'
              : '',
          stderr: '',
          durationMs: 1,
        }),
      },
      mergeAcceptedPr: async () => {
        merged = true;
        throw new Error('must not be reached');
      },
    });

    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(merged).toBe(false);
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('verification_failed');
    expect(receipt?.rejectionReason).toContain('worktree must be clean');
    expect(receipt?.verification?.candidateCheck?.cleanBefore).toBe(false);
    expect(receipt?.merge).toBeNull();
    expect(receipt?.plugin).toBeNull();
  });

  it('rejects a build directory that escapes the verified worktree through a symlink', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const expectedBuild = join(
      pluginRoot,
      'apps',
      'agent-task-loop',
      'build',
      'obsidian-plugin',
    );
    const outsideBuild = `${pluginRoot}-outside-build`;
    await rename(expectedBuild, outsideBuild);
    await symlink(outsideBuild, expectedBuild, 'dir');
    let mergeCalls = 0;
    const ports = passingPorts({
      mergeAcceptedPr: async () => {
        mergeCalls += 1;
        throw new Error('must not merge');
      },
    });

    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('readiness_rejected');
    expect(receipt?.rejectionReason).toContain('verified worktree');
    expect(mergeCalls).toBe(0);
    expect(receipt?.merge).toBeNull();
    expect(receipt?.plugin).toBeNull();
  });

  it('rolls the plugin back byte-for-byte when live verification fails', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const ports = passingPorts({
      liveVerification: async () => ({
        canaryTaskId: 'task-20260821-canary001',
        multicaIssueId: ISSUE_ID,
        multicaRunId: null,
        dingTalkMessageId: null,
        dingTalkStreamEventId: null,
        passed: false,
        summary: 'canary never projected its terminal event',
      }),
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.plugin?.rollback?.restoredFiles.map((file) => file.path)).toContain('main.js');
    const { readFile } = await import('node:fs/promises');
    expect(
      await readFile(join(pluginInput().pluginDir, 'main.js'), 'utf8'),
    ).toBe('old main bytes');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    expect(receipt?.readBack).toBeNull();
  });

  it('rejects a task without a handled RC approve or outside review', async () => {
    await harness.ctx.tasks.save(releasedTask({
      actionRequest: null,
    }));
    const noApprove = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    expect(noApprove.status).toBe('rejected');

    await harness.ctx.tasks.save(releasedTask({
      actionRequest: handledApproveRequest(),
      status: 'agent_executable',
    }));
    const notInReview = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    expect(notInReview).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('review'),
    });
  });

  it('rejects merge evidence inconsistent with the accepted release', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const ports = passingPorts({
      mergeAcceptedPr: async () => ({
        repository: 'PANGKAIFENG/personal-ai-workbench',
        pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
        headSha: 'b'.repeat(40),
        mergeSha: MERGE_SHA,
        prStatus: 'open',
        issueStatus: 'open',
      }),
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('readiness_rejected');
    expect(receipt?.plugin).toBeNull();
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });

  it('persists a schema-valid receipt for every terminal path', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const outcome = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent({ eventId: 'evt-rc-0009' }),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });
    expect(outcome.status).toBe('not_released');
    const stored: ReleaseReceipt[] = await ledger.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('stale_rejected');
  });

  it('rolls the plugin back and keeps the task in review when the dingtalk notice fails', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const ports = passingPorts({
      notifyDingTalk: async () => {
        throw new Error('dingtalk unreachable');
      },
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('dingtalk');
    expect(receipt?.plugin?.rollback?.restoredFiles.map((file) => file.path))
      .toContain('main.js');
    expect(receipt?.readBack).toBeNull();
    const { readFile } = await import('node:fs/promises');
    expect(
      await readFile(join(pluginInput().pluginDir, 'main.js'), 'utf8'),
    ).toBe('old main bytes');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });

  it('keeps the task in review when the receipt has gaps (blank dingtalk message id)', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const ports = passingPorts({
      notifyDingTalk: async () => ({ messageId: '   ' }),
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('release receipt incomplete');
    expect(receipt?.readBack?.dingtalk.messageId).toBe('   ');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    const stored = await ledger.get(receipt!.acceptanceId);
    expect(stored?.status).toBe('rolled_back');
    expect(stored?.plugin?.rollback?.restoredFiles.map((file) => file.path))
      .toContain('main.js');
  });

  it('keeps the task in review and restores the plugin when the ledger save fails', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const failingLedger: ReleaseReceiptLedger = {
      get: (acceptanceId) => ledger.get(acceptanceId),
      list: () => ledger.list(),
      save: async () => {
        throw new Error('ledger disk full');
      },
    };
    const outcome = await runReleaseOperator(harness.ctx, {
      ledger: failingLedger,
      invalidations,
      projectionMarkers,
      connector,
      ports: passingPorts({ workDir: pluginRoot }),
    }, {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('ledger');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    const { readFile } = await import('node:fs/promises');
    expect(
      await readFile(join(pluginInput().pluginDir, 'main.js'), 'utf8'),
    ).toBe('old main bytes');
    expect(await ledger.list()).toEqual([]);
  });



  it('rolls the plugin back when the receipt metadata write throws', async () => {
    await harness.ctx.tasks.save(releasedTask());
    connector.writeReleaseReceipt = async () => {
      throw new Error('multica cli transient failure');
    };
    const outcome = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('release receipt metadata write threw');
    expect(receipt?.readBack).toBeNull();
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    const { readFile } = await import('node:fs/promises');
    expect(
      await readFile(join(pluginInput().pluginDir, 'main.js'), 'utf8'),
    ).toBe('old main bytes');
  });

  it('rolls the plugin back when the receipt metadata reports a conflict', async () => {
    await harness.ctx.tasks.save(releasedTask());
    connector.writeReleaseReceipt = async () => ({
      status: 'receipt_conflict',
      reason: 'issue already records a different value for the receipt',
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('release receipt metadata write');
    expect(receipt?.rejectionReason).toContain('already records a different value');
    // No comment, no run: the conflict stayed on the metadata surface.
    expect(connector.comments).toEqual([]);
    expect(connector.commentAddAttempts).toBe(0);
    expect(connector.runTriggerAttempts).toBe(0);
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });

  it('still persists a terminal receipt when the rollback drill itself fails', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const { readdir } = await import('node:fs/promises');
    const ports = passingPorts({
      notifyDingTalk: async () => {
        // Tamper the fresh backup so the rollback restore-hash check fails,
        // then fail the notification: both failures must reach the receipt.
        const entries = await readdir(pluginInput().backupRoot);
        const backupDir = entries[0];
        if (backupDir === undefined) {
          throw new Error('backup directory missing');
        }
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(pluginInput().backupRoot, backupDir, 'main.js'), 'tampered backup bytes');
        throw new Error('dingtalk unreachable');
      },
    });
    const outcome = await runReleaseOperator(harness.ctx, dependencies(ports), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.rejectionReason).toContain('dingtalk');
    expect(receipt?.rejectionReason).toContain('rollback drill failed');
    expect(receipt?.plugin?.rollback).toBeNull();
    const stored = await ledger.get(receipt!.acceptanceId);
    expect(stored?.status).toBe('rolled_back');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
  });



  it('records the partial-write rollback evidence when the install itself fails mid-copy', async () => {
    await harness.ctx.tasks.save(releasedTask());
    const midCopyIo: PluginInstallIo = {
      copyFile: async (source, target) => {
        if (target === join(pluginInput().pluginDir, 'manifest.json')) {
          throw new Error('EIO: copy torn mid-write');
        }
        await defaultPluginInstallIo.copyFile(source, target);
      },
      readFile: (path) => defaultPluginInstallIo.readFile(path),
    };
    const outcome = await runReleaseOperator(harness.ctx, dependencies(passingPorts({
      pluginInstallIo: midCopyIo,
    })), {
      taskId: TASK_ID,
      currentEvent: rcEvent(),
      freshReviewRef: 'TEP-51',
      vaultRoot: harness.root,
      plugin: pluginInput(),
    });

    expect(outcome.status).toBe('not_released');
    const receipt = outcome.status === 'not_released' ? outcome.receipt : null;
    expect(receipt?.status).toBe('rolled_back');
    expect(receipt?.plugin?.install).toBeNull();
    expect(receipt?.plugin?.rollback?.restoredFiles.map((file) => file.path))
      .toContain('main.js');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('review');
    const { readFile } = await import('node:fs/promises');
    const { lstat } = await import('node:fs/promises');
    expect(
      await readFile(join(pluginInput().pluginDir, 'main.js'), 'utf8'),
    ).toBe('old main bytes');
    await expect(lstat(join(pluginInput().pluginDir, 'manifest.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  // CR2 (TEP-55) sole P1 — the combined post-passed failure: the passed
  // receipt is already durable, then the task projection fails, the rollback
  // source fails WITHOUT touching the installed bytes, and the terminal
  // rolled_back overwrite of the receipt ledger fails too. The ledger still
  // says passed and the plugin still hashes to the receipt — every signal a
  // naive replay trusts is a lie. Only the invalidation record (a durable
  // store independent of the receipt ledger) keeps the next replay from
  // projecting the review task done.



  // CR3 (TEP-56) sole P1 — the four-way post-passed failure: the CR2 triple
  // failure PLUS the invalidation write failing too. Every durable
  // invalidation signal is gone: the ledger still says passed, the installed
  // plugin still hashes to the receipt, and the invalidation store reads
  // back clean and empty. Only the write-ahead projection marker — armed
  // BEFORE the passed receipt was ever persisted, resolved only after a
  // confirmed done projection — keeps the next healthy replay from
  // projecting the review task done.




});
