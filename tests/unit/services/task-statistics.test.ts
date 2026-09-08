import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  TASK_QUARANTINE_REASONS,
  computeTaskStatistics,
  isKnownTaskStatus,
  taskQuarantineReasons,
} from '../../../src/services/task-statistics.js';

// Issue #3 unified statistics unit rules — the same synthetic vocabulary used
// by the integration consistency test (tests/integration/services/task-
// statistics-consistency.test.ts). All data is synthetic.
const NOW = new Date('2026-08-15T08:00:00.000Z');
const KNOWN_PROJECTS = new Set(['proj-synthetic']);

function syntheticTask(overrides: Partial<Task>): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-stat-000',
    title: 'Synthetic statistics task',
    body: '\nSynthetic body.\n',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'synthetic-statistics-test',
    sourceDate: '2026-08-14',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:statistics',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-08-14T06:00:00.000Z',
    updatedAt: '2026-08-14T06:00:00.000Z',
    ...overrides,
  };
}

const confirmedReadiness = {
  reviewState: 'confirmed' as const,
  projectId: 'proj-synthetic',
  taskType: 'research' as const,
  objective: 'Synthetic research objective.',
  acceptanceCriteria: ['Synthetic acceptance criterion.'],
  autoExecutable: true,
  permissionProfile: 'read_only_research' as const,
};

describe('computeTaskStatistics', () => {
  it('keeps raw status counts closed over the total', () => {
    const tasks = [
      syntheticTask({ taskId: 't1', status: 'inbox' }),
      syntheticTask({ taskId: 't2', status: 'ready' }),
      syntheticTask({ taskId: 't3', status: 'agent_executable', ...confirmedReadiness }),
      syntheticTask({ taskId: 't4', status: 'in_progress' }),
      syntheticTask({ taskId: 't5', status: 'waiting_for_decision' }),
      syntheticTask({ taskId: 't6', status: 'review' }),
      syntheticTask({ taskId: 't7', status: 'done' }),
      syntheticTask({ taskId: 't8', status: 'blocked' }),
      syntheticTask({ taskId: 't9', status: 'cancelled' }),
      syntheticTask({ taskId: 't10', status: 'legacy-unknown' }),
    ];
    const statistics = computeTaskStatistics(tasks, {
      now: NOW,
      knownProjectIds: KNOWN_PROJECTS,
    });

    expect(statistics.total).toBe(10);
    expect(statistics.statusCounts).toEqual({
      inbox: 1,
      ready: 1,
      agentExecutable: 1,
      inProgress: 1,
      waitingForDecision: 1,
      review: 1,
      done: 1,
      blocked: 1,
      cancelled: 1,
      unknown: 1,
    });
    expect(Object.values(statistics.statusCounts).reduce((sum, n) => sum + n, 0))
      .toBe(statistics.total);
  });

  it('separates raw status counting from agent queue admission', () => {
    const tasks = [
      syntheticTask({ taskId: 'admitted', status: 'agent_executable', ...confirmedReadiness }),
      syntheticTask({ taskId: 'unconfirmed', status: 'agent_executable' }),
      syntheticTask({
        taskId: 'orphan',
        status: 'agent_executable',
        ...confirmedReadiness,
        projectId: null,
      }),
      syntheticTask({
        taskId: 'unknown-project',
        status: 'agent_executable',
        ...confirmedReadiness,
        projectId: 'proj-ghost',
      }),
      syntheticTask({
        taskId: 'duplicate',
        status: 'agent_executable',
        ...confirmedReadiness,
        possibleDuplicateIds: ['admitted'],
      }),
    ];
    const statistics = computeTaskStatistics(tasks, {
      now: NOW,
      knownProjectIds: KNOWN_PROJECTS,
    });

    // Raw status count stays 5; only one task is actually admittable.
    expect(statistics.statusCounts.agentExecutable).toBe(5);
    expect(statistics.agentQueue.admittedCount).toBe(1);
    expect(statistics.agentQueue.admittedTaskIds).toEqual(['admitted']);
    // Quarantine covers ONLY non-admitted agent_executable tasks, so
    // admitted + quarantined always equals the raw status count.
    expect(statistics.agentQueue.quarantinedCount).toBe(4);
    expect(statistics.agentQueue.admittedCount + statistics.agentQueue.quarantinedCount)
      .toBe(statistics.statusCounts.agentExecutable);
    const reasons = new Map(statistics.agentQueue.quarantinedTasks.map((q) => [q.taskId, q.reasons]));
    expect(reasons.get('unconfirmed')).toContain('unconfirmed');
    expect(reasons.get('orphan')).toContain('orphan_task');
    expect(reasons.get('unknown-project')).toContain('unknown_project');
    expect(reasons.get('duplicate')).toContain('possible_duplicate');
  });

  it('keeps unknown statuses and invalid claim leases in integrity issues, not the agent queue', () => {
    const tasks = [
      syntheticTask({ taskId: 'legacy', status: 'legacy-unknown' }),
      syntheticTask({
        taskId: 'in-review-bad-lease',
        status: 'review',
        claim: {
          runId: 'run-corrupt',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-15T06:00:00.000Z',
          leaseExpiresAt: 'not-a-timestamp',
        },
      }),
      syntheticTask({
        taskId: 'agent-bad-lease',
        status: 'agent_executable',
        ...confirmedReadiness,
        claim: {
          runId: 'run-corrupt',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-15T06:00:00.000Z',
          leaseExpiresAt: 'not-a-timestamp',
        },
      }),
    ];
    const statistics = computeTaskStatistics(tasks, {
      now: NOW,
      knownProjectIds: KNOWN_PROJECTS,
    });

    // Integrity issues are reported explicitly and never silently counted.
    expect(statistics.integrityIssues.unknownStatusTaskIds).toEqual(['legacy']);
    expect(statistics.integrityIssues.invalidClaimLeaseTaskIds)
      .toEqual(['in-review-bad-lease', 'agent-bad-lease']);
    // Unknown statuses never enter the agent queue quarantine.
    const quarantinedIds = statistics.agentQueue.quarantinedTasks.map(({ taskId }) => taskId);
    expect(quarantinedIds).not.toContain('legacy');
    // An agent task with a corrupt lease is barred from admission with both
    // the claim and lease reasons.
    const reasons = new Map(statistics.agentQueue.quarantinedTasks.map((q) => [q.taskId, q.reasons]));
    expect(reasons.get('agent-bad-lease')).toEqual(['unexpected_claim', 'invalid_claim_lease']);
    expect(statistics.agentQueue.admittedTaskIds).not.toContain('agent-bad-lease');
    expect(statistics.agentQueue.admittedCount + statistics.agentQueue.quarantinedCount)
      .toBe(statistics.statusCounts.agentExecutable);
  });

  it('does not admit an agent task that already carries a claim', () => {
    const tasks = [
      syntheticTask({
        taskId: 'claimed-again',
        status: 'agent_executable',
        ...confirmedReadiness,
        claim: {
          runId: 'run-existing',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-15T06:00:00.000Z',
          leaseExpiresAt: '2026-08-15T09:00:00.000Z',
        },
      }),
    ];
    const statistics = computeTaskStatistics(tasks, {
      now: NOW,
      knownProjectIds: KNOWN_PROJECTS,
    });

    expect(statistics.agentQueue.admittedCount).toBe(0);
    expect(statistics.agentQueue.quarantinedTasks).toEqual([
      { taskId: 'claimed-again', reasons: ['unexpected_claim'] },
    ]);
  });

  it('reports expired in-progress claims without moving them out of in_progress', () => {
    const tasks = [
      syntheticTask({
        taskId: 'expired',
        status: 'in_progress',
        claim: {
          runId: 'run-synthetic-001',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-15T06:00:00.000Z',
          leaseExpiresAt: '2026-08-15T07:00:00.000Z',
        },
      }),
      syntheticTask({
        taskId: 'running',
        status: 'in_progress',
        claim: {
          runId: 'run-synthetic-002',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-15T07:50:00.000Z',
          leaseExpiresAt: '2026-08-15T09:00:00.000Z',
        },
      }),
    ];
    const statistics = computeTaskStatistics(tasks, {
      now: NOW,
      knownProjectIds: KNOWN_PROJECTS,
    });

    expect(statistics.expiredClaimTaskIds).toEqual(['expired']);
    expect(statistics.statusCounts.inProgress).toBe(2);
  });
});

describe('taskQuarantineReasons', () => {
  it('exposes exactly the documented reason vocabulary', () => {
    expect(TASK_QUARANTINE_REASONS).toEqual([
      'possible_duplicate',
      'unconfirmed',
      'not_ready',
      'decision_continuation_pending',
      'orphan_task',
      'unknown_project',
      'unexpected_claim',
      'invalid_claim_lease',
    ]);
  });

  it('returns no reasons for non-queue workflow statuses', () => {
    expect(taskQuarantineReasons(syntheticTask({ status: 'inbox' }), KNOWN_PROJECTS)).toEqual([]);
    expect(taskQuarantineReasons(syntheticTask({ status: 'done' }), KNOWN_PROJECTS)).toEqual([]);
    expect(isKnownTaskStatus('review')).toBe(true);
    expect(isKnownTaskStatus('in_review')).toBe(false);
  });
});
