import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { queryEvalSamples } from '../../../src/services/query-eval-samples.js';
import type { ServiceContext } from '../../../src/services/service-context.js';
import type { AuditEvent } from '../../../src/storage/contracts.js';

const NOW = '2026-07-15T00:00:00.000Z';

function task(taskId: string): Task {
  return {
    schemaVersion: 1,
    taskId,
    title: 'Synthetic task',
    body: '',
    status: 'done',
    reviewState: 'confirmed',
    projectId: 'project-eval',
    taskType: 'research',
    objective: 'Research a public question.',
    acceptanceCriteria: ['Cite one source.'],
    autoExecutable: false,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_eval_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `synthetic:${taskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: null,
    artifactRefs: [`Artifacts/${taskId}/attempt-001.md`],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function context(events: Record<string, AuditEvent[]>): ServiceContext {
  const tasks = Object.keys(events).map(task);
  return {
    tasks: {
      withTaskLock: async (_taskId, operation) => operation(),
      list: async () => tasks,
      get: async (taskId) => task(taskId),
      findBySourceKey: async () => null,
      createIfSourceKeyAbsent: async (value) => ({ task: value, created: true }),
      save: async (value) => value,
      saveBody: async (value) => value,
    },
    artifacts: {} as ServiceContext['artifacts'],
    projects: {} as ServiceContext['projects'],
    audit: {
      append: async () => undefined,
      count: async () => 0,
      listBetween: async () => [],
      listForTask: async (taskId) => events[taskId] ?? [],
      latest: async () => null,
    },
    clock: () => new Date(NOW),
    id: () => 'unused',
  };
}

describe('queryEvalSamples', () => {
  it('ignores legacy reviews and incomplete Eval anchors', async () => {
    const incomplete = {
      event: 'task.reviewed',
      at: NOW,
      taskId: 'task-incomplete',
      runId: 'run-incomplete',
      details: {
        decision: 'approve',
        evalSampleId: `eval-${'a'.repeat(24)}`,
      },
    } satisfies AuditEvent;

    await expect(queryEvalSamples(context({
      'task-legacy': [{
        event: 'task.reviewed',
        at: NOW,
        taskId: 'task-legacy',
        details: { decision: 'approve' },
      }],
      'task-incomplete': [incomplete],
    }))).resolves.toEqual({
      capabilitySamples: [],
      regressionCandidates: [],
    });
  });

  it('ignores a self-declared Eval sample without matching run anchors', async () => {
    const taskId = 'task-forged';
    const event = {
      event: 'task.reviewed',
      at: NOW,
      taskId,
      runId: 'run-forged',
      details: {
        decision: 'approve',
        evalSampleId: `eval-${'a'.repeat(24)}`,
        evalSampleType: 'capability',
        evalSampleStatus: 'pending_review',
        regressionCandidateStatus: 'not_proposed',
        packId: `pack-${'b'.repeat(24)}`,
        packSha256: 'c'.repeat(64),
        executionProfileId: 'research_v1',
        executionProfileVersion: 1,
        executionProfileSha256: 'd'.repeat(64),
        artifactRef: `Artifacts/${taskId}/attempt-001.md`,
        artifactSha256: 'e'.repeat(64),
        runOutcome: 'artifact_submitted',
        humanOutcome: 'approve',
        feedbackSha256: null,
        harnessMutationAllowed: false,
      },
    } satisfies AuditEvent;

    await expect(queryEvalSamples(context({ [taskId]: [event] }))).resolves.toEqual({
      capabilitySamples: [],
      regressionCandidates: [],
    });
  });
});
