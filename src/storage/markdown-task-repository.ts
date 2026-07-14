import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import fastGlob from 'fast-glob';

import {
  taskSchema,
  type Priority,
  type Task,
  type TaskStatus,
} from '../domain/task.js';
import type { TaskRepository } from './contracts.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import { rebuildTaskIndex } from './task-index.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  lifecycleDirectory,
  taskStorageRoot,
  vaultRoot,
} from './task-paths.js';

interface TaskRecord {
  path: string;
  data: Record<string, unknown>;
  body: string;
}

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found';

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class InvalidTaskDataError extends Error {
  readonly code = 'invalid_task_data';

  constructor() {
    super('Invalid task data');
    this.name = 'InvalidTaskDataError';
  }
}

export class TaskSavedIndexStaleError extends Error {
  readonly code = 'task_saved_index_stale';

  constructor(options?: ErrorOptions) {
    super('Task saved but task index is stale', options);
    this.name = 'TaskSavedIndexStaleError';
  }
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : [];
}

function taskStatus(value: unknown): TaskStatus {
  return value === 'ready'
    || value === 'in_progress'
    || value === 'review'
    || value === 'done'
    || value === 'blocked'
    || value === 'cancelled'
    ? value
    : 'inbox';
}

function priority(value: unknown): Priority {
  return value === 'urgent' || value === 'high' || value === 'low'
    ? value
    : 'normal';
}

function deriveLegacySourceKey(data: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update([
      stringValue(data.origin),
      stringValue(data.source_date),
      stringValue(data.source_note),
      stringValue(data.source_quote),
    ].join('|'))
    .digest('hex');
  return `legacy:${digest}`;
}

function mapClaim(value: unknown): Task['claim'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError();
  }
  const claim = value as Record<string, unknown>;
  return {
    runId: stringValue(claim.run_id ?? claim.runId),
    agent: stringValue(claim.agent),
    claimedAt: stringValue(claim.claimed_at ?? claim.claimedAt),
    leaseExpiresAt: stringValue(claim.lease_expires_at ?? claim.leaseExpiresAt),
  };
}

function taskFromRecord(record: TaskRecord): Task {
  const data = record.data;
  const reviewState = data.review_state === 'ready_for_confirm'
    || data.review_state === 'confirmed'
    ? data.review_state
    : 'candidate';
  const taskType = data.task_type === 'research' ? 'research' : null;
  const permissionProfile = data.permission_profile === 'read_only_research'
    ? 'read_only_research'
    : null;
  const task: Task = {
    schemaVersion: 1,
    taskId: stringValue(data.task_id, basename(record.path, '.md')),
    title: stringValue(data.title),
    body: record.body,
    status: taskStatus(data.status),
    reviewState,
    projectId: nullableString(data.project_id),
    taskType,
    objective: nullableString(data.objective),
    acceptanceCriteria: stringArray(data.acceptance_criteria),
    autoExecutable: data.auto_executable === true,
    permissionProfile,
    origin: stringValue(data.origin, 'legacy'),
    sourceDate: nullableString(data.source_date),
    sourceNote: nullableString(data.source_note),
    sourceQuote: nullableString(data.source_quote),
    sourceKey: stringValue(data.source_key) || deriveLegacySourceKey(data),
    possibleDuplicateIds: stringArray(data.possible_duplicate_ids),
    priority: priority(data.priority),
    attempts: typeof data.attempts === 'number'
      && Number.isInteger(data.attempts)
      && data.attempts >= 0
      ? data.attempts
      : 0,
    claim: mapClaim(data.claim),
    artifactRefs: stringArray(data.artifact_refs),
    reviewFeedback: nullableString(data.review_feedback),
    readyAt: nullableString(data.ready_at),
    createdAt: stringValue(data.created_at, '1970-01-01T00:00:00.000Z'),
    updatedAt: stringValue(data.updated_at, '1970-01-01T00:00:00.000Z'),
  };

  const result = taskSchema.safeParse(task);
  if (!result.success) {
    throw new InvalidTaskDataError();
  }
  return result.data;
}

function claimFrontmatter(claim: Task['claim']): Record<string, string> | null {
  return claim === null ? null : {
    run_id: claim.runId,
    agent: claim.agent,
    claimed_at: claim.claimedAt,
    lease_expires_at: claim.leaseExpiresAt,
  };
}

function mergeTaskData(
  original: Record<string, unknown>,
  task: Task,
): Record<string, unknown> {
  return {
    ...original,
    type: 'task',
    schema_version: task.schemaVersion,
    task_id: task.taskId,
    title: task.title,
    status: task.status,
    review_state: task.reviewState,
    project_id: task.projectId,
    task_type: task.taskType,
    objective: task.objective,
    acceptance_criteria: task.acceptanceCriteria,
    auto_executable: task.autoExecutable,
    permission_profile: task.permissionProfile,
    origin: task.origin,
    source_date: task.sourceDate,
    source_note: task.sourceNote,
    source_quote: task.sourceQuote,
    source_key: task.sourceKey,
    possible_duplicate_ids: task.possibleDuplicateIds,
    priority: task.priority,
    attempts: task.attempts,
    claim: claimFrontmatter(task.claim),
    artifact_refs: task.artifactRefs,
    review_feedback: task.reviewFeedback,
    ready_at: task.readyAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function hasSafeTaskPaths(task: Task): boolean {
  return isSafePathSegment(task.taskId)
    && (task.projectId === null || isSafePathSegment(task.projectId))
    && (task.sourceDate === null || /^\d{4}-\d{2}-\d{2}$/.test(task.sourceDate))
    && /^\d{4}/.test(task.updatedAt);
}

export class MarkdownTaskRepository implements TaskRepository {
  readonly root: string;
  readonly tasksRoot: string;
  readonly records = new Map<string, TaskRecord>();

  constructor(root?: string) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
  }

  async list(): Promise<Task[]> {
    const paths = await fastGlob(
      ['Inbox/**/*.md', 'Active/**/*.md', 'Archive/**/*.md'],
      { absolute: true, cwd: this.tasksRoot, onlyFiles: true },
    );
    const tasks = await Promise.all(paths.sort().map(async (path) => {
      const record = await this.readRecord(path);
      const task = taskFromRecord(record);
      this.records.set(task.taskId, record);
      return task;
    }));
    return tasks;
  }

  async get(taskId: string): Promise<Task> {
    const cached = this.records.get(taskId);
    if (cached !== undefined) {
      return taskFromRecord(cached);
    }
    const tasks = await this.list();
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  async findBySourceKey(sourceKey: string): Promise<Task | null> {
    return (await this.list()).find((task) => task.sourceKey === sourceKey) ?? null;
  }

  async save(task: Task): Promise<Task> {
    assertVaultWriteAllowed(this.root);
    const result = taskSchema.safeParse(task);
    if (!result.success) {
      throw new InvalidTaskDataError();
    }
    const validTask = result.data;
    if (!hasSafeTaskPaths(validTask)) {
      throw new InvalidTaskDataError();
    }
    let existing = this.records.get(validTask.taskId);
    if (existing === undefined) {
      try {
        await this.get(validTask.taskId);
        existing = this.records.get(validTask.taskId);
      } catch (error) {
        if (!(error instanceof TaskNotFoundError)) {
          throw error;
        }
      }
    }

    const body = existing?.body ?? validTask.body;
    const persistedTask = { ...validTask, body };
    const data = mergeTaskData(existing?.data ?? {}, persistedTask);
    const targetDirectory = lifecycleDirectory(this.tasksRoot, persistedTask);
    const targetPath = join(targetDirectory, `${persistedTask.taskId}.md`);
    const temporaryPath = `${targetPath}.tmp`;
    await mkdir(targetDirectory, { recursive: true });
    try {
      await writeFile(temporaryPath, serializeTaskDocument(data, body), 'utf8');
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }

    if (existing !== undefined && existing.path !== targetPath) {
      await rm(existing.path);
    }
    this.records.set(persistedTask.taskId, { path: targetPath, data, body });

    try {
      await rebuildTaskIndex(this.tasksRoot);
    } catch (error) {
      throw new TaskSavedIndexStaleError({ cause: error });
    }
    return persistedTask;
  }

  private async readRecord(path: string): Promise<TaskRecord> {
    const document = parseTaskDocument(await readFile(path, 'utf8'));
    return { path, ...document };
  }
}
