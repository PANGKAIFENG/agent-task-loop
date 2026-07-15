import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ClaimMode } from './claim-task.js';
import type { ServiceContext } from './service-context.js';

export type RunFailureOutcome = 'requeued' | 'blocked';

export interface RecordRunFailureInput {
  runId: string;
  errorCode: string;
  mode: ClaimMode;
}

export class RunFailureInvalidStateError extends Error {
  readonly code = 'run_failure_invalid_state';

  constructor() {
    super('Task is not eligible for run failure recording');
    this.name = 'RunFailureInvalidStateError';
  }
}

export class RunFailureAuditFailedError extends Error {
  readonly code = 'run_failure_audit_failed';

  constructor() {
    super('Run failure audit failed');
    this.name = 'RunFailureAuditFailedError';
  }
}

export class RunFailureRecoveryError extends Error {
  readonly code = 'run_failure_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Run failure recovery required');
    this.name = 'RunFailureRecoveryError';
  }
}

export async function recordRunFailure(
  ctx: ServiceContext,
  taskId: string,
  input: RecordRunFailureInput,
): Promise<{ task: Task; outcome: RunFailureOutcome }> {
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(input.errorCode)) {
    throw new RunFailureInvalidStateError();
  }
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (
      task.status !== 'in_progress'
      || task.claim === null
      || task.claim.runId !== input.runId
    ) {
      throw new RunFailureInvalidStateError();
    }
    const outcome: RunFailureOutcome = task.attempts >= 2
      ? 'blocked'
      : 'requeued';
    const status = outcome === 'blocked' ? 'blocked' : 'ready';
    assertTransition('in_progress', status);
    const timestamp = ctx.clock().toISOString();
    const updated: Task = {
      ...task,
      status,
      claim: null,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(updated);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = updated;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'runner.failed',
        at: timestamp,
        taskId,
        runId: input.runId,
        details: {
          errorCode: input.errorCode,
          attempt: task.attempts,
          mode: input.mode,
          outcome,
        },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new RunFailureRecoveryError();
      }
      throw new RunFailureAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return { task: saved, outcome };
  });
}
