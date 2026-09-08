import {
  multicaTaskMarker,
  type MulticaDispatchConnector,
  type MulticaDispatchEnvelope,
  type MulticaEnsureIssueResult,
} from '../connectors/multica-cli-connector.js';
import {
  executionLinkIdempotencyKey,
  isExecutionLinkActivationComplete,
  type ExecutionLink,
} from '../domain/execution-link.js';
import { contextRefSymlinkErrors } from '../domain/context-ref-resolution.js';
import {
  developmentDispatchErrors,
  isExternalExecutionTask,
  taskContextRefs,
  type Task,
} from '../domain/task.js';
import type { ServiceContext } from './service-context.js';

// PAW-GOAL-003 T1: the dispatch target is fixed by the accepted Goal scope
// (workspace teporal / project 个人工作台); it is injected so tests and the
// reconciliation cycle share one connector surface.
export interface MulticaDispatchTarget {
  workspaceId: string;
  projectId: string;
}

export interface DispatchDevelopmentTaskDependencies {
  connector: MulticaDispatchConnector;
  target: MulticaDispatchTarget;
  allowedContextRoots?: readonly string[];
}

export type DispatchOutcome =
  | {
    status: 'linked';
    taskId: string;
    issueId: string;
    issueIdentifier: string;
    recovered: boolean;
  }
  | {
    status: 'already_linked';
    taskId: string;
    issueId: string;
    issueIdentifier: string;
  }
  | { status: 'duplicate_conflict'; taskId: string; candidateIssueIds: string[] }
  | { status: 'remote_write_unknown'; taskId: string; reason: string }
  | { status: 'in_flight'; taskId: string; reason: string }
  | { status: 'failed'; taskId: string; reason: string };

// PAW-GOAL-003 T1 CR fix 1: `pending`/`resolving_remote` plus a fresh
// lastAttemptAt is the durable single-flight lease for the whole remote
// ensure. Every entry point (immediate authorization, manual dispatch,
// reconciliation) honors it: while it is fresh, a second dispatcher fails
// closed with an in-flight outcome and never touches the remote, so the
// remote ensure cannot overlap and create a duplicate issue. Once the lease
// goes stale (crashed dispatcher), the next attempt re-runs the idempotent
// metadata/marker recovery instead of a blind create.
//
// T1 FIX-3 (TEP-45 P1): the lease only delivers that guarantee while it is
// fresh, so the remote ensure must be hard-bounded inside it. The dispatcher
// derives the connector deadline from the very lease instant it persists
// (minus the margin below) and clamps any caller deadline to it; the
// connector clips every CLI call to the remaining budget and refuses to
// start once it is exhausted. A slow-but-legitimate ensure (deep board
// pagination, 20s per CLI call) therefore always terminates strictly before
// the lease can go stale — a competing entry can never age a live dispatcher
// into "stale" and start a second overlapping remote ensure, even when the
// entry point (immediate authorization, manual dispatch) carries no budget
// of its own.
export const MULTICA_DISPATCH_IN_FLIGHT_MS = 120_000;

// T1 FIX-3: the ensure deadline sits this far inside the lease expiry so the
// lease validity strictly exceeds the ensure's hard upper bound, leaving the
// owner a head start for its local write-back before a competing entry may
// reclaim the stale lease.
export const MULTICA_DISPATCH_ENSURE_MARGIN_MS = 5_000;

export function attemptAgeMs(lastAttemptAt: string | null | undefined, now: number): number {
  if (lastAttemptAt === null || lastAttemptAt === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(lastAttemptAt);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return now - parsed;
}

export class DevelopmentDispatchNotAdmittedError extends Error {
  readonly code = 'development_dispatch_not_admitted';
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super('Development task is not admissible for Multica dispatch');
    this.name = 'DevelopmentDispatchNotAdmittedError';
    this.errors = errors;
  }
}

export class DevelopmentDispatchWriteBackError extends Error {
  readonly code = 'development_dispatch_write_back_failed';
  readonly remoteResult: MulticaEnsureIssueResult;

  constructor(remoteResult: MulticaEnsureIssueResult) {
    super('Multica dispatch result could not be written back to the task');
    this.name = 'DevelopmentDispatchWriteBackError';
    this.remoteResult = remoteResult;
  }
}

export const MULTICA_DISPATCH_DESCRIPTION_LIMIT = 20_000;

export function buildDispatchEnvelope(
  task: Task,
  target: MulticaDispatchTarget,
  dispatchedAt: string,
): MulticaDispatchEnvelope {
  const idempotencyKey = executionLinkIdempotencyKey(task.taskId);
  const criteria = task.acceptanceCriteria
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion !== '');
  const lines = [
    multicaTaskMarker(idempotencyKey),
    '',
    '## ATL development task',
    `- task_id: ${task.taskId}`,
    `- project: ${task.projectId ?? ''}`,
    `- dispatched_at: ${dispatchedAt}`,
    '',
    '## Objective',
    task.objective ?? '',
    '',
    '## Acceptance criteria',
    ...criteria.map((criterion) => `- ${criterion}`),
    '',
    '## Context refs',
    ...taskContextRefs(task).map((ref) => `- ${ref}`),
    '',
    '## Dispatch target',
    `- workspace: ${target.workspaceId}`,
    `- project: ${target.projectId}`,
  ];
  return {
    idempotencyKey,
    title: task.title,
    description: lines.join('\n'),
  };
}

export function freshExecutionLink(
  taskId: string,
  target: MulticaDispatchTarget,
): ExecutionLink {
  return {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: executionLinkIdempotencyKey(taskId),
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    issueId: null,
    issueIdentifier: null,
    dispatchState: 'not_requested',
    remoteState: null,
    lastCommentId: null,
    lastEventId: null,
    summary: null,
    artifactRefs: [],
    lastAttemptAt: null,
    lastSyncedAt: null,
  };
}

function mergeEnsureResult(
  previous: ExecutionLink,
  result: MulticaEnsureIssueResult,
  timestamp: string,
): ExecutionLink {
  if (result.status === 'linked') {
    return {
      ...previous,
      issueId: result.ref.issueId,
      issueIdentifier: result.ref.issueIdentifier,
      activationAssigneeId: result.activation.assigneeId,
      activationRunId: result.activation.runId,
      dispatchState: 'linked',
      remoteState: 'active',
      lastSyncedAt: timestamp,
    };
  }
  return { ...previous, dispatchState: result.status };
}

function outcomeFor(taskId: string, result: MulticaEnsureIssueResult): DispatchOutcome {
  switch (result.status) {
    case 'linked':
      return {
        status: 'linked',
        taskId,
        issueId: result.ref.issueId,
        issueIdentifier: result.ref.issueIdentifier,
        recovered: result.recovered,
      };
    case 'duplicate_conflict':
      return {
        status: 'duplicate_conflict',
        taskId,
        candidateIssueIds: result.candidateIssueIds,
      };
    case 'remote_write_unknown':
    case 'failed':
      return { status: result.status, taskId, reason: result.reason };
  }
}

function detailsFor(
  result: MulticaEnsureIssueResult,
): Record<string, string | number | boolean | null> {
  if (result.status === 'linked') {
    return {
      issueId: result.ref.issueId,
      issueIdentifier: result.ref.issueIdentifier,
      recovered: result.recovered,
      activationAssigneeId: result.activation.assigneeId,
      activationRunId: result.activation.runId,
      activationRecovered: result.activation.recovered,
    };
  }
  if (result.status === 'duplicate_conflict') {
    return {
      candidateIssueIds: result.candidateIssueIds.join(','),
      candidateCount: result.candidateIssueIds.length,
    };
  }
  return { reason: result.reason.slice(0, 300) };
}

interface DispatchIntentResult {
  skipped: boolean;
  outcome: DispatchOutcome | null;
  task: Task;
}

export interface DispatchDevelopmentTaskOptions {
  /**
   * Absolute epoch-ms deadline shared with the caller's round budget. It is
   * an upper bound only: the dispatcher always clamps it to the lease bound
   * so the remote ensure can never outlive the single-flight lease (FIX-3).
   */
  deadlineAt?: number | undefined;
}

export async function dispatchDevelopmentTask(
  ctx: ServiceContext,
  dependencies: DispatchDevelopmentTaskDependencies,
  taskId: string,
  options: DispatchDevelopmentTaskOptions = {},
): Promise<DispatchOutcome> {
  const target = dependencies.target;

  // Phase 1 — admission and persisted intent, under the task lock. An
  // incomplete task never reaches the connector (fail closed).
  const intent: DispatchIntentResult = await ctx.tasks.withTaskLock(
    taskId,
    async (): Promise<DispatchIntentResult> => {
      const current = await ctx.tasks.get(taskId);
      if (!isExternalExecutionTask(current)) {
        throw new DevelopmentDispatchNotAdmittedError(['executionTarget must be multica']);
      }
      const errors = developmentDispatchErrors(
        current,
        dependencies.allowedContextRoots ?? [],
      );
      if (errors.length > 0) {
        throw new DevelopmentDispatchNotAdmittedError(errors);
      }
      // Filesystem containment runs at the dispatch gate: a context ref that
      // lexically sits inside an allowlisted root but resolves through a
      // symlink to outside it must not reach the remote issue.
      const symlinkErrors = await contextRefSymlinkErrors(
        taskContextRefs(current),
        dependencies.allowedContextRoots ?? [],
      );
      if (symlinkErrors.length > 0) {
        throw new DevelopmentDispatchNotAdmittedError(symlinkErrors);
      }
      const existing = current.executionLink ?? null;
      if (isExecutionLinkActivationComplete(existing) && existing !== null) {
        return {
          skipped: true,
          outcome: {
            status: 'already_linked',
            taskId,
            issueId: existing.issueId ?? '',
            issueIdentifier: existing.issueIdentifier ?? '',
          },
          task: current,
        };
      }
      if (existing?.dispatchState === 'duplicate_conflict') {
        return {
          skipped: true,
          outcome: {
            status: 'duplicate_conflict',
            taskId,
            candidateIssueIds: [],
          },
          task: current,
        };
      }
      if (
        existing !== null
        && (existing.dispatchState === 'pending' || existing.dispatchState === 'resolving_remote')
        && attemptAgeMs(existing.lastAttemptAt, ctx.clock().getTime()) < MULTICA_DISPATCH_IN_FLIGHT_MS
      ) {
        // Single-flight lease: another dispatcher owns the remote ensure.
        return {
          skipped: true,
          outcome: {
            status: 'in_flight',
            taskId,
            reason: `dispatch already in flight (state: ${existing.dispatchState}, lastAttemptAt: ${existing.lastAttemptAt ?? 'unknown'})`,
          },
          task: current,
        };
      }
      const timestamp = ctx.clock().toISOString();
      const pending: ExecutionLink = {
        ...(existing ?? freshExecutionLink(taskId, target)),
        dispatchState: 'pending',
        lastAttemptAt: timestamp,
      };
      await ctx.tasks.save({ ...current, executionLink: pending, updatedAt: timestamp });
      await ctx.audit.append({
        event: 'multica.dispatch_intent_saved',
        at: timestamp,
        taskId,
        details: { dispatchState: 'pending' },
      });
      return {
        skipped: false,
        outcome: null,
        task: { ...current, executionLink: pending },
      };
    },
  );
  if (intent.skipped && intent.outcome !== null) {
    return intent.outcome;
  }

  // Phase 2 — persist the remote-resolution intent before any CLI call so a
  // crash between phases is visible as resolving_remote, never as idle. The
  // persisted lastAttemptAt is the lease every competing entry checks, so the
  // same instant also bounds the remote ensure (FIX-3): the connector
  // deadline derived below sits a margin inside the lease expiry, and the
  // connector clips every CLI call to the remaining budget — the ensure
  // always terminates strictly before the lease can go stale.
  const leaseStartedAtMs = await ctx.tasks.withTaskLock(taskId, async () => {
    const current = await ctx.tasks.get(taskId);
    const leaseNow = ctx.clock();
    const timestamp = leaseNow.toISOString();
    await ctx.tasks.save({
      ...current,
      executionLink: {
        ...(current.executionLink ?? freshExecutionLink(taskId, target)),
        dispatchState: 'resolving_remote',
        lastAttemptAt: timestamp,
      },
      updatedAt: timestamp,
    });
    return leaseNow.getTime();
  });

  // Phase 3 — resolve or create the unique remote issue (outside the lock,
  // but exclusively owned: the fresh resolving_remote lease written in phase 2
  // fail-closes every competing entry point until the write-back lands, and
  // the lease-bounded deadline keeps that guarantee over the whole, possibly
  // multi-page, remote ensure — entry points carrying no budget of their own
  // (immediate authorization, manual dispatch) get the lease bound here).
  const ensureDeadlineAt = Math.min(
    options.deadlineAt ?? Number.POSITIVE_INFINITY,
    leaseStartedAtMs + MULTICA_DISPATCH_IN_FLIGHT_MS - MULTICA_DISPATCH_ENSURE_MARGIN_MS,
  );
  const dispatchedAt = ctx.clock().toISOString();
  const envelope = buildDispatchEnvelope(intent.task, target, dispatchedAt);
  const result = await dependencies.connector.ensureIssue(
    envelope,
    { deadlineAt: ensureDeadlineAt },
  );

  // Phase 4 — write the verified outcome back under the lock. A failure here
  // must surface the remote result: the issue may exist while the local
  // ledger does not know it yet (recovered by the next reconciliation).
  return applyEnsureResult(ctx, taskId, target, result);
}

export async function applyEnsureResult(
  ctx: ServiceContext,
  taskId: string,
  target: MulticaDispatchTarget,
  result: MulticaEnsureIssueResult,
): Promise<DispatchOutcome> {
  try {
    return await ctx.tasks.withTaskLock(taskId, async () => {
      const current = await ctx.tasks.get(taskId);
      const timestamp = ctx.clock().toISOString();
      const link = mergeEnsureResult(
        current.executionLink ?? freshExecutionLink(taskId, target),
        result,
        timestamp,
      );
      await ctx.tasks.save({ ...current, executionLink: link, updatedAt: timestamp });
      await ctx.audit.append({
        event: `multica.dispatch_${result.status}`,
        at: timestamp,
        taskId,
        details: detailsFor(result),
      });
      return outcomeFor(taskId, result);
    });
  } catch (error) {
    if (error instanceof DevelopmentDispatchWriteBackError) {
      throw error;
    }
    // The remote write happened; the local ledger write did not. Surface the
    // remote result so FI-01 recovery knows an issue may already exist.
    throw new DevelopmentDispatchWriteBackError(result);
  }
}
