import { describe, expect, it } from 'vitest';

import {
  priorityRank,
  readinessErrors,
  taskSchema,
  type Task,
} from '../../../src/domain/task.js';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  schemaVersion: 1,
  taskId: 'task-1',
  title: 'Research task',
  body: '',
  status: 'inbox',
  reviewState: 'candidate',
  projectId: null,
  taskType: null,
  objective: null,
  acceptanceCriteria: [],
  autoExecutable: false,
  permissionProfile: null,
  origin: 'test',
  sourceDate: null,
  sourceNote: null,
  sourceQuote: null,
  sourceKey: 'test:task-1',
  possibleDuplicateIds: [],
  priority: 'normal',
  attempts: 0,
  claim: null,
  artifactRefs: [],
  reviewFeedback: null,
  readyAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  ...overrides,
});

describe('readinessErrors', () => {
  it('returns readiness failures in deterministic order', () => {
    const inbox = makeTask({ status: 'inbox' });

    expect(readinessErrors(inbox)).toEqual([
      'projectId is required',
      'taskType must be research',
      'objective is required',
      'acceptanceCriteria requires at least one item',
      'permissionProfile must be read_only_research',
    ]);
  });

  it('returns no failures for an executable research task', () => {
    const task = makeTask({
      projectId: 'project-1',
      taskType: 'research',
      objective: 'Compare the documented options',
      acceptanceCriteria: ['Cite official sources'],
      permissionProfile: 'read_only_research',
      autoExecutable: true,
    });

    expect(readinessErrors(task)).toEqual([]);
  });

  it('treats automatic execution as permission rather than task readiness', () => {
    const task = makeTask({
      projectId: 'project-1',
      taskType: 'research',
      objective: 'Compare the documented options',
      acceptanceCriteria: ['Cite official sources'],
      permissionProfile: 'read_only_research',
      autoExecutable: false,
    });

    expect(readinessErrors(task)).toEqual([]);
  });

  it('requires at least one non-whitespace acceptance criterion', () => {
    const task = makeTask({ acceptanceCriteria: [' ', '\t'] });

    expect(readinessErrors(task)).toContain(
      'acceptanceCriteria requires at least one item',
    );
  });

  it('accepts a meaningful criterion among blank entries', () => {
    const task = makeTask({
      projectId: 'project-1',
      taskType: 'research',
      objective: 'Compare the documented options',
      acceptanceCriteria: [' ', 'Cite official sources'],
      permissionProfile: 'read_only_research',
      autoExecutable: true,
    });

    expect(readinessErrors(task)).toEqual([]);
  });
});

describe('priorityRank', () => {
  it('orders priorities from urgent to low', () => {
    expect(priorityRank).toEqual({ urgent: 0, high: 1, normal: 2, low: 3 });
  });
});

describe('taskSchema', () => {
  it('accepts bounded pending and completed decision context', () => {
    const task = makeTask({
      status: 'waiting_for_decision',
      pendingDecision: {
        schemaVersion: 1,
        requestId: 'decision-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
        requestedAt: '2026-07-14T00:00:00.000Z',
        requestedByRunId: 'run-001',
      },
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-000',
        selectedOptionId: 'option-a',
        selectedOptionLabel: 'Option A',
        responseText: 'Continue with A.',
        responseEventId: 'dingtalk-event-000',
        respondedAt: '2026-07-13T00:00:00.000Z',
      },
    });

    expect(taskSchema.parse(task)).toMatchObject({
      status: 'waiting_for_decision',
      pendingDecision: { requestId: 'decision-001' },
      lastDecision: { responseEventId: 'dingtalk-event-000' },
    });
  });

  it('rejects a decision request with duplicate option IDs', () => {
    const task = makeTask({
      pendingDecision: {
        schemaVersion: 1,
        requestId: 'decision-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'duplicate', label: 'Option A' },
          { id: 'duplicate', label: 'Option B' },
        ],
        requestedAt: '2026-07-14T00:00:00.000Z',
        requestedByRunId: 'run-001',
      },
    });

    expect(taskSchema.safeParse(task).success).toBe(false);
  });

  it.each([
    'waiting_external',
    '等待回复',
  ])('accepts a safe custom task status: %s', (status) => {
    expect(taskSchema.safeParse(makeTask({ status })).success).toBe(true);
  });

  it.each([
    '',
    'bad\nstatus',
    'x'.repeat(101),
  ])('rejects an unsafe custom task status', (status) => {
    expect(taskSchema.safeParse(makeTask({ status })).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const task = { ...makeTask(), unexpected: true };

    expect(taskSchema.safeParse(task).success).toBe(false);
  });

  it('rejects unknown claim keys', () => {
    const task = {
      ...makeTask(),
      claim: {
        runId: 'run-1',
        agent: 'research-agent',
        claimedAt: '2026-07-14T00:00:00.000Z',
        leaseExpiresAt: '2026-07-14T00:05:00.000Z',
        unexpected: true,
      },
    };

    expect(taskSchema.safeParse(task).success).toBe(false);
  });
});
