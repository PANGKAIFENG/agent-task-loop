import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactResult } from '../../../src/domain/artifact.js';
import type { Task } from '../../../src/domain/task.js';
import { recordDecision } from '../../../src/services/record-decision.js';
import { reviewArtifactFromExternalReply } from '../../../src/services/review-artifact-from-external-reply.js';
import { submitArtifact } from '../../../src/services/submit-artifact.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-08-13T01:00:00.000Z';
const contexts: TestServiceContext[] = [];

function inProgressTask(taskId: string, attempt = 1): Task {
  return {
    schemaVersion: 1,
    taskId,
    title: `Artifact review ${taskId}`,
    body: '',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-artifact-review',
    taskType: 'research',
    objective: 'Produce a reviewable synthetic artifact.',
    acceptanceCriteria: ['Use public evidence.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-13',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `synthetic:${taskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: attempt,
    claim: {
      runId: `run-${taskId}`,
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-08-13T02:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function artifactResult(): ArtifactResult {
  return {
    summary: 'Synthetic artifact is ready for review.',
    findings: ['One public finding.'],
    evidence: [{
      title: 'Public evidence',
      url: 'https://example.com/evidence',
      accessedAt: NOW,
    }],
    uncertainties: [],
    recommendedActions: [],
    acceptance: [{
      criterion: 'Use public evidence.',
      status: 'met',
      note: 'Public evidence was cited.',
    }],
  };
}

async function setupReview(
  taskId: string,
  attempt = 1,
): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: new Date(NOW) });
  contexts.push(context);
  const task = inProgressTask(taskId, attempt);
  await context.ctx.tasks.save(task);
  await submitArtifact(context.ctx, taskId, {
    runId: task.claim?.runId ?? '',
    result: artifactResult(),
  });
  return context;
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    artifactVersion: 1,
    responseEventId: 'dingtalk-artifact-event-001',
    senderUserId: 'trusted-user-001',
    conversationId: 'trusted-conversation-001',
    decision: 'approve' as const,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('external Artifact review', () => {
  it('routes a DingTalk acceptance through reviewTask and records source provenance', async () => {
    const context = await setupReview('task-external-review-001');

    const result = await reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-001',
      reply(),
    );

    expect(result).toMatchObject({
      accepted: true,
      task: { status: 'done', reviewFeedback: null },
    });
    expect(await context.ctx.audit.listForTask('task-external-review-001'))
      .toContainEqual({
        event: 'task.reviewed',
        at: NOW,
        taskId: 'task-external-review-001',
        details: {
          decision: 'approve',
          source: 'dingtalk_stream',
          artifactVersion: 1,
          responseEventId: 'dingtalk-artifact-event-001',
          senderUserId: 'trusted-user-001',
          conversationId: 'trusted-conversation-001',
          feedbackSha256: null,
        },
      });
  });

  it('returns duplicate for an exact event replay without reviewing twice', async () => {
    const context = await setupReview('task-external-review-replay');
    const input = reply();

    await expect(reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-replay',
      input,
    )).resolves.toMatchObject({ accepted: true });
    await expect(reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-replay',
      input,
    )).resolves.toMatchObject({ accepted: false, task: { status: 'done' } });

    const reviews = (await context.ctx.audit.listForTask('task-external-review-replay'))
      .filter(({ event }) => event === 'task.reviewed');
    expect(reviews).toHaveLength(1);
  });

  it('returns a change request to Ready without copying feedback into the audit log', async () => {
    const context = await setupReview('task-external-review-changes');
    const feedback = '补充真实用户证据。';

    const result = await reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-changes',
      reply({
        responseEventId: 'dingtalk-artifact-event-changes',
        decision: 'request_changes',
        feedback,
      }),
    );

    expect(result).toMatchObject({
      accepted: true,
      task: { status: 'ready', reviewFeedback: feedback },
    });
    const audit = await context.ctx.audit.listForTask('task-external-review-changes');
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(feedback);
    expect(audit).toContainEqual(expect.objectContaining({
      event: 'task.reviewed',
      details: expect.objectContaining({
        decision: 'request_changes',
        source: 'dingtalk_stream',
        feedbackSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    }));
  });

  it('rejects a reply from an old notification version', async () => {
    const context = await setupReview('task-external-review-stale', 2);

    await expect(reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-stale',
      reply({ artifactVersion: 1 }),
    )).rejects.toMatchObject({ code: 'artifact_review_version_conflict' });
    await expect(context.ctx.tasks.get('task-external-review-stale'))
      .resolves.toMatchObject({ status: 'review' });
  });

  it('rejects one response event when it was already used for another task', async () => {
    const context = await setupReview('task-external-review-first');
    const second = inProgressTask('task-external-review-second');
    await context.ctx.tasks.save(second);
    await submitArtifact(context.ctx, second.taskId, {
      runId: second.claim?.runId ?? '',
      result: artifactResult(),
    });

    await reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-first',
      reply(),
    );
    await expect(reviewArtifactFromExternalReply(
      context.ctx,
      'task-external-review-second',
      reply(),
    )).rejects.toMatchObject({ code: 'external_response_event_conflict' });
    await expect(context.ctx.tasks.get('task-external-review-second'))
      .resolves.toMatchObject({ status: 'review' });
  });

  it('allows only one task to consume the same response event concurrently', async () => {
    const context = await setupReview('task-external-review-concurrent-a');
    const second = inProgressTask('task-external-review-concurrent-b');
    await context.ctx.tasks.save(second);
    await submitArtifact(context.ctx, second.taskId, {
      runId: second.claim?.runId ?? '',
      result: artifactResult(),
    });
    const independent = context.createIndependentContext({ now: new Date(NOW) });

    const outcomes = await Promise.allSettled([
      reviewArtifactFromExternalReply(
        context.ctx,
        'task-external-review-concurrent-a',
        reply({ responseEventId: 'dingtalk-artifact-event-concurrent' }),
      ),
      reviewArtifactFromExternalReply(
        independent,
        'task-external-review-concurrent-b',
        reply({ responseEventId: 'dingtalk-artifact-event-concurrent' }),
      ),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'external_response_event_conflict' },
    });
    const tasks = await context.ctx.tasks.list();
    expect(tasks.filter(({ status }) => status === 'done')).toHaveLength(1);
    expect(tasks.filter(({ status }) => status === 'review')).toHaveLength(1);
  });

  it('allows only one action to consume an event across Artifact review and task decision', async () => {
    const context = await setupReview('task-external-review-cross-type');
    const decisionTask: Task = {
      ...inProgressTask('task-external-review-cross-decision'),
      status: 'waiting_for_decision',
      claim: null,
      pendingDecision: {
        schemaVersion: 1,
        requestId: 'decision-cross-type',
        question: 'Choose one direction.',
        options: [{ id: 'option-a', label: 'Option A' }],
        requestedAt: NOW,
        requestedByRunId: 'run-cross-type',
      },
    };
    await context.ctx.tasks.save(decisionTask);
    const independent = context.createIndependentContext({ now: new Date(NOW) });
    const responseEventId = 'dingtalk-cross-type-event';

    const outcomes = await Promise.allSettled([
      reviewArtifactFromExternalReply(
        context.ctx,
        'task-external-review-cross-type',
        reply({ responseEventId }),
      ),
      recordDecision(independent, decisionTask.taskId, {
        decisionRequestId: 'decision-cross-type',
        responseEventId,
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        selectedOptionId: 'option-a',
        responseText: 'A',
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: {
        code: expect.stringMatching(/^(?:external_response_event|decision_event)_conflict$/u),
      },
    });
    const tasks = await context.ctx.tasks.list();
    const artifactTask = tasks.find(({ taskId }) => taskId === 'task-external-review-cross-type');
    const decidedTask = tasks.find(({ taskId }) => taskId === decisionTask.taskId);
    expect([
      artifactTask?.status === 'done',
      decidedTask?.status === 'agent_executable',
    ].filter(Boolean)).toHaveLength(1);
  });
});
