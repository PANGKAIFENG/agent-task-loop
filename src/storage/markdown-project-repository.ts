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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function projectFromRecord(record: ProjectRecord): Project {
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
  readonly projectsRoot: string;
  readonly records = new Map<string, ProjectRecord>();

  constructor(root?: string) {
    this.root = vaultRoot(root);
    this.projectsRoot = `${taskStorageRoot(this.root)}/Projects`;
  }

  async list(): Promise<Project[]> {
    const paths = await listSafeRegularFiles(this.projectsRoot, '*.md');
    const projects: Project[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, this.projectsRoot);
      if (raw === null) {
        continue;
      }
      const document = parseTaskDocument(raw);
      const record = { path, ...document };
      const project = projectFromRecord(record);
      this.records.set(project.projectId, record);
      projects.push(project);
    }
    return projects;
  }

  async get(projectId: string): Promise<Project> {
    if (!isSafePathSegment(projectId)) {
      throw new InvalidProjectDataError();
    }
    const cached = this.records.get(projectId);
    if (cached !== undefined) {
      return projectFromRecord(cached);
    }
    let path: string;
    try {
      path = projectFilePath(this.root, projectId);
    } catch {
      throw new ProjectNotFoundError(projectId);
    }
    try {
      const raw = await readSafeTextFile(path, this.projectsRoot);
      if (raw === null) {
        throw new ProjectNotFoundError(projectId);
      }
      const document = parseTaskDocument(raw);
      const record = { path, ...document };
      const project = projectFromRecord(record);
      this.records.set(project.projectId, record);
      return project;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new ProjectNotFoundError(projectId);
      }
      throw error;
    }
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
    let existing = this.records.get(validProject.projectId);
    if (existing === undefined) {
      try {
        await this.get(validProject.projectId);
        existing = this.records.get(validProject.projectId);
      } catch (error) {
        if (!(error instanceof ProjectNotFoundError)) {
          throw error;
        }
      }
    }
    const data = mergeProjectData(existing?.data ?? {}, validProject);
    const body = existing?.body ?? '\n';
    const path = projectFilePath(this.root, validProject.projectId);
    await atomicWriteTextFile(path, serializeTaskDocument(data, body));
    this.records.set(validProject.projectId, { path, data, body });
    return validProject;
  }
}
