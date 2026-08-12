import { readinessErrors, type Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export class AgentAuthorizationInvalidStateError extends Error {
  readonly code = 'task_agent_authorization_invalid_state';

  constructor() {
    super('Task must be Ready to authorize Agent execution');
    this.name = 'AgentAuthorizationInvalidStateError';
  }
}

export class AgentAuthorizationNotReadyError extends Error {
  readonly code = 'task_agent_authorization_not_ready';
  readonly errors: string[];

  constructor(errors: string[]) {
    super('Task execution context is incomplete');
    this.name = 'AgentAuthorizationNotReadyError';
    this.errors = errors;
  }
}

export class AgentAuthorizationAuditFailedError extends Error {
  readonly code = 'task_agent_authorization_audit_failed';

  constructor() {
    super('Agent execution authorization audit failed');
    this.name = 'AgentAuthorizationAuditFailedError';
  }
}

export class AgentAuthorizationRecoveryError extends Error {
  readonly code = 'task_agent_authorization_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Agent execution authorization recovery required');
    this.name = 'AgentAuthorizationRecoveryError';
  }
}

export async function authorizeAgentExecution(
  ctx: ServiceContext,
  taskId: string,
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'ready') {
      throw new AgentAuthorizationInvalidStateError();
    }
    const errors = [
      ...(task.reviewState === 'confirmed' ? [] : ['reviewState must be confirmed']),
      ...readinessErrors(task),
    ];
    if (errors.length > 0) {
      throw new AgentAuthorizationNotReadyError(errors);
    }
    assertTransition('ready', 'agent_executable');
    const timestamp = ctx.clock().toISOString();
    const authorized: Task = {
      ...task,
      status: 'agent_executable',
      autoExecutable: true,
      updatedAt: timestamp,
    };

    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(authorized);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) throw error;
      saved = authorized;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.agent_authorized',
        at: timestamp,
        taskId,
        details: {
          fromStatus: 'ready',
          toStatus: 'agent_executable',
        },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch (error) {
        if (error instanceof TaskSavedIndexStaleError) {
          throw new AgentAuthorizationAuditFailedError();
        }
        throw new AgentAuthorizationRecoveryError();
      }
      throw new AgentAuthorizationAuditFailedError();
    }
    if (staleIndexError !== null) throw staleIndexError;
    return saved;
  });
}
