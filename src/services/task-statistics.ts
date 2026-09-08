import {
  TASK_STATUSES,
  readinessErrors,
  type Task,
} from '../domain/task.js';
import { hasInvalidClaimLease, isClaimEligible, type KnownProjectIds } from './claim-task.js';

// Issue #3 unified task statistics — the single counting rule shared by the
// home model (queryPersonalHome), the task index model (listTasks status
// filtering) and the agent queue model (claim admission).
//
// Vocabulary rules (mirrored mechanically by the workbench.task-statistics/1
// contract in packages/contracts — its tests extract these very arrays from
// this file and from domain/task.ts, so the mirror cannot drift):
// - Workflow statuses have exactly one source: TASK_STATUSES in
//   domain/task.ts. "in_review" in issue/PRD wording maps to `review`; no
//   second status enum exists anywhere.
// - `due` / `scheduled` are time commitments on task frontmatter, never
//   workflow states; `ready` is the human backlog, `agent_executable` is
//   the agent queue admission state.
// - Counting is orthogonal: statusCounts are RAW workflow status counts and
//   always sum to total; agentQueue counts queue admission (isClaimEligible)
//   separately with admitted/quarantined IDs and reasons. The home queue
//   number is agentQueue.admittedCount; the index reads raw status counts.
// - agentQueue.quarantined holds ONLY non-admitted tasks whose status IS
//   agent_executable, so admitted + quarantined always equals the raw
//   agent_executable count. Unknown statuses and corrupt claim leases are
//   INTEGRITY issues (any workflow status) reported in integrityIssues —
//   explicit, never silently counted, and never mixed into the queue.

export const TASK_QUARANTINE_REASONS = [
  'possible_duplicate',
  'unconfirmed',
  'not_ready',
  'decision_continuation_pending',
  'orphan_task',
  'unknown_project',
  'unexpected_claim',
  'invalid_claim_lease',
] as const;

export type TaskQuarantineReason = (typeof TASK_QUARANTINE_REASONS)[number];

export interface QuarantinedTaskRef {
  taskId: string;
  reasons: TaskQuarantineReason[];
}

export interface TaskStatusCounts {
  inbox: number;
  ready: number;
  agentExecutable: number;
  inProgress: number;
  waitingForDecision: number;
  review: number;
  done: number;
  blocked: number;
  cancelled: number;
  unknown: number;
}

export interface AgentQueueStatistics {
  admittedCount: number;
  quarantinedCount: number;
  admittedTaskIds: string[];
  quarantinedTasks: QuarantinedTaskRef[];
}

export interface TaskIntegrityIssues {
  unknownStatusTaskIds: string[];
  invalidClaimLeaseTaskIds: string[];
}

export interface TaskStatistics {
  total: number;
  statusCounts: TaskStatusCounts;
  agentQueue: AgentQueueStatistics;
  integrityIssues: TaskIntegrityIssues;
  expiredClaimTaskIds: string[];
}

export interface ComputeTaskStatisticsOptions {
  now: Date;
  knownProjectIds: KnownProjectIds;
}

export function isKnownTaskStatus(
  status: string,
): status is (typeof TASK_STATUSES)[number] {
  return TASK_STATUSES.some((knownStatus) => knownStatus === status);
}

const STATUS_COUNT_KEYS: Record<(typeof TASK_STATUSES)[number], keyof TaskStatusCounts> = {
  inbox: 'inbox',
  ready: 'ready',
  agent_executable: 'agentExecutable',
  in_progress: 'inProgress',
  waiting_for_decision: 'waitingForDecision',
  review: 'review',
  done: 'done',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

// Explainable exclusion reasons for a task the agent queue must not count.
// Only agent_executable tasks can carry quarantine reasons; for them the
// empty list is exactly equivalent to isClaimEligible(task, knownProjectIds)
// — one rule, two read-outs.
export function taskQuarantineReasons(
  task: Task,
  knownProjectIds: KnownProjectIds,
): TaskQuarantineReason[] {
  if (task.status !== 'agent_executable') {
    return [];
  }
  const reasons: TaskQuarantineReason[] = [];
  if (task.reviewState !== 'confirmed') {
    reasons.push('unconfirmed');
  }
  if (readinessErrors(task).length > 0) {
    reasons.push('not_ready');
  }
  if (task.possibleDuplicateIds.length > 0) {
    reasons.push('possible_duplicate');
  }
  if (task.lastDecision?.continuationRunId === null) {
    reasons.push('decision_continuation_pending');
  }
  if (task.projectId === null || task.projectId.trim() === '') {
    reasons.push('orphan_task');
  } else if (!knownProjectIds.has(task.projectId)) {
    reasons.push('unknown_project');
  }
  if (task.claim !== null) {
    // An agent_executable task must be claim-free; a leftover claim is a
    // contradiction that claimTask surfaces as 'unexpected_claim'.
    reasons.push('unexpected_claim');
    if (hasInvalidClaimLease(task)) {
      reasons.push('invalid_claim_lease');
    }
  }
  return reasons;
}

function isExpiredClaim(task: Task, now: Date): boolean {
  return task.status === 'in_progress'
    && task.claim !== null
    && Number.isFinite(Date.parse(task.claim.leaseExpiresAt))
    && Date.parse(task.claim.leaseExpiresAt) <= now.getTime();
}

export function computeTaskStatistics(
  tasks: Task[],
  options: ComputeTaskStatisticsOptions,
): TaskStatistics {
  const statusCounts: TaskStatusCounts = {
    inbox: 0,
    ready: 0,
    agentExecutable: 0,
    inProgress: 0,
    waitingForDecision: 0,
    review: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    unknown: 0,
  };
  const admittedTaskIds: string[] = [];
  const quarantinedTasks: QuarantinedTaskRef[] = [];
  const unknownStatusTaskIds: string[] = [];
  const invalidClaimLeaseTaskIds: string[] = [];
  const expiredClaimTaskIds: string[] = [];

  for (const task of tasks) {
    const status = task.status;
    if (!isKnownTaskStatus(status)) {
      statusCounts.unknown += 1;
      unknownStatusTaskIds.push(task.taskId);
    } else {
      statusCounts[STATUS_COUNT_KEYS[status]] += 1;
    }
    if (isClaimEligible(task, options.knownProjectIds)) {
      admittedTaskIds.push(task.taskId);
    }
    const reasons = taskQuarantineReasons(task, options.knownProjectIds);
    if (reasons.length > 0) {
      quarantinedTasks.push({ taskId: task.taskId, reasons });
    }
    if (hasInvalidClaimLease(task)) {
      invalidClaimLeaseTaskIds.push(task.taskId);
    }
    if (isExpiredClaim(task, options.now)) {
      expiredClaimTaskIds.push(task.taskId);
    }
  }

  return {
    total: tasks.length,
    statusCounts,
    agentQueue: {
      admittedCount: admittedTaskIds.length,
      quarantinedCount: quarantinedTasks.length,
      admittedTaskIds,
      quarantinedTasks,
    },
    integrityIssues: { unknownStatusTaskIds, invalidClaimLeaseTaskIds },
    expiredClaimTaskIds,
  };
}
