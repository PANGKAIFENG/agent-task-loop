import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import type { ArtifactResult } from '../domain/artifact.js';

export class ProjectCreateConflictError extends Error {
  readonly code = 'project_create_conflict';

  constructor() {
    super('Project already exists');
    this.name = 'ProjectCreateConflictError';
  }
}

export interface TaskRepository {
  withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T>;
  list(): Promise<Task[]>;
  get(taskId: string): Promise<Task>;
  findBySourceKey(sourceKey: string): Promise<Task | null>;
  createIfSourceKeyAbsent(task: Task): Promise<{
    task: Task;
    created: boolean;
  }>;
  save(task: Task): Promise<Task>;
}

export interface ArtifactRepository {
  write(input: {
    task: Task;
    runId: string;
    agent: string;
    result: ArtifactResult;
    createdAt: string;
  }): Promise<{ ref: string; absolutePath: string }>;
  readSummary(ref: string): Promise<{ summary: string; evidenceCount: number }>;
}

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(projectId: string): Promise<Project>;
  create(project: Project): Promise<Project>;
  save(project: Project): Promise<Project>;
}

export interface AuditEvent {
  event: string;
  at: string;
  taskId?: string;
  projectId?: string;
  runId?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
  count(query: {
    event: string;
    localDate: string;
    mode?: 'automatic' | 'manual';
  }): Promise<number>;
  listForTask(taskId: string): Promise<AuditEvent[]>;
}
