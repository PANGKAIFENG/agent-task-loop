import type { AtlConfig } from '../config.js';
import {
  authorizeResearchTask,
  type AuthorizeResearchTaskResult,
} from '../services/authorize-research-task.js';
import { buildResearchMulticaDispatchDependencies } from '../services/build-multica-dispatch-dependencies.js';
import type { ServiceContext } from '../services/service-context.js';

export function createResearchTaskDispatcher(
  context: ServiceContext,
  config: AtlConfig,
  allowedLocalRoots: readonly string[],
): (taskId: string) => Promise<AuthorizeResearchTaskResult> {
  const dependencies = buildResearchMulticaDispatchDependencies(
    config,
    allowedLocalRoots,
  );
  return (taskId) => authorizeResearchTask(context, dependencies, taskId);
}
