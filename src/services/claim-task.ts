import { z } from 'zod';

import { readinessErrors, type Task } from '../domain/task.js';
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

export function isClaimEligible(task: Task): boolean {
  return task.status === 'agent_executable'
    && task.reviewState === 'confirmed'
    && readinessErrors(task).length === 0;
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
    if (!isClaimEligible(task)) {
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
