import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  RELEASE_ACTIONS,
  releaseAcceptanceForApproval,
  releaseActionsDigest,
  releaseAcceptanceId,
  releaseApprovalReadinessGaps,
  validateReleaseCurrency,
  type ReleaseCandidateAcceptance,
} from '../domain/release-acceptance.js';
import {
  releasePhaseEvidenceGaps,
  type LiveVerificationReceipt,
  type MergeReadBack,
  type PluginBackupReceipt,
  type PluginInstallReceipt,
  type PluginRollbackReceipt,
  type ReleaseReceipt,
  type ReleaseReceiptStatus,
  type ReleaseReadBack,
} from '../domain/release-receipt.js';
import type { ActionRequest } from '../domain/action-request.js';
import type { Task } from '../domain/task.js';
import type { MulticaEvent } from '../domain/multica-event.js';
import type { MulticaReleaseConnector } from '../connectors/multica-cli-connector.js';
import type { ReleaseInvalidationLedger } from '../storage/file-release-invalidation-ledger.js';
import type { ReleaseProjectionMarkerStore } from '../storage/file-release-projection-marker.js';
import type { ReleaseReceiptLedger } from '../storage/file-release-receipt-ledger.js';
import { lifecycleDirectory, taskStorageRoot } from '../storage/task-paths.js';
import type { ServiceContext } from './service-context.js';
import {
  backupExistingPlugin,
  defaultPluginInstallIo,
  installPluginBuild,
  PluginInstallPartialWriteError,
  rollbackPlugin,
  type PluginInstallIo,
} from './plugin-install.js';
import {
  FIXED_VERIFICATION_COMMANDS,
  runFixedVerification,
  type VerificationRunner,
} from './release-verification.js';

// PAW-GOAL-003 T3 (Goal §9 / TECH §3.1 + §9): the Release Operator consumes
// one approved RC acceptance, re-validates it against the CURRENT event and
// head SHA, runs the fixed verification from the immutable candidate, then
// executes exactly the four fixed actions behind a controlled boundary. The
// task only leaves review for done when the Release Receipt is complete and
// consistent with the accepted RC SHA; any post-install failure restores the
// backed-up plugin and keeps the failure evidence.
export interface ReleaseOperatorPorts {
  verificationRunner: VerificationRunner;
  nodeVersion: string;
  /** Worktree checked out at the accepted immutable head SHA. */
  workDir: string;
  /** Controlled boundary: authorized merge evidence with read-back. */
  mergeAcceptedPr(input: {
    repository: string;
    pr: string;
    headSha: string;
  }): Promise<MergeReadBack>;
  /** Minimal synthetic live Task canary evidence with its read-back refs. */
  liveVerification(input: {
    acceptance: ReleaseCandidateAcceptance;
  }): Promise<LiveVerificationReceipt>;
  /** DingTalk acceptance notice — returns the read-back message id. */
  notifyDingTalk(input: { message: string }): Promise<{ messageId: string }>;
  /**
   * Filesystem seam for the plugin install — tests inject mid-copy
   * failures. Optional: production uses the real filesystem.
   */
  pluginInstallIo?: PluginInstallIo;
}

export interface ReleaseOperatorInput {
  taskId: string;
  /** The CURRENT release event re-read from the remote before this run. */
  currentEvent: MulticaEvent;
  freshReviewRef: string;
  vaultRoot: string;
  plugin: {
    pluginDir: string;
    backupRoot: string;
  };
}

export type ReleaseOperatorOutcome =
  | { status: 'released'; receipt: ReleaseReceipt }
  | { status: 'replayed'; receipt: ReleaseReceipt }
  | { status: 'rejected'; reason: string }
  | { status: 'not_released'; receipt: ReleaseReceipt };

type ReleaseReceiptPatch = Partial<Pick<ReleaseReceipt,
  'rejectionReason' | 'verification' | 'merge' | 'plugin' | 'liveVerification' | 'readBack'>>;

export interface ReleaseOperatorDependencies {
  ledger: ReleaseReceiptLedger;
  /** Legacy dependency retained for callers compiled against the prior contract. */
  invalidations?: ReleaseInvalidationLedger;
  /** Legacy dependency retained for callers compiled against the prior contract. */
  projectionMarkers?: ReleaseProjectionMarkerStore;
  connector: MulticaReleaseConnector;
  ports: ReleaseOperatorPorts;
}

function findApprovedRequest(task: Task): ActionRequest | null {
  const candidates = [
    task.actionRequest ?? null,
    ...(task.handledActionRequests ?? []),
  ];
  return candidates.find((request) => (
    request !== null
    && request.status === 'handled'
    && request.type === 'release_candidate_ready'
    && request.handledTerminalStep === 'release_operator_started'
    && request.handledStreamEventId !== null
  )) ?? null;
}

// Bounded, control-character-free notice body for DingTalk and the Multica
// receipt metadata reference — no transcript, no secrets (PRD 4.4).
function releaseNoticeBody(input: {
  acceptance: ReleaseCandidateAcceptance;
  merge: MergeReadBack;
  pluginVersion: string;
}): string {
  return [
    'ATL 发布完成，Release Receipt 已生成并回读。',
    `- repository: ${input.merge.repository}`,
    `- merge_sha: ${input.merge.mergeSha}`,
    `- head_sha: ${input.acceptance.headSha}`,
    `- plugin_version: ${input.pluginVersion}`,
    `- acceptance: ${input.acceptance.acceptanceId}`,
  ].join('\n');
}

// The ATL read-back always describes the task's ACTUAL persisted state and
// its real frontmatter path — never the projection a failed run intended
// (TEP-54 fix round: rolled-back receipts must not claim a done ATL task).
function atlReadBack(
  task: Task,
  vaultRoot: string,
  finalSummary: string,
): ReleaseReadBack['atl'] {
  return {
    taskId: task.taskId,
    taskStatus: task.status,
    frontmatterPath: join(
      lifecycleDirectory(taskStorageRoot(vaultRoot), task),
      `${task.taskId}.md`,
    ),
    finalSummary,
  };
}

const VERIFIED_PLUGIN_BUILD_RELATIVE = join(
  'apps',
  'agent-task-loop',
  'build',
  'obsidian-plugin',
);

/**
 * The install source is derived from the same checkout whose immutable HEAD
 * passed fixed verification. Resolving both paths rejects a symlink in any
 * build-path component, including one that points outside the candidate.
 */
async function verifiedPluginBuildDir(workDir: string): Promise<string> {
  const canonicalWorkDir = await realpath(workDir);
  const expectedBuildDir = resolve(workDir, VERIFIED_PLUGIN_BUILD_RELATIVE);
  const canonicalExpectedBuildDir = join(canonicalWorkDir, VERIFIED_PLUGIN_BUILD_RELATIVE);
  const metadata = await lstat(expectedBuildDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('candidate plugin build is not a regular directory');
  }
  const canonicalBuildDir = await realpath(expectedBuildDir);
  if (canonicalBuildDir !== canonicalExpectedBuildDir) {
    throw new Error('candidate plugin build escapes the verified worktree');
  }
  return canonicalBuildDir;
}

/**
 * Executes one release acceptance. Order is fixed: currency -> readiness ->
 * verification (immutable head) -> merge read-back -> backup -> install ->
 * live canary -> receipt metadata write -> DingTalk notice -> release-phase
 * evidence validated and persisted. Every failure path persists terminal
 * release-phase evidence, performs the plugin rollback drill once an install
 * has landed, and keeps the task in review. Successful replay returns the
 * existing phase evidence without repeating external actions.
 */
export async function runReleaseOperator(
  ctx: ServiceContext,
  dependencies: ReleaseOperatorDependencies,
  input: ReleaseOperatorInput,
): Promise<ReleaseOperatorOutcome> {
  const task = await ctx.tasks.get(input.taskId);
  const approved = findApprovedRequest(task);
  if (
    approved === null
    || approved.handledStreamEventId === null
    || approved.headSha === null
  ) {
    return {
      status: 'rejected',
      reason: `task ${input.taskId} carries no handled RC approve`,
    };
  }
  // The ATL projection must still sit in review (approve keeps review until
  // the receipt completes) — anything else means the projection already moved
  // on and this acceptance must not execute. A PASSED receipt replays first:
  // re-running the operator on a finished release must never re-execute.
  const replayKey = releaseAcceptanceId({
    atlTaskId: task.taskId,
    eventId: approved.eventId,
    headSha: approved.headSha,
    releaseActions: RELEASE_ACTIONS,
  });
  const replayed = await dependencies.ledger.get(replayKey);
  if (replayed !== null && replayed.status === 'passed') {
    return { status: 'replayed', receipt: replayed };
  }
  if (task.status !== 'review') {
    return {
      status: 'rejected',
      reason: `approved release requires task in review, found ${task.status}`,
    };
  }

  const startedAt = ctx.clock().toISOString();
  const provisional: ReleaseCandidateAcceptance = {
    schemaVersion: 1,
    eventType: 'RELEASE_CANDIDATE_ACCEPTED',
    acceptanceId: releaseAcceptanceId({
      atlTaskId: task.taskId,
      eventId: approved.eventId,
      headSha: approved.headSha,
      releaseActions: RELEASE_ACTIONS,
    }),
    atlTaskId: task.taskId,
    eventId: approved.eventId,
    headSha: approved.headSha,
    releaseActions: [...RELEASE_ACTIONS],
    streamEventId: approved.handledStreamEventId,
    freshReviewRef: input.freshReviewRef,
    repository: input.currentEvent.release?.repository ?? null,
    githubIssue: input.currentEvent.release?.issue ?? null,
    githubPr: approved.githubPr,
    acceptedAt: startedAt,
  };

  const existing = await dependencies.ledger.get(provisional.acceptanceId);
  if (existing !== null && existing.status === 'passed') {
    return { status: 'replayed', receipt: existing };
  }

  const base = {
    schemaVersion: 1 as const,
    receiptId: `release-receipt:${provisional.acceptanceId}`,
    acceptanceId: provisional.acceptanceId,
    atlTaskId: task.taskId,
    eventId: provisional.eventId,
    headSha: provisional.headSha,
    startedAt,
    completedAt: startedAt,
    merge: null,
    plugin: null,
    liveVerification: null,
    readBack: null,
  };
  // Best-effort rollback evidence: set when the rollback drill itself throws
  // (declared early — every terminal finish() below reads it).
  let rollbackFailureNote: string | null = null;
  const buildReceipt = (
    status: ReleaseReceiptStatus,
    patch: ReleaseReceiptPatch = {},
  ): ReleaseReceipt => {
    // A failed rollback drill must never lose the terminal receipt: the
    // failure is folded into the rejection reason instead of throwing past
    // the ledger save (TEP-54 fix round).
    const reason = status !== 'passed' && rollbackFailureNote !== null
      ? `${patch.rejectionReason ?? 'release failed'}; ${rollbackFailureNote}`.slice(0, 400)
      : patch.rejectionReason ?? null;
    return {
      ...base,
      status,
      verification: null,
      ...patch,
      rejectionReason: reason,
      completedAt: ctx.clock().toISOString(),
    };
  };
  const finish = async (
    status: ReleaseReceiptStatus,
    patch: ReleaseReceiptPatch = {},
  ): Promise<ReleaseOperatorOutcome> => {
    const receipt = buildReceipt(status, patch);
    await dependencies.ledger.save(receipt);
    await audit(ctx, task.taskId, `multica.release_${status}`, receipt);
    return status === 'passed'
      ? { status: 'released', receipt }
      : { status: 'not_released', receipt };
  };
  // Terminal outcome for the one failure the receipt ledger itself reports:
  // persisting the evidence may fail exactly when saving did — the outcome
  // still returns with the in-memory receipt (TEP-54 P1-1).
  const finishBestEffort = async (
    status: ReleaseReceiptStatus,
    patch: ReleaseReceiptPatch = {},
  ): Promise<ReleaseOperatorOutcome> => {
    try {
      return await finish(status, patch);
    } catch {
      const receipt = buildReceipt(status, patch);
      await audit(ctx, task.taskId, `multica.release_${status}`, receipt);
      return { status: 'not_released', receipt };
    }
  };

  // 1 — current event / head-SHA / action-set validation. A stale acceptance
  // never publishes (TECH §3.1) and the failure is receipt evidence.
  const currency = validateReleaseCurrency(provisional, input.currentEvent);
  if (currency.status === 'stale') {
    return finish('stale_rejected', {
      rejectionReason: `${currency.code}: ${currency.reason}`.slice(0, 400),
    });
  }
  const acceptance = releaseAcceptanceForApproval({
    event: input.currentEvent,
    streamEventId: provisional.streamEventId,
    freshReviewRef: input.freshReviewRef,
    acceptedAt: startedAt,
  });

  // 2 — approve preconditions: repo, PR, immutable SHA, fresh CR, fixed suite.
  const gaps = releaseApprovalReadinessGaps({
    event: input.currentEvent,
    freshReviewRef: input.freshReviewRef,
    verificationCommands: FIXED_VERIFICATION_COMMANDS.map((argv) => argv.join(' ')),
  });
  if (gaps.length > 0) {
    return finish('readiness_rejected', {
      rejectionReason: gaps.join('; ').slice(0, 400),
    });
  }

  // 3 — fixed verification from the immutable candidate worktree.
  const verificationOutcome = await runFixedVerification({
    workDir: dependencies.ports.workDir,
    headSha: acceptance.headSha,
    nodeVersion: dependencies.ports.nodeVersion,
    runner: dependencies.ports.verificationRunner,
  });
  const verification = {
    nodeVersion: verificationOutcome.nodeVersion,
    headCheck: verificationOutcome.headCheck,
    candidateCheck: verificationOutcome.candidateCheck,
    commands: verificationOutcome.commands,
  };
  if (!verificationOutcome.passed) {
    const headMismatch = (verification.headCheck !== null && !verification.headCheck.matched)
      || verification.candidateCheck?.headMatchedAfter === false;
    const dirtyCandidate = verification.candidateCheck !== null
      && (!verification.candidateCheck.cleanBefore || verification.candidateCheck.cleanAfter === false);
    return finish(headMismatch ? 'stale_rejected' : 'verification_failed', {
      rejectionReason: headMismatch
        ? `stale_head_sha: worktree changed from accepted ${acceptance.headSha} during verification`
        : dirtyCandidate
          ? 'candidate worktree must be clean before and after fixed verification'
          : 'fixed verification recorded a failing command',
      verification,
    });
  }

  let buildDir: string;
  try {
    buildDir = await verifiedPluginBuildDir(dependencies.ports.workDir);
  } catch (error) {
    return finish('readiness_rejected', {
      rejectionReason: `candidate plugin build is not bound to the verified worktree: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 400),
      verification,
    });
  }

  // 4 — merge read-back behind the controlled boundary, still SHA-bound.
  const merge = await dependencies.ports.mergeAcceptedPr({
    repository: acceptance.repository ?? '',
    pr: acceptance.githubPr ?? '',
    headSha: acceptance.headSha,
  });
  if (
    merge.headSha !== acceptance.headSha
    || merge.prStatus !== 'merged'
    || (acceptance.repository !== null && merge.repository !== acceptance.repository)
    || (acceptance.githubPr !== null && merge.pr !== acceptance.githubPr)
  ) {
    return finish('readiness_rejected', {
      rejectionReason: `merge read-back inconsistent with the accepted release: ${merge.repository}#${merge.pr} @ ${merge.headSha} (${merge.prStatus})`.slice(0, 400),
      verification,
      merge,
    });
  }

  // 5 — plugin backup, then install with hash read-back. The install runs as
  // a provisional partial-install state (TEP-54 P1-2): a mid-copy/mid-hash/
  // mid-manifest failure restores the pre-install bytes itself and carries
  // the restore evidence; any LATER failure runs the rollback drill here.
  const backup: PluginBackupReceipt = await backupExistingPlugin({
    pluginDir: input.plugin.pluginDir,
    backupRoot: input.plugin.backupRoot,
    timestamp: startedAt,
  });
  let install: PluginInstallReceipt | null = null;
  let rollback: PluginRollbackReceipt | null = null;
  // Best effort by design: a rollback drill that itself throws is recorded
  // in the terminal receipt's rejection reason — it must never displace the
  // receipt persistence (TEP-54 fix round).
  const rollbackNow = async (): Promise<void> => {
    if (install === null) return;
    try {
      rollback = await rollbackPlugin({
        backup,
        install,
        rolledBackAt: ctx.clock().toISOString(),
      });
    } catch (error) {
      rollbackFailureNote = `rollback drill failed: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 200);
    }
  };
  try {
    install = await installPluginBuild({
      buildDir,
      pluginDir: input.plugin.pluginDir,
      installedAt: ctx.clock().toISOString(),
      backup,
      io: dependencies.ports.pluginInstallIo ?? defaultPluginInstallIo,
    });
  } catch (error) {
    // Install never landed: the partial-write rollback (if any write was
    // attempted) already ran inside installPluginBuild — record its receipt.
    rollback = error instanceof PluginInstallPartialWriteError
      ? error.rollbackReceipt
      : null;
    return finish('rolled_back', {
      rejectionReason: `plugin install failed and partial writes were rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install: null, rollback },
    });
  }

  // 6 — minimal synthetic live Task canary.
  let live: LiveVerificationReceipt;
  try {
    live = await dependencies.ports.liveVerification({ acceptance });
  } catch (error) {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `live verification failed and the plugin was rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
    });
  }
  if (!live.passed) {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `live verification did not pass: ${live.summary}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
    });
  }

  // 7 — Multica receipt METADATA write (T3.1 trusted system channel: typed,
  // idempotent, run-free — never a member comment) and DingTalk notice, then
  // the four-system read-back.
  const issueId = task.executionLink?.issueId ?? '';
  if (issueId === '') {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: 'task is not linked to a Multica issue',
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
    });
  }
  const noticeBody = releaseNoticeBody({
    acceptance,
    merge,
    pluginVersion: install.version,
  });
  // The receipt metadata write is inside the same protected path: a connector
  // that THROWS (transient CLI failure outside its returned-error surface)
  // still rolls the plugin back and persists terminal evidence — it can no
  // longer escape with a half release (TEP-54 fix round).
  let receiptWrite: Awaited<ReturnType<MulticaReleaseConnector['writeReleaseReceipt']>>;
  try {
    receiptWrite = await dependencies.connector.writeReleaseReceipt(issueId, {
      receiptId: base.receiptId,
      body: noticeBody,
    });
  } catch (error) {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `release receipt metadata write threw and the plugin was rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
    });
  }
  if (receiptWrite.status !== 'written') {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `release receipt metadata write: ${receiptWrite.reason}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
    });
  }
  // The DingTalk notice sits inside the protected rollback path (TEP-54
  // P1-1): a failed notification rolls the plugin back and leaves the task
  // recoverable in review — it never lets a half release pass silently.
  let notice: { messageId: string };
  try {
    notice = await dependencies.ports.notifyDingTalk({ message: noticeBody });
  } catch (error) {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `dingtalk notice failed and the plugin was rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
    });
  }

  // 8 — release-phase evidence gate. Final receipt persistence and the
  // review-to-done projection belong exclusively to `complete-release`.
  const receiptDraft: ReleaseReceipt = {
    ...base,
    status: 'passed',
    rejectionReason: null,
    verification,
    merge,
    plugin: { backup, install, rollback: null },
    liveVerification: live,
    readBack: {
      github: {
        repository: merge.repository,
        mergeSha: merge.mergeSha,
        prStatus: merge.prStatus,
        issueStatus: merge.issueStatus,
        headSha: acceptance.headSha,
      },
      multica: {
        issueId,
        issueIdentifier: task.executionLink?.issueIdentifier ?? '',
        receiptMetadataKey: receiptWrite.metadataKey,
        receiptMetadataValue: receiptWrite.metadataValue,
      },
      dingtalk: {
        messageId: notice.messageId,
        streamEventId: acceptance.streamEventId,
      },
      atl: atlReadBack(
        task,
        input.vaultRoot,
        `released ${merge.repository}@${merge.mergeSha.slice(0, 40)} with plugin ${install.manifest}@${install.version}`,
      ),
    },
    completedAt: ctx.clock().toISOString(),
  };
  // Failure receipts keep the factual external read-backs but describe the
  // ATL system as it actually is — the task never left review.
  const failedReadBack = (): ReleaseReadBack => ({
    ...receiptDraft.readBack!,
    atl: atlReadBack(
      task,
      input.vaultRoot,
      `release rolled back; ${merge.repository}@${merge.mergeSha.slice(0, 40)} was not published`,
    ),
  });
  const receiptGaps = releasePhaseEvidenceGaps(receiptDraft, acceptance);
  if (receiptGaps.length > 0) {
    await rollbackNow();
    return finish('rolled_back', {
      rejectionReason: `release receipt incomplete: ${receiptGaps.join('; ')}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
      readBack: failedReadBack(),
    });
  }
  try {
    await dependencies.ledger.save(receiptDraft);
  } catch (error) {
    await rollbackNow();
    return finishBestEffort('rolled_back', {
      rejectionReason: `release phase evidence save failed and the plugin was rolled back: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400),
      verification,
      merge,
      plugin: { backup, install, rollback },
      liveVerification: live,
      readBack: failedReadBack(),
    });
  }

  await audit(ctx, task.taskId, 'multica.release_passed', receiptDraft);
  return { status: 'released', receipt: receiptDraft };
}

async function audit(
  ctx: ServiceContext,
  taskId: string,
  event: string,
  receipt: ReleaseReceipt,
): Promise<void> {
  try {
    await ctx.audit.append({
      event,
      at: ctx.clock().toISOString(),
      taskId,
      details: {
        acceptanceId: receipt.acceptanceId,
        status: receipt.status,
        headSha: receipt.headSha,
        actionsDigest: releaseActionsDigest(RELEASE_ACTIONS).slice(0, 16),
      },
    });
  } catch {
    // Audit is evidence, not a gate — the phase/final ledger is authoritative.
  }
}
