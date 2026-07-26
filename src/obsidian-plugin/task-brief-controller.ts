import { createHash } from 'node:crypto';

import type { Project } from '../domain/project.js';
import type { Task, TaskBrief } from '../domain/task.js';
import {
  nextTaskBriefTimestamp,
  saveTaskBrief,
  TaskBriefAuditFailedError,
  TaskBriefRecoveryError,
  type SaveTaskBriefInput,
  validateTaskBriefInput,
} from '../services/save-task-brief.js';
import type { ServiceContext } from '../services/service-context.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../storage/frontmatter.js';
import {
  TaskConflictError,
  TaskNotFoundError,
} from '../storage/markdown-task-repository.js';
import { isTaskNotesTaskPath } from './task-eligibility.js';

export interface TaskBriefTask {
  taskId: string;
  title: string;
  body: string;
  taskBrief?: TaskBrief | null | undefined;
}

export interface PreparedTaskBrief {
  task: TaskBriefTask;
  project: Project | null;
}

export interface TaskBriefSaver {
  save(
    taskId: string,
    input: SaveTaskBriefInput,
    expectedTaskBriefUpdatedAt: string | null,
  ): Promise<unknown>;
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

interface TaskNotesTaskBriefAuditEvent {
  event: 'task.brief_saved';
  at: string;
  taskId: string;
  details: { schemaVersion: 1 };
}

export interface TaskNotesTaskBriefControllerDependencies {
  path: string;
  read(path: string): Promise<string>;
  process(
    path: string,
    update: (current: string) => string,
  ): Promise<string>;
  appendAudit(event: TaskNotesTaskBriefAuditEvent): Promise<void>;
  clock(): Date;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function taskNotesTaskId(path: string, data: Record<string, unknown>): string {
  return nonBlankString(data.task_id)
    ?? `tasknotes-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

function taskNotesTitle(path: string, data: Record<string, unknown>): string {
  const existing = nonBlankString(data.title);
  if (existing !== null) return existing;
  const filename = path.split('/').at(-1) ?? path;
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

function taskNotesBrief(data: Record<string, unknown>): TaskBrief | null {
  const raw = data.task_brief;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const brief = raw as Record<string, unknown>;
  const objective = nonBlankString(brief.objective);
  const nextAction = nonBlankString(brief.next_action);
  const completionCriteria = nonBlankString(brief.completion_criteria);
  const updatedAt = nonBlankString(brief.updated_at);
  if (
    brief.schema_version !== 1
    || objective === null
    || nextAction === null
    || completionCriteria === null
    || updatedAt === null
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    objective,
    nextAction,
    completionCriteria,
    updatedAt,
  };
}

function prepareTaskNotesTask(path: string, raw: string): PreparedTaskBrief {
  const document = parseTaskDocument(raw);
  if (!isTaskNotesTaskPath(path, document.data)) throw new TaskNotFoundError(path);
  return {
    task: {
      taskId: taskNotesTaskId(path, document.data),
      title: taskNotesTitle(path, document.data),
      body: document.body,
      taskBrief: taskNotesBrief(document.data),
    },
    project: null,
  };
}

export class TaskNotesTaskBriefController implements TaskBriefSaver {
  constructor(private readonly dependencies: TaskNotesTaskBriefControllerDependencies) {}

  async prepare(): Promise<PreparedTaskBrief> {
    return prepareTaskNotesTask(
      this.dependencies.path,
      await this.dependencies.read(this.dependencies.path),
    );
  }

  async save(
    taskId: string,
    input: SaveTaskBriefInput,
    expectedTaskBriefUpdatedAt: string | null,
  ): Promise<TaskBriefTask> {
    const parsed = validateTaskBriefInput(input);
    let originalRaw = '';
    let updatedRaw = '';
    let timestamp = '';
    let currentTaskId = '';
    await this.dependencies.process(this.dependencies.path, (currentRaw) => {
      const document = parseTaskDocument(currentRaw);
      if (!isTaskNotesTaskPath(this.dependencies.path, document.data)) {
        throw new TaskNotFoundError(this.dependencies.path);
      }
      currentTaskId = taskNotesTaskId(this.dependencies.path, document.data);
      if (currentTaskId !== taskId) throw new TaskConflictError();
      const currentBriefUpdatedAt = taskNotesBrief(document.data)?.updatedAt ?? null;
      if (currentBriefUpdatedAt !== expectedTaskBriefUpdatedAt) {
        throw new TaskConflictError();
      }

      timestamp = nextTaskBriefTimestamp(
        this.dependencies.clock(),
        currentBriefUpdatedAt,
      );
      const updatedData: Record<string, unknown> = {
        ...document.data,
        schema_version: document.data.schema_version ?? 1,
        task_id: nonBlankString(document.data.task_id) ?? currentTaskId,
        title: nonBlankString(document.data.title)
          ?? taskNotesTitle(this.dependencies.path, document.data),
        updated_at: timestamp,
        task_brief: {
          schema_version: 1,
          objective: parsed.objective,
          next_action: parsed.nextAction,
          completion_criteria: parsed.completionCriteria,
          updated_at: timestamp,
        },
      };
      originalRaw = currentRaw;
      updatedRaw = serializeTaskDocument(updatedData, document.body);
      return updatedRaw;
    });

    try {
      await this.dependencies.appendAudit({
        event: 'task.brief_saved',
        at: timestamp,
        taskId: currentTaskId,
        details: { schemaVersion: 1 },
      });
    } catch {
      try {
        await this.dependencies.process(this.dependencies.path, (currentRaw) => {
          if (currentRaw !== updatedRaw) throw new TaskBriefRecoveryError();
          return originalRaw;
        });
      } catch (error) {
        if (error instanceof TaskBriefRecoveryError) throw error;
        throw new TaskBriefRecoveryError();
      }
      throw new TaskBriefAuditFailedError();
    }

    return prepareTaskNotesTask(this.dependencies.path, updatedRaw).task;
  }
}
