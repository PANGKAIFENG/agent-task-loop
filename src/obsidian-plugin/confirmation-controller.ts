import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
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
    if (task.status !== 'inbox') {
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

    return confirmTask(this.ctx, taskId, {
      ...(projectId === undefined ? {} : { projectId }),
      ...(hasExecutionDetails || value.autoExecutable
        ? { taskType: 'research' as const }
        : {}),
      ...(value.objective === null ? {} : { objective: value.objective }),
      acceptanceCriteria: value.acceptanceCriteria,
      ...(value.autoExecutable
        ? { permissionProfile: 'read_only_research' as const }
        : {}),
      priority: value.priority,
      autoExecutable: value.autoExecutable,
    });
  }
}
