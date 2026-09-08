import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { claimNextTask } from '../../../src/services/claim-next-task.js';
import {
  ClaimTaskExternalExecutionError,
  claimTask,
} from '../../../src/services/claim-task.js';
import { peekNextDecisionContinuation, peekNextTask } from '../../../src/services/query-tasks.js';
import {
  DecisionContinuationExternalExecutionError,
  startDecisionContinuation,
} from '../../../src/services/start-decision-continuation.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260820-xyz00001',
    title: 'Task',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: 'project-1',
    taskType: 'research',
    objective: 'Compare the documented options',
    acceptanceCriteria: ['Cite official sources'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:xyz00001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function multicaTask(overrides: Partial<Task> = {}): Task {
  return baseTask({
    taskId: 'task-20260820-mca00001',
    taskType: 'development',
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    sourceKey: 'test:mca00001',
    ...overrides,
  });
}

describe('external execution exclusion (PRD §6 rule 3)', () => {
  let harness: TestServiceContext;

  beforeEach(async () => {
    harness = await createTestServiceContext();
    await harness.ctx.projects.create({
      projectId: 'project-1',
      name: 'Project One',
      description: '',
      resources: [],
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('entry 1 (manual claim): refuses a Multica task with an explicit error', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(multicaTask());

    await expect(claimTask(harness.ctx, 'task-20260820-mca00001', {
      mode: 'manual',
      agent: 'manual',
      runId: 'run-1',
      leaseMinutes: 15,
    })).rejects.toThrowError(ClaimTaskExternalExecutionError);

    const task = await harness.ctx.tasks.get('task-20260820-mca00001');
    expect(task.claim).toBeNull();
    expect(task.status).toBe('agent_executable');
  });

  it('entry 2 (automatic claim): claimNextTask and peek skip Multica tasks', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(multicaTask());

    expect(await peekNextTask(harness.ctx)).toBeNull();
    const claimed = await claimNextTask(harness.ctx, {
      agent: 'runner',
      runId: 'run-2',
      mode: 'automatic',
      leaseMinutes: 15,
    });
    expect(claimed).toBeNull();
  });

  it('entry 2 (automatic claim): a research task is still claimed when both exist', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(multicaTask());
    await harness.ctx.tasks.createIfSourceKeyAbsent(baseTask({
      taskId: 'task-20260820-res00001',
      sourceKey: 'test:res00001',
    }));

    const claimed = await claimNextTask(harness.ctx, {
      agent: 'runner',
      runId: 'run-3',
      mode: 'automatic',
      leaseMinutes: 15,
    });

    expect(claimed?.taskId).toBe('task-20260820-res00001');
    const multica = await harness.ctx.tasks.get('task-20260820-mca00001');
    expect(multica.claim).toBeNull();
  });

  it('entry 3 (decision continuation): peek never returns a Multica task', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(multicaTask({
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-1',
        selectedOptionId: 'retry',
        selectedOptionLabel: 'Retry',
        responseText: null,
        responseEventId: 'event-1',
        respondedAt: '2026-08-20T00:00:00.000Z',
        continuationRunId: null,
        continuationOfRunId: 'run-9',
      },
    }));

    expect(await peekNextDecisionContinuation(harness.ctx)).toBeNull();
  });

  it('entry 3 (decision continuation): starting one on a Multica task fails closed', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(multicaTask({
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-1',
        selectedOptionId: 'retry',
        selectedOptionLabel: 'Retry',
        responseText: null,
        responseEventId: 'event-1',
        respondedAt: '2026-08-20T00:00:00.000Z',
        continuationRunId: null,
        continuationOfRunId: 'run-9',
      },
    }));

    await expect(startDecisionContinuation(harness.ctx, 'task-20260820-mca00001', {
      decisionRequestId: 'decision-1',
      responseEventId: 'event-1',
      mode: 'automatic',
      agent: 'runner',
      runId: 'run-4',
      leaseMinutes: 15,
    })).rejects.toThrowError(DecisionContinuationExternalExecutionError);

    const task = await harness.ctx.tasks.get('task-20260820-mca00001');
    expect(task.claim).toBeNull();
    expect(task.status).toBe('agent_executable');
  });
});
