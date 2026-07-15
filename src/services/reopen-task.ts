import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface ReopenTaskInput {
  reason: string;
}

export class ReopenTaskInvalidInputError extends Error {
  readonly code = 'invalid_reopen_task_input';

  constructor() {
    super('Invalid task reopen reason');
    this.name = 'ReopenTaskInvalidInputError';
  }
}

export class ReopenTaskInvalidStateError extends Error {
  readonly code = 'task_reopen_invalid_state';

  constructor() {
    super('Task must be Done to reopen');
    this.name = 'ReopenTaskInvalidStateError';
  }
}

export class ReopenTaskAuditFailedError extends Error {
  readonly code = 'task_reopen_audit_failed';

  constructor() {
    super('Task reopen audit failed');
    this.name = 'ReopenTaskAuditFailedError';
  }
}

export class ReopenTaskRecoveryError extends Error {
  readonly code = 'task_reopen_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task reopen recovery required');
    this.name = 'ReopenTaskRecoveryError';
  }
}

export async function reopenTask(
  ctx: ServiceContext,
  taskId: string,
  input: ReopenTaskInput,
): Promise<Task> {
  if (
    typeof input?.reason !== 'string'
    || input.reason.trim() === ''
    || input.reason.length > 20_000
  ) {
    throw new ReopenTaskInvalidInputError();
  }
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'done') {
      throw new ReopenTaskInvalidStateError();
    }
    assertTransition('done', 'ready');
    const timestamp = ctx.clock().toISOString();
    const reopened: Task = {
      ...task,
      status: 'ready',
      reviewFeedback: input.reason,
      readyAt: timestamp,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(reopened);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = reopened;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.reopened',
        at: timestamp,
        taskId,
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new ReopenTaskRecoveryError();
      }
      throw new ReopenTaskAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
