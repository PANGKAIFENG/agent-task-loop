import { describe, expect, it } from 'vitest';

import {
  priorityRank,
  readinessErrors,
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
      'autoExecutable must be explicitly enabled',
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
});

describe('priorityRank', () => {
  it('orders priorities from urgent to low', () => {
    expect(priorityRank).toEqual({ urgent: 0, high: 1, normal: 2, low: 3 });
  });
});
