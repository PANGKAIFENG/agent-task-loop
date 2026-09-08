import {
  developmentDispatchErrors,
  isExternalExecutionTask,
  type Task,
} from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import {
  AgentAuthorizationAuditFailedError,
  AgentAuthorizationInvalidStateError,
  AgentAuthorizationRecoveryError,
} from './authorize-agent-execution.js';
import {
  DevelopmentDispatchNotAdmittedError,
  DevelopmentDispatchWriteBackError,
  dispatchDevelopmentTask,
  type DispatchDevelopmentTaskDependencies,
  type DispatchOutcome,
} from './dispatch-development-task.js';
import type { ServiceContext } from './service-context.js';

export class DevelopmentAuthorizationNotReadyError extends Error {
  readonly code = 'task_development_authorization_not_ready';
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super('Development task is not ready for agent authorization');
    this.name = 'DevelopmentAuthorizationNotReadyError';
    this.errors = errors;
  }
}

export interface AuthorizeDevelopmentTaskResult {
  task: Task;
  dispatch: DispatchOutcome;
}

function dispatchFallbackOutcome(
  taskId: string,
  error: unknown,
): DispatchOutcome {
  if (error instanceof DevelopmentDispatchWriteBackError) {
    return {
      status: 'remote_write_unknown',
      taskId,
      reason: 'dispatch result could not be written back; reconciliation will recover',
    };
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    return { status: 'failed', taskId, reason: error.code };
  }
  return { status: 'failed', taskId, reason: 'unexpected_dispatch_error' };
}

// PAW-GOAL-003-V0.5 D1 (PRD 4.2): the Contract preview gates the dispatch
// button on the exact admission the authorization path enforces below — the
// UI must call this function instead of re-implementing a second rule set.
// Like authorizeDevelopmentTask, admission is evaluated for the
// post-authorization shape (status agent_executable) of a confirmed task.
export function developmentAuthorizationGaps(
  task: Task,
  allowedContextRoots: readonly string[] = [],
): string[] {
  if (!isExternalExecutionTask(task)) {
    return ['executionTarget must be multica'];
  }
  return [
    ...(task.reviewState === 'confirmed' ? [] : ['reviewState must be confirmed']),
    ...developmentDispatchErrors(
      { ...task, status: 'agent_executable' },
      allowedContextRoots,
    ),
  ];
}

// PAW-GOAL-003 T1 (PRD 4.1): a confirmed development task moves from ready to
// agent_executable, then immediately attempts the idempotent Multica dispatch.
// The authorization itself must survive a dispatch failure — reconciliation
// compensates on the next cycle instead of rolling the task back.
export async function authorizeDevelopmentTask(
  ctx: ServiceContext,
  dependencies: DispatchDevelopmentTaskDependencies,
  taskId: string,
): Promise<AuthorizeDevelopmentTaskResult> {
  const authorized = await ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'ready') {
      throw new AgentAuthorizationInvalidStateError();
    }
    if (!isExternalExecutionTask(task)) {
      throw new DevelopmentAuthorizationNotReadyError(['executionTarget must be multica']);
    }
    // Admission is evaluated for the post-authorization shape: every field
    // gap surfaces here, before any state change or remote write.
    const errors = developmentAuthorizationGaps(
      task,
      dependencies.allowedContextRoots ?? [],
    );
    if (errors.length > 0) {
      throw new DevelopmentAuthorizationNotReadyError(errors);
    }
    assertTransition('ready', 'agent_executable');
    const timestamp = ctx.clock().toISOString();
    const updated: Task = {
      ...task,
      status: 'agent_executable',
      autoExecutable: true,
      updatedAt: timestamp,
    };

    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(updated);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) throw error;
      saved = updated;
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
          taskType: 'development',
          executionTarget: 'multica',
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

  let dispatch: DispatchOutcome;
  try {
    dispatch = await dispatchDevelopmentTask(ctx, dependencies, taskId);
  } catch (error) {
    if (error instanceof DevelopmentDispatchNotAdmittedError) {
      throw error;
    }
    dispatch = dispatchFallbackOutcome(taskId, error);
  }
  return { task: authorized, dispatch };
}
