import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import {
  saveTaskBrief,
  type SaveTaskBriefInput,
} from '../services/save-task-brief.js';
import type { ServiceContext } from '../services/service-context.js';

export interface PreparedTaskBrief {
  task: Task;
  project: Project | null;
}

export class TaskBriefController {
  constructor(private readonly ctx: ServiceContext) {}

  async prepare(taskId: string): Promise<PreparedTaskBrief> {
    const task = await this.ctx.tasks.get(taskId);
    if (task.projectId === null) return { task, project: null };
    const project = await this.ctx.projects.get(task.projectId).catch(() => null);
    return { task, project };
  }

  async save(
    taskId: string,
    input: SaveTaskBriefInput,
    expectedTaskBriefUpdatedAt: string | null,
  ): Promise<Task> {
    return saveTaskBrief(
      this.ctx,
      taskId,
      input,
      expectedTaskBriefUpdatedAt,
    );
  }
}
