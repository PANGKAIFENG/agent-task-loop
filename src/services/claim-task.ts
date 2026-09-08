import { z } from 'zod';

import { isExternalExecutionTask, readinessErrors, type Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export type ClaimMode = 'automatic' | 'manual';

export const AGENT_CLAIM_LOCK_KEY = 'claim-agent-global';

export interface ClaimTaskOptions {
  mode: ClaimMode;
  agent?: string;
  runId?: string;
  leaseMinutes?: number;
}

export interface ResolvedClaimTaskOptions {
  mode: ClaimMode;
  agent: string;
  runId: string;
  leaseMinutes: number;
}

export class InvalidClaimTaskOptionsError extends Error {
  readonly code = 'invalid_claim_task_options';

  constructor() {
    super('Invalid claim task options');
    this.name = 'InvalidClaimTaskOptionsError';
  }
}

export class ClaimTaskNotEligibleError extends Error {
  readonly code = 'task_not_eligible_for_claim';

  constructor() {
    super('Task is not eligible for claim');
    this.name = 'ClaimTaskNotEligibleError';
  }
}

// PAW-GOAL-003 T1 (PRD §6 rule 3): a task dispatched to Multica belongs to
// the remote execution loop. The local claim path (manual run included) must
// refuse it explicitly instead of folding the rejection into the generic
// research eligibility rule.
export class ClaimTaskExternalExecutionError extends Error {
  readonly code = 'task_claim_external_execution';

  constructor() {
    super('Task is executed externally via Multica and cannot be claimed locally');
    this.name = 'ClaimTaskExternalExecutionError';
  }
}

// Issue #3 / CR P1-3: an agent_executable task must be claim-free. A task
// that is otherwise admittable but still carries a claim is a contradiction
// (a stale claim was never released); claiming it would silently overwrite
// another run's claim, so the manual claim path surfaces this explicitly
// instead of folding it into the generic not-eligible error.
export class ClaimTaskUnexpectedClaimError extends Error {
  readonly code = 'unexpected_claim';

  constructor() {
    super('Task is agent_executable but still carries a claim');
    this.name = 'ClaimTaskUnexpectedClaimError';
  }
}

export class ClaimTaskAuditFailedError extends Error {
  readonly code = 'task_claim_audit_failed';

  constructor() {
    super('Task claim audit failed');
    this.name = 'ClaimTaskAuditFailedError';
  }
}

export class ClaimTaskRecoveryError extends Error {
  readonly code = 'task_claim_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task claim recovery required');
    this.name = 'ClaimTaskRecoveryError';
  }
}

const claimTaskOptionsSchema = z
  .object({
    mode: z.enum(['automatic', 'manual']),
    agent: z.string().min(1).max(200).optional(),
    runId: z.string().min(1).max(200).optional(),
    leaseMinutes: z.number().positive().finite().optional(),
  })
  .strict();

export function resolveClaimTaskOptions(
  options: ClaimTaskOptions,
): ResolvedClaimTaskOptions {
  const parsed = claimTaskOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new InvalidClaimTaskOptionsError();
  }
  return {
    mode: parsed.data.mode,
    agent: parsed.data.agent ?? 'manual',
    runId: parsed.data.runId ?? 'manual',
    leaseMinutes: parsed.data.leaseMinutes ?? 15,
  };
}

// The single agent-queue admission predicate (Issue #3): the runner's claim
// flow, the manual-run route, peeks and every statistics surface (home page,
// task index counts) must read this same rule. Tasks flagged as possible
// duplicates stay out of the queue until a human resolves the deduplication;
// tasks without a registered project (orphan/unknown) and tasks carrying an
// unparseable claim lease are rejected too — each with an explicit
// task-statistics quarantine reason, never silently admitted.
export type KnownProjectIds = ReadonlySet<string>;

export function hasInvalidClaimLease(task: Task): boolean {
  return task.claim !== null && !Number.isFinite(Date.parse(task.claim.leaseExpiresAt));
}

export function isClaimEligible(task: Task, knownProjectIds: KnownProjectIds): boolean {
  return !isExternalExecutionTask(task)
    && task.status === 'agent_executable'
    && task.reviewState === 'confirmed'
    && task.lastDecision?.continuationRunId !== null
    && readinessErrors(task).length === 0
    && task.possibleDuplicateIds.length === 0
    && task.claim === null
    && task.projectId !== null
    && knownProjectIds.has(task.projectId);
}

export async function loadKnownProjectIds(ctx: ServiceContext): Promise<KnownProjectIds> {
  return new Set((await ctx.projects.list()).map((project) => project.projectId));
}

export function localBusinessDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new InvalidClaimTaskOptionsError();
  }
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function automaticClaimSlotAvailable(
  ctx: ServiceContext,
): Promise<boolean> {
  return !(await ctx.tasks.list())
    .some((task) => task.status === 'in_progress' && task.claim !== null);
}

export async function claimTaskWithoutQuotaCheck(
  ctx: ServiceContext,
  taskId: string,
  options: ResolvedClaimTaskOptions,
  now: Date,
): Promise<Task> {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + options.leaseMinutes * 60_000,
  );
  if (!Number.isFinite(leaseExpiresAt.getTime())) {
    throw new InvalidClaimTaskOptionsError();
  }

  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (isExternalExecutionTask(task)) {
      throw new ClaimTaskExternalExecutionError();
    }
    if (task.status === 'agent_executable' && task.claim !== null) {
      throw new ClaimTaskUnexpectedClaimError();
    }
    if (!isClaimEligible(task, await loadKnownProjectIds(ctx))) {
      throw new ClaimTaskNotEligibleError();
    }
    assertTransition(task.status, 'in_progress');
    const claimed: Task = {
      ...task,
      status: 'in_progress',
      attempts: task.attempts + 1,
      claim: {
        runId: options.runId,
        agent: options.agent,
        claimedAt: timestamp,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      },
      updatedAt: timestamp,
    };

    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(claimed);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = claimed;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.claimed',
        at: timestamp,
        taskId: saved.taskId,
        runId: options.runId,
        details: { mode: options.mode },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch (error) {
        if (error instanceof TaskSavedIndexStaleError) {
          throw new ClaimTaskAuditFailedError();
        }
        throw new ClaimTaskRecoveryError();
      }
      throw new ClaimTaskAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}

export async function claimTask(
  ctx: ServiceContext,
  taskId: string,
  rawOptions: ClaimTaskOptions,
): Promise<Task> {
  const options = resolveClaimTaskOptions(rawOptions);
  const now = ctx.clock();
  return ctx.tasks.withTaskLock(AGENT_CLAIM_LOCK_KEY, async () => {
    if (!(await automaticClaimSlotAvailable(ctx))) {
      throw new ClaimTaskNotEligibleError();
    }
    return claimTaskWithoutQuotaCheck(ctx, taskId, options, now);
  });
}
