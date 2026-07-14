import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  ClaimTaskAuditFailedError,
  ClaimTaskNotEligibleError,
  claimTask,
} from '../../../src/services/claim-task.js';
import { claimNextTask } from '../../../src/services/claim-next-task.js';
import {
  RecoverExpiredClaimAuditFailedError,
  recoverExpiredClaims,
} from '../../../src/services/recover-expired-claims.js';
import { TaskSavedIndexStaleError } from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext();
  contexts.push(context);
  return context;
}

function readyTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-ready-default',
    title: 'Synthetic public research task',
    body: '\nSanitized synthetic task body.\n',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-public-research',
    taskType: 'research',
    objective: 'Research public evidence.',
    acceptanceCriteria: ['Cite one public source.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_claim_test',
    sourceDate: '2026-07-14',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:claim-default',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-07-14T07:00:00.000Z',
    createdAt: '2026-07-14T06:00:00.000Z',
    updatedAt: '2026-07-14T07:00:00.000Z',
    ...overrides,
  };
}

async function saveReadyTasks(
  context: TestServiceContext,
  tasks: Task[],
): Promise<void> {
  for (const task of tasks) {
    await context.ctx.tasks.save(task);
  }
}

const automaticOptions = {
  agent: 'synthetic-agent',
  runId: 'run-synthetic-automatic',
  mode: 'automatic' as const,
  dailyLimit: 3,
  leaseMinutes: 15,
};

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('claimNextTask', () => {
  it('claims urgent before high and the older ready task within one priority', async () => {
    const context = await makeContext();
    const highOld = readyTask({
      taskId: 'task-high-old',
      sourceKey: 'synthetic:high-old',
      priority: 'high',
      readyAt: '2026-07-14T05:00:00.000Z',
    });
    const urgentNew = readyTask({
      taskId: 'task-urgent-new',
      sourceKey: 'synthetic:urgent-new',
      priority: 'urgent',
      readyAt: '2026-07-14T06:00:00.000Z',
    });
    const urgentOld = readyTask({
      taskId: 'task-urgent-old',
      sourceKey: 'synthetic:urgent-old',
      priority: 'urgent',
      readyAt: '2026-07-14T04:00:00.000Z',
    });
    await saveReadyTasks(context, [highOld, urgentNew, urgentOld]);

    const claimed = await claimNextTask(context.ctx, automaticOptions);

    expect(claimed).toMatchObject({
      taskId: urgentOld.taskId,
      status: 'in_progress',
      attempts: 1,
      claim: {
        agent: automaticOptions.agent,
        runId: automaticOptions.runId,
        claimedAt: '2026-07-14T00:00:00.000Z',
        leaseExpiresAt: '2026-07-14T00:15:00.000Z',
      },
    });
    const persisted = await context.ctx.tasks.list();
    expect(persisted.filter(({ status }) => status === 'in_progress'))
      .toHaveLength(1);
    expect(persisted.find(({ taskId }) => taskId === highOld.taskId)?.status)
      .toBe('ready');
    expect(persisted.find(({ taskId }) => taskId === urgentNew.taskId)?.status)
      .toBe('ready');
  });

  it('excludes Inbox, non-research, and non-auto-executable tasks', async () => {
    const context = await makeContext();
    const inbox = readyTask({
      taskId: 'task-inbox',
      sourceKey: 'synthetic:inbox',
      status: 'inbox',
      reviewState: 'ready_for_confirm',
      projectId: null,
      readyAt: null,
    });
    const nonResearch = readyTask({
      taskId: 'task-non-research',
      sourceKey: 'synthetic:non-research',
      taskType: null,
      priority: 'urgent',
    });
    const nonAuto = readyTask({
      taskId: 'task-non-auto',
      sourceKey: 'synthetic:non-auto',
      autoExecutable: false,
      priority: 'urgent',
    });
    const eligible = readyTask({
      taskId: 'task-eligible',
      sourceKey: 'synthetic:eligible',
      priority: 'low',
    });
    await saveReadyTasks(context, [inbox, nonResearch, nonAuto, eligible]);

    await expect(claimNextTask(context.ctx, automaticOptions)).resolves
      .toMatchObject({ taskId: eligible.taskId });
    await expect(context.ctx.tasks.get(inbox.taskId)).resolves
      .toMatchObject({ status: 'inbox', attempts: 0, claim: null });
    await expect(context.ctx.tasks.get(nonResearch.taskId)).resolves
      .toMatchObject({ status: 'ready', attempts: 0, claim: null });
    await expect(context.ctx.tasks.get(nonAuto.taskId)).resolves
      .toMatchObject({ status: 'ready', attempts: 0, claim: null });
  });

  it('stops automatic claims at the local-date quota but permits a manual claim', async () => {
    const context = await makeContext();
    const automaticCandidate = readyTask({
      taskId: 'task-quota-automatic',
      sourceKey: 'synthetic:quota-automatic',
    });
    const manualCandidate = readyTask({
      taskId: 'task-quota-manual',
      sourceKey: 'synthetic:quota-manual',
    });
    await saveReadyTasks(context, [automaticCandidate, manualCandidate]);
    for (let index = 0; index < 3; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-14T00:00:0${index}.000Z`,
        taskId: `task-already-claimed-${index}`,
        details: { mode: 'automatic' },
      });
    }
    await context.ctx.audit.append({
      event: 'task.claimed',
      at: '2026-07-14T00:00:10.000Z',
      taskId: 'task-earlier-manual',
      details: { mode: 'manual' },
    });

    await expect(claimNextTask(context.ctx, automaticOptions)).resolves.toBeNull();
    await expect(context.ctx.tasks.get(automaticCandidate.taskId)).resolves
      .toMatchObject({ status: 'ready', attempts: 0, claim: null });

    const manuallyClaimed = await claimTask(
      context.ctx,
      manualCandidate.taskId,
      { mode: 'manual' },
    );

    expect(manuallyClaimed).toMatchObject({
      taskId: manualCandidate.taskId,
      status: 'in_progress',
      attempts: 1,
    });
    await expect(context.ctx.audit.count({
      event: 'task.claimed',
      localDate: '2026-07-14',
      mode: 'automatic',
    })).resolves.toBe(3);
    await expect(context.ctx.audit.count({
      event: 'task.claimed',
      localDate: '2026-07-14',
      mode: 'manual',
    })).resolves.toBe(2);
  });

  it('serializes the automatic quota check with the claim across contexts', async () => {
    const context = await makeContext();
    const independent = context.createIndependentContext();
    await saveReadyTasks(context, [
      readyTask({
        taskId: 'task-concurrent-first',
        sourceKey: 'synthetic:concurrent-first',
      }),
      readyTask({
        taskId: 'task-concurrent-second',
        sourceKey: 'synthetic:concurrent-second',
      }),
    ]);
    for (let index = 0; index < 2; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-14T00:00:0${index}.000Z`,
        taskId: `task-prior-automatic-${index}`,
        details: { mode: 'automatic' },
      });
    }

    const results = await Promise.all([
      claimNextTask(context.ctx, {
        ...automaticOptions,
        runId: 'run-concurrent-left',
      }),
      claimNextTask(independent, {
        ...automaticOptions,
        runId: 'run-concurrent-right',
      }),
    ]);

    expect(results.filter((task) => task !== null)).toHaveLength(1);
    expect(results.filter((task) => task === null)).toHaveLength(1);
    expect((await context.ctx.tasks.list())
      .filter(({ status }) => status === 'in_progress')).toHaveLength(1);
    await expect(context.ctx.audit.count({
      event: 'task.claimed',
      localDate: '2026-07-14',
      mode: 'automatic',
    })).resolves.toBe(3);
  });
});

describe('claimTask', () => {
  it.each([
    ['Inbox', { status: 'inbox', reviewState: 'ready_for_confirm' }],
    ['non-research', { taskType: null }],
    ['non-auto-executable', { autoExecutable: false }],
  ] as const)('rejects an otherwise valid %s task', async (_label, overrides) => {
    const context = await makeContext();
    const task = readyTask({
      taskId: `task-manual-rejected-${_label}`,
      sourceKey: `synthetic:manual-rejected-${_label}`,
      ...overrides,
    });
    await context.ctx.tasks.save(task);

    await expect(claimTask(context.ctx, task.taskId, { mode: 'manual' }))
      .rejects.toBeInstanceOf(ClaimTaskNotEligibleError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      status: task.status,
      attempts: 0,
      claim: null,
    });
  });

  it('restores the Ready task when the claim audit append fails', async () => {
    const context = await makeContext();
    const task = readyTask({
      taskId: 'task-claim-audit-failure',
      sourceKey: 'synthetic:claim-audit-failure',
    });
    await context.ctx.tasks.save(task);
    context.ctx.audit.append = async () => {
      throw new Error('synthetic private audit failure');
    };

    const error = await claimTask(
      context.ctx,
      task.taskId,
      { mode: 'manual' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaimTaskAuditFailedError);
    expect(error).toMatchObject({
      code: 'task_claim_audit_failed',
      message: 'Task claim audit failed',
    });
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
  });

  it('audits a committed claim before reporting a stale task index', async () => {
    const context = await makeContext();
    const task = readyTask({
      taskId: 'task-claim-stale-index',
      sourceKey: 'synthetic:claim-stale-index',
    });
    await context.ctx.tasks.save(task);
    const saveTask = context.ctx.tasks.save.bind(context.ctx.tasks);
    context.ctx.tasks.save = async (submitted) => {
      const saved = await saveTask(submitted);
      if (submitted.status === 'in_progress') {
        throw new TaskSavedIndexStaleError();
      }
      return saved;
    };

    const error = await claimTask(
      context.ctx,
      task.taskId,
      { mode: 'manual' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaskSavedIndexStaleError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      status: 'in_progress',
      attempts: 1,
    });
    await expect(context.ctx.audit.count({
      event: 'task.claimed',
      localDate: '2026-07-14',
      mode: 'manual',
    })).resolves.toBe(1);
  });
});

describe('recoverExpiredClaims', () => {
  it('returns an expired claim to Ready without incrementing attempts or changing body', async () => {
    const context = await makeContext();
    const body = '\nSanitized body without runtime error metadata.\n';
    const expired = readyTask({
      taskId: 'task-expired-claim',
      sourceKey: 'synthetic:expired-claim',
      body,
      status: 'in_progress',
      attempts: 2,
      claim: {
        runId: 'run-expired',
        agent: 'synthetic-agent',
        claimedAt: '2026-07-13T23:00:00.000Z',
        leaseExpiresAt: '2026-07-13T23:59:59.999Z',
      },
    });
    await context.ctx.tasks.save(expired);

    const recovered = await recoverExpiredClaims(context.ctx);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      taskId: expired.taskId,
      status: 'ready',
      attempts: 2,
      claim: null,
      body,
    });
    const persisted = await context.ctx.tasks.get(expired.taskId);
    expect(persisted.body).toBe(body);
    expect(persisted.body).not.toContain('lease_expired');
    expect(await context.ctx.audit.listForTask(expired.taskId)).toContainEqual({
      event: 'task.claim_expired',
      at: '2026-07-14T00:00:00.000Z',
      taskId: expired.taskId,
      runId: 'run-expired',
      details: { lastError: 'lease_expired' },
    });
  });

  it('restores the in-progress claim when the expiry audit append fails', async () => {
    const context = await makeContext();
    const expired = readyTask({
      taskId: 'task-expired-audit-failure',
      sourceKey: 'synthetic:expired-audit-failure',
      status: 'in_progress',
      attempts: 2,
      claim: {
        runId: 'run-expired-audit-failure',
        agent: 'synthetic-agent',
        claimedAt: '2026-07-13T23:00:00.000Z',
        leaseExpiresAt: '2026-07-13T23:59:59.999Z',
      },
    });
    await context.ctx.tasks.save(expired);
    context.ctx.audit.append = async () => {
      throw new Error('synthetic private audit failure');
    };

    await expect(recoverExpiredClaims(context.ctx))
      .rejects.toBeInstanceOf(RecoverExpiredClaimAuditFailedError);
    await expect(context.ctx.tasks.get(expired.taskId)).resolves.toEqual(expired);
  });
});
