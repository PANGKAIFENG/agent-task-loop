import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { isClaimEligible, loadKnownProjectIds } from '../../../src/services/claim-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { peekNextTask, listTasks } from '../../../src/services/query-tasks.js';
import { queryPersonalHome } from '../../../src/services/query-personal-home.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

// Issue #3 acceptance: ONE synthetic fixture drives the three production
// models — the task index (listTasks), the home snapshot (queryPersonalHome)
// and the agent queue (isClaimEligible admission + peekNextTask) — and their
// totals, groups and statuses must agree. Every task below is synthetic.
const NOW = new Date('2026-08-15T08:00:00.000Z');

const contexts: TestServiceContext[] = [];

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
  projectId: 'proj-synthetic-stats',
  taskType: 'research' as const,
  objective: 'Synthetic research objective.',
  acceptanceCriteria: ['Synthetic acceptance criterion.'],
  autoExecutable: true,
  permissionProfile: 'read_only_research' as const,
};

// The fixture contains every Issue #3 conflict class: admission gaps
// (unconfirmed / not ready / possible duplicate / unknown project / invalid
// lease), uncounted statuses (waiting_for_decision / done / cancelled), an
// unknown legacy status and an expired in-progress claim.
function statisticsFixture(): Task[] {
  return [
    syntheticTask({
      taskId: 'task-stat-001',
      title: 'Admitted agent task',
      status: 'agent_executable',
      priority: 'high',
      readyAt: '2026-08-14T07:00:00.000Z',
      ...confirmedReadiness,
    }),
    syntheticTask({
      taskId: 'task-stat-002',
      title: 'Unconfirmed agent task',
      status: 'agent_executable',
      projectId: 'proj-synthetic-stats',
      taskType: 'research',
      objective: 'Synthetic objective.',
      acceptanceCriteria: ['Synthetic criterion.'],
      permissionProfile: 'read_only_research',
      reviewState: 'candidate',
    }),
    syntheticTask({
      taskId: 'task-stat-003',
      title: 'Orphan agent task without a project',
      status: 'agent_executable',
      ...confirmedReadiness,
      projectId: null,
    }),
    syntheticTask({
      taskId: 'task-stat-004',
      title: 'Waiting for decision task',
      status: 'waiting_for_decision',
    }),
    syntheticTask({ taskId: 'task-stat-005', title: 'Done task', status: 'done' }),
    syntheticTask({
      taskId: 'task-stat-006',
      title: 'Unknown legacy status task',
      status: 'legacy-unknown',
    }),
    syntheticTask({
      taskId: 'task-stat-007',
      title: 'Flagged possible duplicate agent task',
      status: 'agent_executable',
      ...confirmedReadiness,
      possibleDuplicateIds: ['task-stat-001'],
    }),
    syntheticTask({
      taskId: 'task-stat-008',
      title: 'Expired in-progress claim task',
      status: 'in_progress',
      claim: {
        runId: 'run-synthetic-001',
        agent: 'synthetic-agent',
        claimedAt: '2026-08-15T06:00:00.000Z',
        leaseExpiresAt: '2026-08-15T07:00:00.000Z',
      },
    }),
    syntheticTask({ taskId: 'task-stat-009', title: 'Inbox task', status: 'inbox' }),
    syntheticTask({ taskId: 'task-stat-010', title: 'Ready backlog task', status: 'ready' }),
    syntheticTask({ taskId: 'task-stat-011', title: 'Review task', status: 'review' }),
    syntheticTask({ taskId: 'task-stat-012', title: 'Blocked task', status: 'blocked' }),
    syntheticTask({ taskId: 'task-stat-013', title: 'Cancelled task', status: 'cancelled' }),
    syntheticTask({
      taskId: 'task-stat-014',
      title: 'Unregistered project agent task',
      status: 'agent_executable',
      ...confirmedReadiness,
      projectId: 'proj-ghost-unregistered',
    }),
    syntheticTask({
      taskId: 'task-stat-015',
      title: 'Corrupted lease agent task',
      status: 'agent_executable',
      ...confirmedReadiness,
      claim: {
        runId: 'run-synthetic-corrupt',
        agent: 'synthetic-agent',
        claimedAt: '2026-08-15T06:00:00.000Z',
        leaseExpiresAt: 'not-a-timestamp',
      },
    }),
  ];
}

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: NOW });
  contexts.push(context);
  await createProject(context.ctx, {
    projectId: 'proj-synthetic-stats',
    name: 'Synthetic Statistics Project',
    description: 'Synthetic project fixture.',
    resources: [],
  });
  for (const task of statisticsFixture()) {
    await context.ctx.tasks.save(task);
  }
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('unified task statistics across production models (Issue #3)', () => {
  it('keeps listTasks, queryPersonalHome and the agent queue consistent on one fixture', async () => {
    const context = await makeContext();

    // Production task index model.
    const indexed = await listTasks(context.ctx);
    // Production home model.
    const home = queryPersonalHome({
      tasks: indexed,
      projects: await context.ctx.projects.list(),
      now: NOW,
    });
    // Production queue admission rule + project registry.
    const knownProjectIds = await loadKnownProjectIds(context.ctx);

    // Totals agree across models.
    expect(home.total).toBe(indexed.length);
    expect(Object.values(home.counts).reduce((sum, count) => sum + count, 0))
      .toBe(indexed.length);

    // Status groups agree between home and the index model.
    const expectations: Array<[keyof typeof home.counts, string]> = [
      ['inbox', 'inbox'],
      ['ready', 'ready'],
      ['agentExecutable', 'agent_executable'],
      ['inProgress', 'in_progress'],
      ['waitingForDecision', 'waiting_for_decision'],
      ['review', 'review'],
      ['done', 'done'],
      ['blocked', 'blocked'],
      ['cancelled', 'cancelled'],
      ['unknown', 'legacy-unknown'],
    ];
    for (const [countKey, status] of expectations) {
      const indexedForStatus = await listTasks(context.ctx, status);
      expect(home.counts[countKey]).toBe(indexedForStatus.length);
    }

    // Queue admission agrees: the home admitted list is exactly the index
    // filtered through the production claim predicate.
    const admittedByQueue = indexed
      .filter((task) => isClaimEligible(task, knownProjectIds))
      .map((task) => task.taskId);
    expect(home.agentQueue.admittedTaskIds).toEqual(admittedByQueue);
    expect(home.agentQueue.admittedCount).toBe(admittedByQueue.length);
    expect(home.agentQueue.admittedTaskIds).toEqual(['task-stat-001']);

    // Quarantined tasks never overlap the admitted list.
    const quarantinedIds = new Set(home.agentQueue.quarantinedTasks.map(({ taskId }) => taskId));
    for (const taskId of home.agentQueue.admittedTaskIds) {
      expect(quarantinedIds.has(taskId)).toBe(false);
    }
  });

  it('explains every quarantined task with explicit reasons', async () => {
    const context = await makeContext();
    const home = queryPersonalHome({
      tasks: await listTasks(context.ctx),
      projects: await context.ctx.projects.list(),
      now: NOW,
    });

    const reasons = new Map(home.agentQueue.quarantinedTasks.map((q) => [q.taskId, q.reasons]));
    expect(reasons.get('task-stat-002')).toContain('unconfirmed');
    expect(reasons.get('task-stat-003')).toContain('orphan_task');
    expect(reasons.get('task-stat-007')).toContain('possible_duplicate');
    expect(reasons.get('task-stat-014')).toContain('unknown_project');
    expect(reasons.get('task-stat-015')).toEqual(['unexpected_claim', 'invalid_claim_lease']);
    // Integrity issues are reported separately and never enter the queue.
    expect(reasons.has('task-stat-006')).toBe(false);
    expect(home.integrityIssues.unknownStatusTaskIds).toEqual(['task-stat-006']);
    expect(home.integrityIssues.invalidClaimLeaseTaskIds).toEqual(['task-stat-015']);
    expect(home.expiredClaimTaskIds).toEqual(['task-stat-008']);
    // admitted + quarantined always closes over the raw agent_executable count.
    expect(home.agentQueue.admittedCount + home.agentQueue.quarantinedCount)
      .toBe(home.counts.agentExecutable);
  });

  it('makes peekNextTask pick the same task the statistics admit first', async () => {
    const context = await makeContext();

    const peeked = await peekNextTask(context.ctx);
    expect(peeked?.taskId).toBe('task-stat-001');
  });

  it('keeps home output traceable to project and source without private content', async () => {
    const context = await makeContext();
    const home = queryPersonalHome({
      tasks: await listTasks(context.ctx),
      projects: await context.ctx.projects.list(),
      now: NOW,
    });

    const admitted = home.focusTasks.find((task) => task.taskId === 'task-stat-001');
    expect(admitted?.projectName).toBe('Synthetic Statistics Project');
    expect(admitted?.origin).toBe('synthetic-statistics-test');
    expect(JSON.stringify(home)).not.toContain('Synthetic body.');
    expect(JSON.stringify(home)).not.toContain('sourceQuote');
  });
});
