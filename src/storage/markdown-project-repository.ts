import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { projectSchema, type Project } from '../domain/project.js';
import {
  ProjectCreateConflictError,
  type ProjectRepository,
} from './contracts.js';
import {
  atomicCreateTextFile,
  atomicWriteTextFile,
  acquireSafeFileLock,
  listSafeRegularFiles,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
} from './file-io.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  projectFilePath,
  taskStorageRoot,
  type VaultWriteAuthorization,
  vaultRoot,
} from './task-paths.js';

interface ProjectRecord {
  path: string;
  data: Record<string, unknown>;
  body: string;
  snapshot: string;
}

interface ProjectEntry {
  project: Project;
  record: ProjectRecord;
}

export class ProjectNotFoundError extends Error {
  readonly code = 'project_not_found';

  constructor(projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class InvalidProjectDataError extends Error {
  readonly code = 'invalid_project_data';

  constructor() {
    super('Invalid project data');
    this.name = 'InvalidProjectDataError';
  }
}

export class ProjectConflictError extends Error {
  readonly code = 'project_conflict';

  constructor() {
    super('Project storage conflict');
    this.name = 'ProjectConflictError';
  }
}

export class ProjectIntegrityError extends Error {
  readonly code = 'project_integrity_error';

  constructor() {
    super('Project storage integrity error');
    this.name = 'ProjectIntegrityError';
  }
}

export class ProjectLockTimeoutError extends Error {
  readonly code = 'project_lock_timeout';

  constructor() {
    super('Project lock timed out');
    this.name = 'ProjectLockTimeoutError';
  }
}

const PROJECT_LOCK_ATTEMPTS = 3_100;
const PROJECT_LOCK_RETRY_MS = 10;
const PROJECT_LOCK_LEASE_MS = 30_000;

interface ProjectLockOptions {
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

export interface MarkdownProjectRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
  projectLock?: {
    attempts?: number;
    retryMs?: number;
    leaseMs?: number;
    clock?: () => Date;
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function projectFromRecord(
  record: Pick<ProjectRecord, 'path' | 'data' | 'body'>,
): Project {
  const data = record.data;
  const result = projectSchema.safeParse({
    projectId: stringValue(data.project_id) || basename(record.path, '.md'),
    name: stringValue(data.name),
    description: stringValue(data.description),
    resources: data.resources ?? [],
    createdAt: stringValue(data.created_at),
    updatedAt: stringValue(data.updated_at),
  });
  if (!result.success) {
    throw new InvalidProjectDataError();
  }
  return result.data;
}

function canonicalProjectSnapshot(project: Project): string {
  return JSON.stringify(project);
}

function mergeProjectData(
  original: Record<string, unknown>,
  project: Project,
): Record<string, unknown> {
  return {
    ...original,
    type: 'project',
    project_id: project.projectId,
    name: project.name,
    description: project.description,
    resources: project.resources,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

export class MarkdownProjectRepository implements ProjectRepository {
  readonly root: string;
  readonly tasksRoot: string;
  readonly projectsRoot: string;
  readonly records = new Map<string, ProjectRecord>();
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;
  private readonly projectLock: ProjectLockOptions;
  private readonly heldProjectLocks = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(root?: string, options: MarkdownProjectRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.projectsRoot = `${this.tasksRoot}/Projects`;
    this.writeAuthorization = options.writeAuthorization;
    this.projectLock = {
      attempts: positiveInteger(options.projectLock?.attempts, PROJECT_LOCK_ATTEMPTS),
      retryMs: nonNegativeInteger(options.projectLock?.retryMs, PROJECT_LOCK_RETRY_MS),
      leaseMs: positiveInteger(options.projectLock?.leaseMs, PROJECT_LOCK_LEASE_MS),
      clock: options.projectLock?.clock ?? (() => new Date()),
    };
  }

  async withProjectLock<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    if (!isSafePathSegment(projectId)) {
      throw new InvalidProjectDataError();
    }
    const inheritedLocks = this.heldProjectLocks.getStore();
    if (inheritedLocks?.has(projectId) === true) {
      return operation();
    }
    const lockRoot = join(this.tasksRoot, '.atl', 'project-locks');
    const lockKey = createHash('sha256').update(projectId).digest('hex');
    const lockPath = join(lockRoot, `${lockKey}.lock`);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < this.projectLock.attempts; attempt += 1) {
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: this.projectLock.clock(),
        leaseMs: this.projectLock.leaseMs,
      });
      if (lock === null) {
        const reclaimed = await reclaimExpiredSafeFileLock(
          lockPath,
          boundary,
          this.projectLock.clock(),
        );
        if (reclaimed) {
          lock = await acquireSafeFileLock(lockPath, boundary, {
            acquiredAt: this.projectLock.clock(),
            leaseMs: this.projectLock.leaseMs,
          });
        }
        if (lock === null) {
          if (attempt + 1 < this.projectLock.attempts) {
            await delay(this.projectLock.retryMs);
          }
          continue;
        }
      }
      try {
        return await this.heldProjectLocks.run(
          new Set([...(inheritedLocks ?? []), projectId]),
          operation,
        );
      } finally {
        await lock.release();
      }
    }
    throw new ProjectLockTimeoutError();
  }

  async list(): Promise<Project[]> {
    const entries = await this.scanEntries();
    this.records.clear();
    for (const { project, record } of entries) {
      this.records.set(project.projectId, record);
    }
    return entries.map(({ project }) => project);
  }

  async get(projectId: string): Promise<Project> {
    if (!isSafePathSegment(projectId)) {
      throw new InvalidProjectDataError();
    }
    const projects = await this.list();
    const project = projects.find((candidate) => candidate.projectId === projectId);
    if (project === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  async create(project: Project): Promise<Project> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const result = projectSchema.safeParse(project);
    if (!result.success || !isSafePathSegment(result.data.projectId)) {
      throw new InvalidProjectDataError();
    }
    const validProject = result.data;
    const data = mergeProjectData({}, validProject);
    const body = '\n';
    const path = projectFilePath(this.root, validProject.projectId);
    const created = await atomicCreateTextFile(
      path,
      serializeTaskDocument(data, body),
      {
        vaultRoot: this.root,
        tasksRoot: this.tasksRoot,
        subtree: this.projectsRoot,
      },
    );
    if (!created) {
      throw new ProjectCreateConflictError();
    }
    this.records.set(validProject.projectId, {
      path,
      data,
      body,
      snapshot: canonicalProjectSnapshot(validProject),
    });
    return validProject;
  }

  async save(project: Project): Promise<Project> {
    return this.withProjectLock(project.projectId, () => this.saveUnlocked(project));
  }

  private async saveUnlocked(project: Project): Promise<Project> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const result = projectSchema.safeParse(project);
    if (!result.success) {
      throw new InvalidProjectDataError();
    }
    const validProject = result.data;
    if (!isSafePathSegment(validProject.projectId)) {
      throw new InvalidProjectDataError();
    }
    const cached = this.records.get(validProject.projectId);
    const entries = await this.scanEntries();
    const current = entries.find((entry) => (
      entry.project.projectId === validProject.projectId
    ));
    if (cached !== undefined) {
      if (current === undefined || current.record.snapshot !== cached.snapshot) {
        throw new ProjectConflictError();
      }
    }
    const existing = current?.record;
    const data = mergeProjectData(existing?.data ?? {}, validProject);
    const body = existing?.body ?? '\n';
    const path = existing?.path ?? projectFilePath(this.root, validProject.projectId);
    try {
      await atomicWriteTextFile(path, serializeTaskDocument(data, body));
    } catch (error) {
      if (existing !== undefined) {
        throw new ProjectConflictError();
      }
      throw error;
    }
    this.records.set(validProject.projectId, {
      path,
      data,
      body,
      snapshot: canonicalProjectSnapshot(validProject),
    });
    return validProject;
  }

  private async scanEntries(): Promise<ProjectEntry[]> {
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: this.projectsRoot,
    };
    const paths = await listSafeRegularFiles(boundary, '*.md');
    const entries: ProjectEntry[] = [];
    const projectIds = new Set<string>();
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) {
        continue;
      }
      const document = parseTaskDocument(raw);
      const project = projectFromRecord({ path, ...document });
      if (projectIds.has(project.projectId)) {
        throw new ProjectIntegrityError();
      }
      projectIds.add(project.projectId);
      entries.push({
        project,
        record: {
          path,
          ...document,
          snapshot: canonicalProjectSnapshot(project),
        },
      });
    }
    return entries;
  }
}
