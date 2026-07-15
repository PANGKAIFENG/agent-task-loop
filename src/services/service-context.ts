import { ulid } from 'ulid';

import type {
  ArtifactRepository,
  AuditLog,
  ProjectRepository,
  TaskRepository,
} from '../storage/contracts.js';

export interface ServiceContext {
  tasks: TaskRepository;
  artifacts: ArtifactRepository;
  projects: ProjectRepository;
  audit: AuditLog;
  clock: () => Date;
  id: () => string;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function createTaskId(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Invalid task ID date');
  }
  const businessDate = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
  ].join('');
  const entropy = ulid(now.getTime()).slice(-8).toLowerCase();
  return `task-${businessDate}-${entropy}`;
}
