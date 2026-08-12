import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { recordDecision } from '../../../src/services/record-decision.js';
import { requestDecision } from '../../../src/services/request-decision.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-07-15T00:00:00.000Z';
const contexts: TestServiceContext[] = [];

function inProgressTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-decision-001',
    title: 'Decision lifecycle task',
    body: '',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-decision',
    taskType: 'research',
    objective: 'Choose one documented direction.',
    acceptanceCriteria: ['Record the user choice.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:decision-001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-decision-001',
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-15T01:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function setup(): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: new Date(NOW) });
  contexts.push(context);
  await context.ctx.tasks.save(inProgressTask());
  return context;
}

async function pause(
  context: TestServiceContext,
  taskId = 'task-decision-001',
  decisionRequestId = 'decision-001',
): Promise<void> {
  const task = await context.ctx.tasks.get(taskId);
  if (task.claim === null) throw new Error('Decision fixture requires a claimed task');
  await requestDecision(context.ctx, taskId, {
    kind: 'decision_request',
    decisionRequestId,
    question: 'Which direction should continue?',
    options: [
      { id: 'option-a', label: 'Option A' },
      { id: 'option-b', label: 'Option B' },
    ],
    runId: task.claim.runId,
  });
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('decision lifecycle', () => {
  it('releases the claim while waiting and persists the selected option for resumption', async () => {
    const context = await setup();

    await pause(context);
    await expect(context.ctx.tasks.get('task-decision-001')).resolves.toMatchObject({
      status: 'waiting_for_decision',
      claim: null,
      pendingDecision: {
        requestId: 'decision-001',
        requestedByRunId: 'run-decision-001',
      },
    });

    await expect(recordDecision(context.ctx, 'task-decision-001', {
      decisionRequestId: 'decision-001',
      responseEventId: 'dingtalk-event-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use B and continue.',
    })).resolves.toMatchObject({
      accepted: true,
      task: {
        status: 'agent_executable',
        pendingDecision: null,
        lastDecision: {
          requestId: 'decision-001',
          selectedOptionId: 'option-b',
          selectedOptionLabel: 'Option B',
          responseEventId: 'dingtalk-event-001',
          senderUserId: 'trusted-user-001',
          conversationId: 'trusted-conversation-001',
        },
      },
    });

    const reloaded = await context.createIndependentContext().tasks
      .get('task-decision-001');
    expect(reloaded).toMatchObject({
      status: 'agent_executable',
      lastDecision: { responseText: 'Use B and continue.' },
    });
    const audit = await context.ctx.audit.listForTask('task-decision-001');
    expect(audit.map(({ event }) => event)).toEqual([
      'decision.requested',
      'decision.received',
    ]);
  });

  it('accepts an exact event replay once without recording another audit event', async () => {
    const context = await setup();
    await pause(context);
    const response = {
      decisionRequestId: 'decision-001',
      responseEventId: 'dingtalk-event-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use B and continue.',
    };

    await expect(recordDecision(context.ctx, 'task-decision-001', response))
      .resolves.toMatchObject({ accepted: true });
    await expect(recordDecision(context.ctx, 'task-decision-001', response))
      .resolves.toMatchObject({ accepted: false });

    const audit = await context.ctx.audit.listForTask('task-decision-001');
    expect(audit.filter(({ event }) => event === 'decision.received')).toHaveLength(1);
  });

  it.each([
    [{ responseEventId: 'dingtalk-event-002' }],
    [{ decisionRequestId: 'decision-002' }],
  ])('rejects a conflicting replay: %s', async (override: {
    responseEventId?: string;
    decisionRequestId?: string;
  }) => {
    const context = await setup();
    await pause(context);
    const response = {
      decisionRequestId: 'decision-001',
      responseEventId: 'dingtalk-event-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use B and continue.',
    };
    await recordDecision(context.ctx, 'task-decision-001', response);

    await expect(recordDecision(context.ctx, 'task-decision-001', {
      ...response,
      ...override,
    })).rejects.toMatchObject({ code: 'decision_event_conflict' });
  });

  it('rejects one response event when it was already recorded for another task', async () => {
    const context = await setup();
    await context.ctx.tasks.save(inProgressTask({
      taskId: 'task-decision-002',
      sourceKey: 'synthetic:decision-002',
      claim: {
        runId: 'run-decision-002',
        agent: 'synthetic-agent',
        claimedAt: NOW,
        leaseExpiresAt: '2026-07-15T01:00:00.000Z',
      },
    }));
    await pause(context);
    await pause(context, 'task-decision-002', 'decision-002');

    await recordDecision(context.ctx, 'task-decision-001', {
      decisionRequestId: 'decision-001',
      responseEventId: 'dingtalk-event-shared',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use A.',
    });
    await expect(recordDecision(context.ctx, 'task-decision-002', {
      decisionRequestId: 'decision-002',
      responseEventId: 'dingtalk-event-shared',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use B.',
    })).rejects.toMatchObject({ code: 'decision_event_conflict' });

    await expect(context.ctx.tasks.get('task-decision-002')).resolves.toMatchObject({
      status: 'waiting_for_decision',
      pendingDecision: { requestId: 'decision-002' },
    });
  });

  it('allows only one task to record the same response event concurrently', async () => {
    const context = await setup();
    await context.ctx.tasks.save(inProgressTask({
      taskId: 'task-decision-002',
      sourceKey: 'synthetic:decision-002',
      claim: {
        runId: 'run-decision-002',
        agent: 'synthetic-agent',
        claimedAt: NOW,
        leaseExpiresAt: '2026-07-15T01:00:00.000Z',
      },
    }));
    await pause(context);
    await pause(context, 'task-decision-002', 'decision-002');
    const independent = context.createIndependentContext({ now: new Date(NOW) });

    const outcomes = await Promise.allSettled([
      recordDecision(context.ctx, 'task-decision-001', {
        decisionRequestId: 'decision-001',
        responseEventId: 'dingtalk-event-concurrent-shared',
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        selectedOptionId: 'option-a',
        responseText: 'Use A.',
      }),
      recordDecision(independent, 'task-decision-002', {
        decisionRequestId: 'decision-002',
        responseEventId: 'dingtalk-event-concurrent-shared',
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        selectedOptionId: 'option-b',
        responseText: 'Use B.',
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'decision_event_conflict' },
    });
    const tasks = await context.ctx.tasks.list();
    expect(tasks.filter(
      (task) => task.lastDecision?.responseEventId === 'dingtalk-event-concurrent-shared',
    )).toHaveLength(1);
  });
});
