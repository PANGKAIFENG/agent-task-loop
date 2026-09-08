import {
  dispatchDevelopmentTask,
  type DispatchDevelopmentTaskDependencies,
  type DispatchOutcome,
} from './dispatch-development-task.js';
import {
  dispatchResearchTask,
  type DispatchResearchOutcome,
  type DispatchResearchTaskDependencies,
} from './dispatch-research-task.js';
import type { ServiceContext } from './service-context.js';

export interface DispatchMulticaTaskDependencies {
  development: DispatchDevelopmentTaskDependencies;
  research: DispatchResearchTaskDependencies;
}

export type DispatchMulticaTaskOutcome = DispatchOutcome | DispatchResearchOutcome;

export class MulticaTaskTypeUnsupportedError extends Error {
  readonly code = 'multica_task_type_unsupported';

  constructor() {
    super('Multica dispatch requires a declared research or development task type');
    this.name = 'MulticaTaskTypeUnsupportedError';
  }
}

export async function dispatchMulticaTask(
  ctx: ServiceContext,
  dependencies: DispatchMulticaTaskDependencies,
  taskId: string,
): Promise<DispatchMulticaTaskOutcome> {
  const task = await ctx.tasks.get(taskId);
  if (task.taskType === 'research') {
    return dispatchResearchTask(ctx, dependencies.research, taskId);
  }
  if (task.taskType === 'development') {
    return dispatchDevelopmentTask(ctx, dependencies.development, taskId);
  }
  throw new MulticaTaskTypeUnsupportedError();
}
