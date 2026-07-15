import type { TaskStatus } from './task.js';

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['ready', 'cancelled'],
  ready: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['review', 'ready', 'blocked', 'cancelled'],
  review: ['done', 'ready', 'blocked', 'cancelled'],
  done: ['ready'],
  blocked: ['ready', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
