import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';

export interface TaskRepository {
  list(): Promise<Task[]>;
  get(taskId: string): Promise<Task>;
  findBySourceKey(sourceKey: string): Promise<Task | null>;
  save(task: Task): Promise<Task>;
}

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(projectId: string): Promise<Project>;
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
