import { basename } from 'node:path';

import { projectSchema, type Project } from '../domain/project.js';
import type { ProjectRepository } from './contracts.js';
import {
  atomicWriteTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
} from './file-io.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  projectFilePath,
  taskStorageRoot,
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

  constructor(root?: string) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.projectsRoot = `${this.tasksRoot}/Projects`;
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

  async save(project: Project): Promise<Project> {
    assertVaultWriteAllowed(this.root);
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
