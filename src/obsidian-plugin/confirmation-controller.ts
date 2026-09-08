import type { Project } from '../domain/project.js';
import { isExternalExecutionTask, type Task } from '../domain/task.js';
import {
  confirmTask,
  ConfirmTaskInvalidStateError,
} from '../services/confirm-task.js';
import { createProject } from '../services/create-project.js';
import type { ServiceContext } from '../services/service-context.js';
import {
  validateConfirmationForm,
  type ConfirmationFormErrors,
  type ConfirmationFormInput,
} from './confirmation-form.js';

export class InvalidConfirmationFormError extends Error {
  readonly code = 'invalid_confirmation_form';
  readonly errors: ConfirmationFormErrors;

  constructor(errors: ConfirmationFormErrors) {
    super('请补齐任务确认信息');
    this.name = 'InvalidConfirmationFormError';
    this.errors = errors;
  }
}

export interface PreparedConfirmation {
  task: Task;
  projects: Project[];
}

export class ConfirmationController {
  constructor(private readonly ctx: ServiceContext) {}

  async prepare(taskId: string): Promise<PreparedConfirmation> {
    const [task, projects] = await Promise.all([
      this.ctx.tasks.get(taskId),
      this.ctx.projects.list(),
    ]);
    const confirmsReadyCandidate = task.status === 'ready'
      && task.reviewState !== 'confirmed';
    // PAW-GOAL-003-V0.5 D2 (PRD 4.5): the补投入口 prepares an already
    // confirmed development declaration (ready undelivered, or
    // agent_executable after a failed dispatch) so the Contract step can
    // render from the persisted task. Research tasks keep the exact
    // previous guard.
    const reviewsConfirmedDevelopment = (task.status === 'ready'
      || task.status === 'agent_executable')
      && task.reviewState === 'confirmed'
      && task.taskType === 'development'
      && isExternalExecutionTask(task);
    if (
      task.status !== 'inbox'
      && !confirmsReadyCandidate
      && !reviewsConfirmedDevelopment
    ) {
      throw new ConfirmTaskInvalidStateError();
    }
    return {
      task,
      projects: [...projects].sort((left, right) => (
        left.name.localeCompare(right.name, 'zh-CN')
      )),
    };
  }

  async confirm(taskId: string, input: ConfirmationFormInput): Promise<Task> {
    const result = validateConfirmationForm(input);
    if (!result.success) {
      throw new InvalidConfirmationFormError(result.errors);
    }
    const { value } = result;
    let projectId: string | undefined;
    if (value.project.mode === 'new') {
      const project = await createProject(this.ctx, {
        projectId: value.project.projectId,
        name: value.project.name,
        description: value.project.description,
        resources: [],
      });
      projectId = project.projectId;
    } else if (value.project.mode === 'existing') {
      projectId = value.project.projectId;
    }

    const hasExecutionDetails = value.objective !== null
      || value.acceptanceCriteria.length > 0;
    const isDevelopment = value.taskKind === 'development';
    const isCompleteResearch = !isDevelopment
      && projectId !== undefined
      && value.objective !== null
      && value.acceptanceCriteria.length > 0;

    // PAW-GOAL-003-V0.5 D1 (PRD 4.1): a development declaration persists the
    // full dispatch contract (task type, permission profile, execution
    // target, context refs) alongside the shared fields; the research branch
    // keeps the exact previous input shape.
    return confirmTask(this.ctx, taskId, {
      ...(projectId === undefined ? {} : { projectId }),
      ...(isDevelopment
        ? {
            taskType: 'development' as const,
            permissionProfile: 'repo_delivery' as const,
            executionTarget: 'multica' as const,
            contextRefs: value.contextRefs ?? [],
          }
        : {
            ...(hasExecutionDetails ? { taskType: 'research' as const } : {}),
            ...(hasExecutionDetails
              ? { permissionProfile: 'read_only_research' as const }
              : {}),
            ...(isCompleteResearch ? { executionTarget: 'multica' as const } : {}),
          }),
      ...(value.objective === null ? {} : { objective: value.objective }),
      acceptanceCriteria: value.acceptanceCriteria,
      priority: value.priority,
    });
  }
}
