import type { Task } from '../domain/task.js';
import {
  authorizeResearchExecutionState,
} from './authorize-agent-execution.js';
import {
  dispatchResearchTask,
  type DispatchResearchOutcome,
  type DispatchResearchTaskDependencies,
  ResearchDispatchNotAdmittedError,
} from './dispatch-research-task.js';
import type { ServiceContext } from './service-context.js';

export interface AuthorizeResearchTaskResult {
  task: Task;
  dispatch: DispatchResearchOutcome;
}

function dispatchFallbackOutcome(
  taskId: string,
  error: unknown,
): DispatchResearchOutcome {
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

export async function authorizeResearchTask(
  ctx: ServiceContext,
  dependencies: DispatchResearchTaskDependencies,
  taskId: string,
): Promise<AuthorizeResearchTaskResult> {
  await authorizeResearchExecutionState(ctx, taskId, {
    requireMultica: true,
  });
  let dispatch: DispatchResearchOutcome;
  try {
    dispatch = await dispatchResearchTask(ctx, dependencies, taskId);
  } catch (error) {
    if (error instanceof ResearchDispatchNotAdmittedError) throw error;
    dispatch = dispatchFallbackOutcome(taskId, error);
  }
  return { task: await ctx.tasks.get(taskId), dispatch };
}
