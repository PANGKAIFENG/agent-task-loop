import { ulid } from 'ulid';

import type {
  ArtifactRepository,
  AuditLog,
  ProjectRepository,
  TaskRepository,
} from '../storage/contracts.js';
import type { AcceptanceObject } from '../domain/acceptance-object.js';
import type { AcceptanceNotificationRecord } from './notify-acceptance.js';

export interface AcceptanceNotifier {
  (object: AcceptanceObject): Promise<unknown>;
  retryFailed?: () => Promise<AcceptanceNotificationRecord[]>;
}

export interface ServiceContext {
  tasks: TaskRepository;
  artifacts: ArtifactRepository;
  projects: ProjectRepository;
  audit: AuditLog;
  clock: () => Date;
  id: () => string;
  notifyAcceptance?: AcceptanceNotifier;
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
