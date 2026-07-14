import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export class StopTaskInvalidStateError extends Error {
  readonly code = 'task_stop_invalid_state';

  constructor() {
    super('Task must be In Progress to stop');
    this.name = 'StopTaskInvalidStateError';
  }
}

export class StopTaskAuditFailedError extends Error {
  readonly code = 'task_stop_audit_failed';

  constructor() {
    super('Task stop audit failed');
    this.name = 'StopTaskAuditFailedError';
  }
}

export class StopTaskRecoveryError extends Error {
  readonly code = 'task_stop_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task stop recovery required');
    this.name = 'StopTaskRecoveryError';
  }
}

export async function stopTask(
  ctx: ServiceContext,
  taskId: string,
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'in_progress' || task.claim === null) {
      throw new StopTaskInvalidStateError();
    }
    assertTransition('in_progress', 'ready');
    const timestamp = ctx.clock().toISOString();
    const stopped: Task = {
      ...task,
      status: 'ready',
      claim: null,
      readyAt: timestamp,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(stopped);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = stopped;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.stopped',
        at: timestamp,
        taskId,
        runId: task.claim.runId,
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new StopTaskRecoveryError();
      }
      throw new StopTaskAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
