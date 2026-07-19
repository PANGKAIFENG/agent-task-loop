import {
  TASK_STATUSES,
  type ControlledTaskStatus,
  type TaskStatus,
} from './task.js';

const transitions: Record<ControlledTaskStatus, readonly ControlledTaskStatus[]> = {
  inbox: ['ready', 'cancelled'],
  ready: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['review', 'ready', 'blocked', 'cancelled'],
  review: ['done', 'ready', 'blocked', 'cancelled'],
  done: ['ready'],
  blocked: ['ready', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (!isControlledTaskStatus(from) || !isControlledTaskStatus(to)) {
    return false;
  }
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

function isControlledTaskStatus(status: TaskStatus): status is ControlledTaskStatus {
  return TASK_STATUSES.some((knownStatus) => knownStatus === status);
}
