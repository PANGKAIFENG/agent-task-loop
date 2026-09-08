import {
  TASK_STATUSES,
  type ControlledTaskStatus,
  type TaskStatus,
} from './task-status.js';

const transitions: Record<ControlledTaskStatus, readonly ControlledTaskStatus[]> = {
  inbox: ['ready', 'cancelled'],
  ready: ['agent_executable', 'in_progress', 'blocked', 'cancelled'],
  // PAW-GOAL-003 T1 (TECH §3): externally executed tasks move from
  // agent_executable into waiting_for_decision or review driven by external
  // events, so both paths must be legal transitions even though the local
  // runner never claims these tasks.
  agent_executable: [
    'in_progress',
    'waiting_for_decision',
    'review',
    'blocked',
    'cancelled',
  ],
  in_progress: [
    'waiting_for_decision',
    'review',
    'ready',
    'agent_executable',
    'blocked',
    'cancelled',
  ],
  waiting_for_decision: ['agent_executable', 'blocked', 'cancelled'],
  review: ['done', 'ready', 'agent_executable', 'blocked', 'cancelled'],
  done: ['ready'],
  // PAW-GOAL-003 T2 (TECH §3.1): a recoverable blocked/failed event may be
  // reworked from DingTalk, returning the externally executed task to
  // agent_executable so the Multica supervisor can resume it.
  blocked: ['ready', 'agent_executable', 'cancelled'],
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
