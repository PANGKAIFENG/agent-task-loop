import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  taskSchema,
  type Priority,
  type Task,
  type TaskStatus,
} from '../domain/task.js';
import type { TaskRepository } from './contracts.js';
import {
  acquireSafeFileLock,
  atomicWriteTextFile,
  listSafeRegularFiles,
  moveSafeRegularFile,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';
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
  raw: string;
  snapshot: string;
}

interface TaskEntry {
  record: TaskRecord;
  task: Task;
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
  readonly field: string | undefined;

  constructor(field?: string) {
    super(field === undefined ? 'Invalid task data' : `Invalid task data: ${field}`);
    this.name = 'InvalidTaskDataError';
    this.field = field;
  }
}

export class TaskConflictError extends Error {
  readonly code = 'task_conflict';

  constructor() {
    super('Task storage conflict');
    this.name = 'TaskConflictError';
  }
}

export class TaskMoveRecoveryError extends Error {
  readonly code = 'task_move_recovery_error';
  readonly recovered: boolean;

  constructor(recovered: boolean) {
    super('Task lifecycle move write failed');
    this.name = 'TaskMoveRecoveryError';
    this.recovered = recovered;
  }
}

export class TaskIntegrityError extends Error {
  readonly code = 'task_integrity_error';

  constructor() {
    super('Task storage integrity error');
    this.name = 'TaskIntegrityError';
  }
}

export class TaskSavedIndexStaleError extends Error {
  readonly code = 'task_saved_index_stale';

  constructor(options?: ErrorOptions) {
    super('Task saved but task index is stale', options);
    this.name = 'TaskSavedIndexStaleError';
  }
}

export class TaskSourceClaimTimeoutError extends Error {
  readonly code = 'task_source_claim_timeout';

  constructor() {
    super('Task source claim timed out');
    this.name = 'TaskSourceClaimTimeoutError';
  }
}

export class TaskLockTimeoutError extends Error {
  readonly code = 'task_lock_timeout';

  constructor() {
    super('Task lock timed out');
    this.name = 'TaskLockTimeoutError';
  }
}

const SOURCE_CLAIM_ATTEMPTS = 100;
const SOURCE_CLAIM_RETRY_MS = 10;
const SOURCE_CLAIM_LEASE_MS = 30_000;
const TASK_LOCK_ATTEMPTS = 3_100;
const TASK_LOCK_RETRY_MS = 10;
const TASK_LOCK_LEASE_MS = 30_000;

export interface MarkdownTaskRepositoryOptions {
  sourceClaim?: {
    attempts?: number;
    retryMs?: number;
    leaseMs?: number;
    clock?: () => Date;
  };
  taskLock?: {
    attempts?: number;
    retryMs?: number;
    leaseMs?: number;
    clock?: () => Date;
  };
}

interface SourceClaimOptions {
  attempts: number;
  retryMs: number;
  leaseMs: number;
  clock: () => Date;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
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

function legacyEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = data[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new InvalidTaskDataError(field);
}

function legacyNullableEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | null {
  const value = data[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new InvalidTaskDataError(field);
}

function taskStatus(data: Record<string, unknown>): TaskStatus {
  return legacyEnum(data, 'status', [
    'inbox',
    'ready',
    'in_progress',
    'review',
    'done',
    'blocked',
    'cancelled',
  ], 'inbox');
}

function priority(data: Record<string, unknown>): Priority {
  return legacyEnum(data, 'priority', [
    'urgent',
    'high',
    'normal',
    'low',
  ], 'normal');
}

function legacyBoolean(
  data: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = data[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new InvalidTaskDataError(field);
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

function taskFromRecord(record: Pick<TaskRecord, 'path' | 'data' | 'body'>): Task {
  const data = record.data;
  const reviewState = legacyEnum(data, 'review_state', [
    'candidate',
    'ready_for_confirm',
    'confirmed',
  ], 'candidate');
  const taskType = legacyNullableEnum(data, 'task_type', ['research']);
  const permissionProfile = legacyNullableEnum(
    data,
    'permission_profile',
    ['read_only_research'],
  );
  const task: Task = {
    schemaVersion: 1,
    taskId: stringValue(data.task_id, basename(record.path, '.md')),
    title: stringValue(data.title),
    body: record.body,
    status: taskStatus(data),
    reviewState,
    projectId: nullableString(data.project_id),
    taskType,
    objective: nullableString(data.objective),
    acceptanceCriteria: stringArray(data.acceptance_criteria),
    autoExecutable: legacyBoolean(data, 'auto_executable', false),
    permissionProfile,
    origin: stringValue(data.origin, 'legacy'),
    sourceDate: nullableString(data.source_date),
    sourceNote: nullableString(data.source_note),
    sourceQuote: nullableString(data.source_quote),
    sourceKey: stringValue(data.source_key) || deriveLegacySourceKey(data),
    possibleDuplicateIds: stringArray(data.possible_duplicate_ids),
    priority: priority(data),
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

function canonicalTaskSnapshot(task: Task): string {
  const canonical: Partial<Task> = { ...task };
  delete canonical.body;
  return JSON.stringify(canonical);
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
  private readonly sourceClaim: SourceClaimOptions;
  private readonly taskLock: SourceClaimOptions;

  constructor(root?: string, options: MarkdownTaskRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.sourceClaim = {
      attempts: positiveInteger(
        options.sourceClaim?.attempts,
        SOURCE_CLAIM_ATTEMPTS,
      ),
      retryMs: nonNegativeInteger(
        options.sourceClaim?.retryMs,
        SOURCE_CLAIM_RETRY_MS,
      ),
      leaseMs: positiveInteger(
        options.sourceClaim?.leaseMs,
        SOURCE_CLAIM_LEASE_MS,
      ),
      clock: options.sourceClaim?.clock ?? (() => new Date()),
    };
    this.taskLock = {
      attempts: positiveInteger(
        options.taskLock?.attempts,
        TASK_LOCK_ATTEMPTS,
      ),
      retryMs: nonNegativeInteger(
        options.taskLock?.retryMs,
        TASK_LOCK_RETRY_MS,
      ),
      leaseMs: positiveInteger(
        options.taskLock?.leaseMs,
        TASK_LOCK_LEASE_MS,
      ),
      clock: options.taskLock?.clock ?? (() => new Date()),
    };
  }

  async withTaskLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertVaultWriteAllowed(this.root);
    if (!isSafePathSegment(taskId)) {
      throw new InvalidTaskDataError();
    }
    const lockRoot = join(this.tasksRoot, '.atl', 'task-locks');
    const lockKey = createHash('sha256').update(taskId).digest('hex');
    const lockPath = join(lockRoot, `${lockKey}.lock`);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < this.taskLock.attempts; attempt += 1) {
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: this.taskLock.clock(),
        leaseMs: this.taskLock.leaseMs,
      });
      if (lock === null) {
        const reclaimed = await reclaimExpiredSafeFileLock(
          lockPath,
          boundary,
          this.taskLock.clock(),
        );
        if (reclaimed) {
          lock = await acquireSafeFileLock(lockPath, boundary, {
            acquiredAt: this.taskLock.clock(),
            leaseMs: this.taskLock.leaseMs,
          });
        }
        if (lock === null) {
          if (attempt + 1 < this.taskLock.attempts) {
            await delay(this.taskLock.retryMs);
          }
          continue;
        }
      }
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    }
    throw new TaskLockTimeoutError();
  }

  async list(): Promise<Task[]> {
    const entries = await this.scanEntries();
    const records = new Map(entries.map(({ record, task }) => [task.taskId, record]));
    this.records.clear();
    for (const [taskId, record] of records) {
      this.records.set(taskId, record);
    }
    return entries.map(({ task }) => task);
  }

  async get(taskId: string): Promise<Task> {
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

  async createIfSourceKeyAbsent(task: Task): Promise<{
    task: Task;
    created: boolean;
  }> {
    assertVaultWriteAllowed(this.root);
    const result = taskSchema.safeParse(task);
    if (!result.success || !hasSafeTaskPaths(result.data)) {
      throw new InvalidTaskDataError();
    }
    const validTask = result.data;
    const lockRoot = join(this.tasksRoot, '.atl', 'source-key-locks');
    const lockKey = createHash('sha256').update(validTask.sourceKey).digest('hex');
    const lockPath = join(lockRoot, `${lockKey}.lock`);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < this.sourceClaim.attempts; attempt += 1) {
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: this.sourceClaim.clock(),
        leaseMs: this.sourceClaim.leaseMs,
      });
      if (lock === null) {
        const reclaimed = await reclaimExpiredSafeFileLock(
          lockPath,
          boundary,
          this.sourceClaim.clock(),
        );
        if (reclaimed) {
          lock = await acquireSafeFileLock(lockPath, boundary, {
            acquiredAt: this.sourceClaim.clock(),
            leaseMs: this.sourceClaim.leaseMs,
          });
        }
        if (lock === null) {
          if (attempt + 1 < this.sourceClaim.attempts) {
            await delay(this.sourceClaim.retryMs);
          }
          continue;
        }
      }
      try {
        const existing = await this.findBySourceKey(validTask.sourceKey);
        if (existing !== null) {
          return { task: existing, created: false };
        }
        return { task: await this.save(validTask), created: true };
      } finally {
        await lock.release();
      }
    }

    const existing = await this.findBySourceKey(validTask.sourceKey);
    if (existing !== null) {
      return { task: existing, created: false };
    }
    throw new TaskSourceClaimTimeoutError();
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
    const cached = this.records.get(validTask.taskId);
    const entries = await this.scanEntries();
    const current = entries.find((entry) => entry.task.taskId === validTask.taskId);
    if (cached !== undefined) {
      if (current === undefined || current.record.snapshot !== cached.snapshot) {
        throw new TaskConflictError();
      }
    }

    const existing = current?.record;
    // Existing-task save updates canonical metadata while preserving the latest disk body.
    const body = existing?.body ?? validTask.body;
    const persistedTask = { ...validTask, body };
    const data = mergeTaskData(existing?.data ?? {}, persistedTask);
    const targetDirectory = lifecycleDirectory(this.tasksRoot, persistedTask);
    const targetPath = join(targetDirectory, `${persistedTask.taskId}.md`);
    const serialized = serializeTaskDocument(data, body);
    if (existing !== undefined && existing.path !== targetPath) {
      try {
        await this.moveTaskFile(existing.path, targetPath, existing.raw);
      } catch {
        throw new TaskConflictError();
      }
      try {
        await this.writeTaskFile(targetPath, serialized);
      } catch {
        let recovered = false;
        try {
          await this.moveTaskFile(targetPath, existing.path, existing.raw);
          recovered = true;
        } catch {
          // Leave the single surviving copy in place for a later rescan/recovery.
        }
        throw new TaskMoveRecoveryError(recovered);
      }
    } else {
      try {
        await this.writeTaskFile(targetPath, serialized);
      } catch (error) {
        if (existing !== undefined) {
          throw new TaskConflictError();
        }
        throw error;
      }
    }
    this.records.set(persistedTask.taskId, {
      path: targetPath,
      data,
      body,
      raw: serialized,
      snapshot: canonicalTaskSnapshot(persistedTask),
    });

    try {
      await rebuildTaskIndex(this.root);
    } catch (error) {
      throw new TaskSavedIndexStaleError({ cause: error });
    }
    return persistedTask;
  }

  protected async writeTaskFile(path: string, content: string): Promise<void> {
    await atomicWriteTextFile(path, content);
  }

  protected async moveTaskFile(
    sourcePath: string,
    targetPath: string,
    expectedContent: string,
  ): Promise<void> {
    await moveSafeRegularFile(sourcePath, targetPath, expectedContent, {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
    });
  }

  private async scanEntries(): Promise<TaskEntry[]> {
    const candidates = (await Promise.all(
      ['Inbox', 'Active', 'Archive'].map(async (directory) => {
        const subtree = join(this.tasksRoot, directory);
        const boundary = {
          vaultRoot: this.root,
          tasksRoot: this.tasksRoot,
          subtree,
        };
        const paths = await listSafeRegularFiles(boundary, '**/*.md');
        return paths.map((path) => ({ path, boundary }));
      }),
    )).flat();
    const entries: TaskEntry[] = [];
    const taskIds = new Set<string>();
    for (const { path, boundary } of candidates) {
      const entry = await this.readEntry(path, boundary);
      if (entry === null) {
        continue;
      }
      if (taskIds.has(entry.task.taskId)) {
        throw new TaskIntegrityError();
      }
      taskIds.add(entry.task.taskId);
      entries.push(entry);
    }
    return entries;
  }

  private async readEntry(
    path: string,
    boundary: StorageReadBoundary,
  ): Promise<TaskEntry | null> {
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      return null;
    }
    const document = parseTaskDocument(raw);
    const task = taskFromRecord({ path, ...document });
    return {
      task,
      record: {
        path,
        ...document,
        raw,
        snapshot: canonicalTaskSnapshot(task),
      },
    };
  }
}
