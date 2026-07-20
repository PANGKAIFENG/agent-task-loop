import { describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import type { AuditEvent } from '../../../src/storage/contracts.js';
import { queryContribution } from '../../../src/services/query-contribution.js';

const NOW = '2026-07-20T10:00:00+08:00';

function task(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId,
    title: `Task ${taskId}`,
    body: '',
    status: 'done',
    reviewState: 'confirmed',
    projectId: 'atl',
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `source-${taskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const projects: Project[] = [{
  projectId: 'atl',
  name: 'Agent Task Loop',
  description: '',
  resources: [],
  createdAt: NOW,
  updatedAt: NOW,
}];

function reviewed(taskId: string, at: string): AuditEvent {
  return {
    event: 'task.reviewed',
    at,
    taskId,
    details: { decision: 'approve' },
  };
}

function reconciled(taskId: string, at: string, status = 'done'): AuditEvent {
  return {
    event: 'task.lifecycle_reconciled',
    at,
    taskId,
    details: { status },
  };
}

describe('queryContribution', () => {
  it('counts only completion evidence and deduplicates a task within one local day', () => {
    const doneTaskA = task('a');
    const doneTaskB = task('b');
    const snapshot = queryContribution({
      tasks: [doneTaskA, doneTaskB],
      projects,
      auditEvents: [
        reviewed('a', '2026-07-20T08:00:00+08:00'),
        reconciled('a', '2026-07-20T09:00:00+08:00'),
        reviewed('b', '2026-07-20T09:30:00+08:00'),
        { event: 'task.reviewed', at: NOW, taskId: 'ignored', details: { decision: 'block' } },
        reconciled('ignored', NOW, 'in_progress'),
      ],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '12w',
      selectedDate: '2026-07-20',
    });

    expect(snapshot.kpis.completedToday).toBe(2);
    expect(snapshot.kpis.completedThisWeek).toBe(2);
    expect(snapshot.days.find((day) => day.date === '2026-07-20')).toMatchObject({
      completed: 2,
      projectCount: 1,
      level: 2,
    });
    expect(snapshot.outputs.map((output) => output.taskId)).toEqual(['b', 'a']);
    expect(snapshot.outputs[1]?.completedAt).toBe('2026-07-20T09:00:00+08:00');
  });

  it('uses Monday week boundaries and counts a completion again on another day', () => {
    const snapshot = queryContribution({
      tasks: [task('a'), task('b')],
      projects,
      auditEvents: [
        reviewed('a', '2026-07-19T23:59:00+08:00'),
        reviewed('a', '2026-07-20T07:00:00+08:00'),
        reviewed('b', '2026-07-20T08:00:00+08:00'),
      ],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '7d',
      selectedDate: '2026-07-20',
    });

    expect(snapshot.kpis.completedToday).toBe(2);
    expect(snapshot.kpis.completedThisWeek).toBe(2);
    expect(snapshot.days).toHaveLength(7);
    expect(snapshot.days.at(-1)?.date).toBe('2026-07-20');
    expect(snapshot.days.find((day) => day.date === '2026-07-19')?.completed).toBe(1);
  });

  it('keeps a streak from yesterday when today has no completion', () => {
    const snapshot = queryContribution({
      tasks: [task('a'), task('b')],
      projects,
      auditEvents: [
        reviewed('a', '2026-07-18T22:00:00+08:00'),
        reviewed('b', '2026-07-19T22:00:00+08:00'),
      ],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '12w',
      selectedDate: '2026-07-19',
    });

    expect(snapshot.kpis.completedToday).toBe(0);
    expect(snapshot.kpis.currentStreak).toBe(2);
  });

  it('buckets absolute timestamps in the requested timezone', () => {
    const snapshot = queryContribution({
      tasks: [task('boundary')],
      projects,
      auditEvents: [reviewed('boundary', '2026-07-19T16:30:00Z')],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '7d',
      selectedDate: '2026-07-20',
    });

    expect(snapshot.kpis.completedToday).toBe(1);
    expect(snapshot.outputs[0]?.completedAt).toBe('2026-07-19T16:30:00Z');
  });

  it('groups selected-day work by project and exposes the newest artifact', () => {
    const snapshot = queryContribution({
      tasks: [
        task('a', { title: 'Earlier', artifactRefs: ['Artifacts/a/attempt-001.md'] }),
        task('b', {
          title: 'Later',
          artifactRefs: ['Artifacts/b/attempt-001.md', 'Artifacts/b/attempt-002.md'],
        }),
        task('c', { title: 'Unsorted', projectId: null }),
      ],
      projects,
      auditEvents: [
        reviewed('a', '2026-07-20T08:00:00+08:00'),
        reviewed('b', '2026-07-20T09:00:00+08:00'),
        reconciled('c', '2026-07-20T07:00:00+08:00'),
      ],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '12w',
      selectedDate: '2026-07-20',
    });

    expect(snapshot.projectSummaries).toEqual([
      {
        projectId: 'atl',
        projectName: 'Agent Task Loop',
        completed: 2,
        artifactCount: 3,
        evidenceTitles: ['Later', 'Earlier'],
      },
      {
        projectId: null,
        projectName: '未归类',
        completed: 1,
        artifactCount: 0,
        evidenceTitles: ['Unsorted'],
      },
    ]);
    expect(snapshot.outputs[0]).toMatchObject({
      taskId: 'b',
      artifactRef: 'Artifacts/b/attempt-002.md',
    });
  });

  it('reports done tasks without completion evidence instead of inferring updatedAt', () => {
    const snapshot = queryContribution({
      tasks: [task('missing'), task('not-done', { status: 'ready' })],
      projects,
      auditEvents: [],
      now: new Date(NOW),
      timeZone: 'Asia/Shanghai',
      range: '1y',
      selectedDate: '2026-07-20',
    });

    expect(snapshot.coverage.historicalCompletionDateUnavailable).toBe(1);
    expect(snapshot.kpis.completedToday).toBe(0);
    expect(snapshot.outputs).toEqual([]);
    expect(snapshot.days).toHaveLength(365);
  });
});
