import { describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { queryPersonalHome } from '../../../src/services/query-personal-home.js';

function task(overrides: Partial<Task>): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-a',
    title: 'Task A',
    body: 'private body',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'manual',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: 'private quote',
    sourceKey: 'source-a',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

const projects: Project[] = [{
  projectId: 'atl',
  name: 'Agent Task Loop',
  description: '',
  resources: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}];

describe('queryPersonalHome', () => {
  it('builds status counts and prioritizes active work without exposing private content', () => {
    const snapshot = queryPersonalHome({
      projects,
      tasks: [
        task({ taskId: 'inbox', title: 'Inbox', status: 'inbox' }),
        task({ taskId: 'ready', title: 'Ready', status: 'ready', priority: 'urgent' }),
        task({
          taskId: 'active',
          title: 'Active',
          status: 'in_progress',
          projectId: 'atl',
          priority: 'low',
          artifactRefs: ['Artifacts/active/attempt-001.md'],
        }),
        task({ taskId: 'review', title: 'Review', status: 'review' }),
        task({ taskId: 'blocked', title: 'Blocked', status: 'blocked' }),
        task({ taskId: 'done', title: 'Done', status: 'done' }),
      ],
    });

    expect(snapshot.counts).toEqual({
      inbox: 1,
      ready: 1,
      inProgress: 1,
      review: 1,
      blocked: 1,
    });
    expect(snapshot.focusTasks.map(({ taskId }) => taskId)).toEqual(['active', 'ready']);
    expect(snapshot.nextAction?.taskId).toBe('active');
    expect(snapshot.focusTasks[0]).toEqual({
      taskId: 'active',
      title: 'Active',
      status: 'in_progress',
      reviewState: 'candidate',
      projectName: 'Agent Task Loop',
      priority: 'low',
      updatedAt: '2026-07-20T00:00:00.000Z',
      artifactCount: 1,
    });
    expect(snapshot.focusTasks[0]).not.toHaveProperty('body');
    expect(snapshot.focusTasks[0]).not.toHaveProperty('sourceQuote');
  });

  it('returns complete sorted focus and inbox lists for full tabs', () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task({
      taskId: `task-${index}`,
      title: `Task ${index}`,
      status: index < 5 ? 'ready' : 'inbox',
      updatedAt: `2026-07-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    }));

    const snapshot = queryPersonalHome({ projects, tasks });

    expect(snapshot.focusTasks).toHaveLength(5);
    expect(snapshot.inboxTasks).toHaveLength(7);
    expect(snapshot.focusTasks.map(({ taskId }) => taskId)).toEqual([
      'task-4',
      'task-3',
      'task-2',
      'task-1',
      'task-0',
    ]);
    expect(snapshot.inboxTasks.map(({ taskId }) => taskId)).toEqual([
      'task-11',
      'task-10',
      'task-9',
      'task-8',
      'task-7',
      'task-6',
      'task-5',
    ]);
  });
});
