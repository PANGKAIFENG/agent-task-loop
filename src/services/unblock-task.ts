import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface UnblockTaskInput {
  recoveryNote: string;
}

export class UnblockTaskInvalidInputError extends Error {
  readonly code = 'invalid_unblock_task_input';

  constructor() {
    super('Invalid task recovery note');
    this.name = 'UnblockTaskInvalidInputError';
  }
}

export class UnblockTaskInvalidStateError extends Error {
  readonly code = 'task_unblock_invalid_state';

  constructor() {
    super('Task must be Blocked to unblock');
    this.name = 'UnblockTaskInvalidStateError';
  }
}

export class UnblockTaskAuditFailedError extends Error {
  readonly code = 'task_unblock_audit_failed';

  constructor() {
    super('Task unblock audit failed');
    this.name = 'UnblockTaskAuditFailedError';
  }
}

export class UnblockTaskRecoveryError extends Error {
  readonly code = 'task_unblock_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task unblock recovery required');
    this.name = 'UnblockTaskRecoveryError';
  }
}

export async function unblockTask(
  ctx: ServiceContext,
  taskId: string,
  input: UnblockTaskInput,
): Promise<Task> {
  if (
    typeof input?.recoveryNote !== 'string'
    || input.recoveryNote.trim() === ''
    || input.recoveryNote.length > 20_000
  ) {
    throw new UnblockTaskInvalidInputError();
  }
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'blocked') {
      throw new UnblockTaskInvalidStateError();
    }
    assertTransition('blocked', 'ready');
    const timestamp = ctx.clock().toISOString();
    const unblocked: Task = {
      ...task,
      status: 'ready',
      reviewFeedback: input.recoveryNote,
      readyAt: timestamp,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(unblocked);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = unblocked;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.unblocked',
        at: timestamp,
        taskId,
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new UnblockTaskRecoveryError();
      }
      throw new UnblockTaskAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
