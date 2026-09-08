import { describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { buildWorkbenchDashboard } from '../../../src/services/query-workbench-dashboard.js';

const NOW = new Date('2026-08-22T02:00:00.000Z');

function task(taskId: string, overrides: Partial<Task>): Task {
  return {
    schemaVersion: 1,
    taskId,
    title: `Synthetic ${taskId}`,
    body: 'PRIVATE_BODY_SENTINEL',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: 'project-synthetic',
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'synthetic_fixture',
    sourceDate: '2026-08-22',
    sourceNote: '/private/source.md',
    sourceQuote: 'PRIVATE_QUOTE_SENTINEL',
    sourceKey: 'private:source-key',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T01:00:00.000Z',
    ...overrides,
  };
}

const projects: Project[] = [{
  projectId: 'project-synthetic',
  name: 'Synthetic workstream',
  description: 'Synthetic project fixture.',
  resources: [],
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-22T01:00:00.000Z',
}];

describe('buildWorkbenchDashboard', () => {
  it('projects dynamic task facts into five stable views without recomputing queue admission', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [{
        event: 'task.reviewed',
        at: '2026-08-22T01:00:00.000Z',
        taskId: 'done',
        details: { decision: 'approve' },
      }],
      tasks: [
        task('decision', {
          status: 'waiting_for_decision',
          reviewState: 'confirmed',
          pendingDecision: {
            schemaVersion: 1,
            requestId: 'decision-synthetic-001',
            question: 'Choose a synthetic direction.',
            options: [{ id: 'continue', label: 'Continue' }],
            requestedAt: '2026-08-22T00:30:00.000Z',
            requestedByRunId: 'run-synthetic-001',
          },
        }),
        task('blocked', { status: 'blocked', reviewState: 'confirmed' }),
        task('candidate', { status: 'inbox', reviewState: 'candidate' }),
        task('agent', {
          status: 'agent_executable',
          reviewState: 'confirmed',
          taskType: 'research',
          objective: 'Review synthetic public evidence.',
          acceptanceCriteria: ['Cite synthetic public evidence.'],
          autoExecutable: true,
          permissionProfile: 'read_only_research',
        }),
        task('done', {
          status: 'done',
          reviewState: 'confirmed',
          artifactRefs: ['10_Tasks/Artifacts/done/attempt-001.md'],
        }),
      ],
    });

    expect(dashboard.views.map(({ id }) => id)).toEqual([
      'requires_user',
      'agent_attention',
      'intake',
      'important_not_urgent',
      'weekly_insights',
    ]);
    expect(dashboard.views.map(({ cards }) => cards.map(({ taskId }) => taskId))).toEqual([
      ['decision'],
      ['blocked'],
      ['candidate'],
      ['agent'],
      ['done'],
    ]);
    expect(dashboard.summary.candidateTasks).toBe(1);
    expect(dashboard.summary.agentQueue).toEqual({
      raw: 1,
      admitted: 1,
      quarantined: 0,
    });
    expect(dashboard.views[0]?.cards[0]).toEqual(expect.objectContaining({
      reason: expect.objectContaining({ kind: 'human_confirmation' }),
      source: expect.objectContaining({ kind: 'fact' }),
      goalImpact: expect.objectContaining({ kind: 'fact' }),
      timeliness: expect.objectContaining({ state: 'current' }),
      status: expect.objectContaining({ code: 'waiting_for_decision' }),
      ruleRef: expect.any(String),
      traceRef: 'decision:decision-synthetic-001',
      action: expect.objectContaining({ href: '/projects/project-synthetic' }),
    }));
    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain('PRIVATE_BODY_SENTINEL');
    expect(serialized).not.toContain('PRIVATE_QUOTE_SENTINEL');
    expect(serialized).not.toContain('/private/source.md');
    expect(serialized).not.toContain('private:source-key');
  });

  it('does not label an urgent admitted task as important but not urgent', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('urgent-agent', {
        status: 'agent_executable',
        reviewState: 'confirmed',
        taskType: 'research',
        objective: 'Review an urgent synthetic signal.',
        acceptanceCriteria: ['Cite synthetic public evidence.'],
        autoExecutable: true,
        permissionProfile: 'read_only_research',
        priority: 'urgent',
      })],
    });

    expect(dashboard.summary.agentQueue).toEqual({
      raw: 1,
      admitted: 1,
      quarantined: 0,
    });
    expect(
      dashboard.views.find(({ id }) => id === 'important_not_urgent')?.cards,
    ).toEqual([]);
    expect(
      dashboard.views.find(({ id }) => id === 'agent_attention')?.cards,
    ).toEqual([
      expect.objectContaining({
        taskId: 'urgent-agent',
        reason: expect.objectContaining({ label: 'Agent 队列存在紧急任务，需要优先处理' }),
      }),
    ]);
  });

  it('counts weekly outcomes by the Asia/Shanghai ISO week instead of a rolling seven days', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [
        {
          event: 'task.lifecycle_reconciled',
          at: '2026-08-16T15:59:59.000Z',
          taskId: 'previous-sunday',
          details: { status: 'done' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-16T16:00:00.000Z',
          taskId: 'current-monday',
          details: { decision: 'approve' },
        },
      ],
      tasks: [
        task('previous-sunday', {
          status: 'done',
          reviewState: 'confirmed',
          updatedAt: '2026-08-16T15:59:59.000Z',
        }),
        task('current-monday', {
          status: 'done',
          reviewState: 'confirmed',
          updatedAt: '2026-08-16T16:00:00.000Z',
        }),
      ],
    });

    expect(dashboard.summary.weeklyResults).toBe(1);
    expect(
      dashboard.views.find(({ id }) => id === 'weekly_insights')?.cards
        .map(({ taskId }) => taskId),
    ).toEqual(['current-monday']);
  });

  it('attributes weekly results to completion audit evidence instead of a later Task Brief edit', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      tasks: [
        task('done-last-week-edited-this-week', {
          status: 'done',
          reviewState: 'confirmed',
          updatedAt: '2026-08-22T01:30:00.000Z',
        }),
        task('done-this-week-edited-last-week', {
          status: 'done',
          reviewState: 'confirmed',
          updatedAt: '2026-08-16T01:30:00.000Z',
        }),
      ],
      auditEvents: [
        {
          event: 'task.lifecycle_reconciled',
          at: '2026-08-16T15:59:59.000Z',
          taskId: 'done-last-week-edited-this-week',
          details: { status: 'done' },
        },
        {
          event: 'task.completion_date_recorded',
          at: '2026-08-18T04:00:00.000Z',
          taskId: 'done-this-week-edited-last-week',
          details: { source: 'manual_backfill' },
        },
      ],
    });

    expect(dashboard.summary.weeklyResults).toBe(1);
    expect(
      dashboard.views.find(({ id }) => id === 'weekly_insights')?.cards
        .map(({ taskId }) => taskId),
    ).toEqual(['done-this-week-edited-last-week']);
  });

  it('keeps a historical weekly completion when the task is currently reopened', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      tasks: [task('reopened', {
        status: 'in_progress',
        reviewState: 'confirmed',
      })],
      auditEvents: [{
        event: 'task.lifecycle_reconciled',
        at: '2026-08-18T03:00:00.000Z',
        taskId: 'reopened',
        details: { status: 'done' },
      }],
    });

    const weeklyCards = dashboard.views.find(({ id }) => id === 'weekly_insights')?.cards ?? [];
    expect(dashboard.summary.weeklyResults).toBe(1);
    expect(weeklyCards.map(({ cardId }) => cardId)).toEqual([
      'weekly_insights:reopened:2026-08-18',
    ]);
    expect(weeklyCards.map(({ taskId }) => taskId)).toEqual(['reopened']);
    expect(weeklyCards).toHaveLength(dashboard.summary.weeklyResults);
  });

  it('deduplicates same-day completion events but preserves cross-day recompletions', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      tasks: [task('repeat', {
        status: 'done',
        reviewState: 'confirmed',
      })],
      auditEvents: [
        {
          event: 'task.reviewed',
          at: '2026-08-18T01:00:00.000Z',
          taskId: 'repeat',
          details: { decision: 'approve' },
        },
        {
          event: 'task.lifecycle_reconciled',
          at: '2026-08-18T03:00:00.000Z',
          taskId: 'repeat',
          details: { status: 'done' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-20T01:00:00.000Z',
          taskId: 'repeat',
          details: { decision: 'approve' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-20T02:00:00.000Z',
          taskId: 'repeat',
          details: { decision: 'approve' },
        },
      ],
    });

    const weeklyCards = dashboard.views.find(({ id }) => id === 'weekly_insights')?.cards ?? [];
    expect(dashboard.summary.weeklyResults).toBe(2);
    expect(weeklyCards.map(({ cardId }) => cardId)).toEqual([
      'weekly_insights:repeat:2026-08-18',
      'weekly_insights:repeat:2026-08-20',
    ]);
    expect(weeklyCards.map(({ taskId }) => taskId)).toEqual(['repeat', 'repeat']);
    expect(weeklyCards).toHaveLength(dashboard.summary.weeklyResults);
  });

  it('reports partial coverage when a done task has no valid completion-date evidence', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      tasks: [task('done-without-completion-evidence', {
        status: 'done',
        reviewState: 'confirmed',
        updatedAt: '2026-08-22T01:30:00.000Z',
      })],
      auditEvents: [{
        event: 'task.reviewed',
        at: 'not-a-date',
        taskId: 'done-without-completion-evidence',
        details: { decision: 'approve' },
      }],
    });

    expect(dashboard.summary.weeklyResults).toBe(0);
    expect(
      dashboard.views.find(({ id }) => id === 'weekly_insights')?.cards,
    ).toEqual([]);
    expect(dashboard.dataState).toBe('partial');
    expect(dashboard.stateReasons).toContain(
      '1 个已完成任务缺少可审计完成日期，未计入本周结果',
    );
  });

  it('keeps missing completion evidence partial when another card is stale', () => {
    const dashboard = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [
        task('done-without-completion-evidence', {
          status: 'done',
          reviewState: 'confirmed',
        }),
        task('stale-decision', {
          status: 'waiting_for_decision',
          reviewState: 'confirmed',
          updatedAt: '2026-08-20T00:00:00.000Z',
          pendingDecision: {
            schemaVersion: 1,
            requestId: 'decision-stale-with-partial-coverage',
            question: 'Choose a synthetic option.',
            options: [{ id: 'continue', label: 'Continue' }],
            requestedAt: '2026-08-20T00:00:00.000Z',
            requestedByRunId: 'run-stale-with-partial-coverage',
          },
        }),
      ],
    });

    expect(dashboard.dataState).toBe('partial');
    expect(dashboard.stateReasons).toContain(
      '1 个已完成任务缺少可审计完成日期，未计入本周结果',
    );
    expect(dashboard.stateReasons).toContain('至少一项驾驶舱事实超过 24 小时未更新');
  });

  it('classifies empty, complete, partial, stale, and integrity data explicitly', () => {
    const empty = buildWorkbenchDashboard({ now: NOW, projects, auditEvents: [], tasks: [] });
    const complete = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('complete', {
        status: 'waiting_for_decision',
        reviewState: 'confirmed',
        pendingDecision: {
          schemaVersion: 1,
          requestId: 'decision-complete',
          question: 'Choose a synthetic option.',
          options: [{ id: 'continue', label: 'Continue' }],
          requestedAt: '2026-08-22T00:30:00.000Z',
          requestedByRunId: 'run-complete',
        },
      })],
    });
    const partial = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('partial', { status: 'blocked', reviewState: 'confirmed' })],
    });
    const stale = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('stale', {
        status: 'waiting_for_decision',
        reviewState: 'confirmed',
        updatedAt: '2026-08-20T00:00:00.000Z',
        pendingDecision: {
          schemaVersion: 1,
          requestId: 'decision-stale',
          question: 'Choose a synthetic option.',
          options: [{ id: 'continue', label: 'Continue' }],
          requestedAt: '2026-08-20T00:00:00.000Z',
          requestedByRunId: 'run-stale',
        },
      })],
    });
    const integrity = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('integrity', {
        status: 'review',
        reviewState: 'confirmed',
        claim: {
          runId: 'run-integrity',
          agent: 'synthetic-agent',
          claimedAt: '2026-08-22T00:00:00.000Z',
          leaseExpiresAt: 'not-a-timestamp',
        },
      })],
    });
    const integrityWithoutCards = buildWorkbenchDashboard({
      now: NOW,
      projects,
      auditEvents: [],
      tasks: [task('legacy-integrity', {
        status: 'legacy_unknown',
        reviewState: 'confirmed',
      })],
    });

    expect(empty.dataState).toBe('empty');
    expect(complete.dataState).toBe('complete');
    expect(complete.stateReasons).toEqual([]);
    expect(partial.dataState).toBe('partial');
    expect(partial.views[1]?.cards[0]?.traceRef).toBeNull();
    expect(stale.dataState).toBe('stale');
    expect(stale.stateReasons).toContain('至少一项驾驶舱事实超过 24 小时未更新');
    expect(integrity.dataState).toBe('integrity');
    expect(integrity.integrity.invalidClaimLeaseTaskIds).toEqual(['integrity']);
    expect(integrityWithoutCards.dataState).toBe('integrity');
    expect(integrityWithoutCards.integrity.unknownStatusTaskIds).toEqual(['legacy-integrity']);
  });
});
