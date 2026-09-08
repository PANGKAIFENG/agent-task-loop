import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import type { WeeklyReportVersion } from '../../../src/domain/weekly-report.js';
import {
  confirmWeeklyFocus,
  loadWeeklyFocus,
  saveWeeklyFocusDraft,
  type WeeklyFocusGateway,
  type WeeklyFocusInput,
} from '../../../src/services/weekly-focus.js';
import {
  saveWeeklyFocusAttribution,
  saveWeeklyFocusReview,
} from '../../../src/services/weekly-focus-review.js';
import {
  projectWeeklyFocusProgress,
  queryWeeklyFocusProgress,
  queryWeeklyFocusReviewIndex,
} from '../../../src/services/query-weekly-focus-review.js';

const WEEK = '2026-W33';
const emptyWeeklyReports = { listCurrent: async () => [] };

class MemoryGateway implements WeeklyFocusGateway {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<boolean> {
    const current = this.files.get(path) ?? null;
    if (current !== expectedContent) return false;
    this.files.set(path, content);
    return true;
  }

  async listPaths(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

function focusInput(linkedTasks: string[] = []): WeeklyFocusInput {
  return {
    conversationTopic: '合成周重点验证',
    selectedSources: ['任务'],
    currentQuestion: '证据支持哪些判断？',
    coachSummary: '按重点投影事实。',
    focuses: [
      {
        focus: '交付可验收结果',
        outcome: 'Artifact 通过验收',
        whyThisWeek: '本周承诺',
        evidence: '完成事件、Artifact 与验收',
        deferredTaskQuestions: [],
      },
      {
        focus: '完成阶段验证',
        outcome: '形成阶段结论',
        whyThisWeek: '需要本周数据',
        evidence: '阶段 Artifact',
        deferredTaskQuestions: [],
      },
      {
        focus: '决定是否继续',
        outcome: '形成继续或停止判断',
        whyThisWeek: '周末取舍',
        evidence: '用户价值判断',
        deferredTaskQuestions: [],
      },
    ],
    noNewFocus: false,
    notDoing: [],
    background: { facts: [], assumptions: [], gaps: [], sources: [] },
    coachInsights: [],
    consideredDirections: [],
    keyAnswers: [],
    linkedGoals: [],
    linkedTasks,
    adjustmentNote: '',
    unassignedDeferredTaskQuestions: [],
  };
}

function task(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId,
    title: `合成任务 ${taskId}`,
    body: 'Synthetic task body.',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'development',
    objective: 'Produce a synthetic result.',
    acceptanceCriteria: ['Synthetic acceptance.'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    origin: 'synthetic_test',
    sourceDate: '2026-08-10',
    sourceNote: 'fixtures/source.md',
    sourceQuote: 'Synthetic source quote.',
    sourceKey: `synthetic:${taskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-10T09:00:00+08:00',
    createdAt: '2026-08-10T09:00:00+08:00',
    updatedAt: '2026-08-15T09:00:00+08:00',
    ...overrides,
  };
}

function weeklyReport(): WeeklyReportVersion {
  return {
    schemaVersion: 1,
    weeklyId: 'weekly-2026-W33',
    version: 1,
    weekKey: WEEK,
    week: { startDate: '2026-08-10', endDate: '2026-08-16' },
    acceptanceState: 'pending',
    publicationState: 'not_published',
    completeness: 'partial_success',
    progressRefs: [{ progressId: 'progress-unassigned', version: 1 }],
    sections: [{
      primaryProjectId: 'project-synthetic',
      items: [{
        progressRef: { progressId: 'progress-unassigned', version: 1 },
        topic: '尚未归属的周报事实',
        reportCategory: 'project_acceptance',
        contribution: 'self',
        changes: ['完成了一项活动，但尚未关联重点。'],
        conclusions: [],
        artifacts: [],
        blockers: [],
        pending: [],
        sourceRefs: ['fixtures/unassigned.md'],
      }],
    }],
    omissions: [{
      progressId: 'progress-missing',
      version: 1,
      reasons: ['缺少项目归属'],
    }],
    excludedProgressIds: [],
    pendingCount: 1,
    supersedesVersion: null,
    createdAt: '2026-08-16T10:00:00+08:00',
  };
}

describe('weekly focus progress projection', () => {
  it('keeps fact, suggestion, and user judgment separate for three focus states', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(['task-done', 'task-partial', 'task-unassigned']),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    document.record.taskAttributions = [
      { focusIndex: 0, taskIds: ['task-done'] },
      { focusIndex: 1, taskIds: ['task-partial'] },
    ];
    document.record.focusEvidenceCoverage = [{
      focusIndex: 0,
      expectedOutcomeCovered: true,
      expectedEvidenceCovered: true,
    }];

    const projection = projectWeeklyFocusProgress({
      document,
      tasks: [
        task('task-done', {
          status: 'done',
          artifactRefs: ['Artifacts/task-done/attempt-001.md'],
        }),
        task('task-partial', {
          status: 'done',
          artifactRefs: ['Artifacts/task-partial/attempt-001.md'],
        }),
      ],
      auditEvents: [
        {
          event: 'task.reviewed',
          at: '2026-08-15T12:00:00+08:00',
          taskId: 'task-done',
          details: { decision: 'approve' },
        },
        {
          event: 'task.completion_date_recorded',
          at: '2026-08-15T12:00:00+08:00',
          taskId: 'task-partial',
          details: { source: 'manual_backfill' },
        },
      ],
      artifacts: [
        {
          taskId: 'task-done',
          ref: 'Artifacts/task-done/attempt-001.md',
          status: 'available',
          summary: '已交付并验收。',
          checks: { met: 1, partial: 0, notMet: 0 },
        },
        {
          taskId: 'task-partial',
          ref: 'Artifacts/task-partial/attempt-001.md',
          status: 'available',
          summary: '阶段结果。',
          checks: { met: 0, partial: 1, notMet: 0 },
        },
      ],
      weeklyReport: weeklyReport(),
      readFailures: [],
    });

    expect(projection.focuses.map(({ suggestion }) => suggestion.status)).toEqual([
      'evidence_supported',
      'partial_evidence',
      'no_evidence',
    ]);
    expect(projection.focuses[0]).toMatchObject({
      suggestion: { layer: 'suggestion', label: '证据支持完成' },
      userJudgment: null,
      facts: {
        tasks: [{
          layer: 'fact',
          taskId: 'task-done',
          status: 'done',
          updatedAt: '2026-08-15T09:00:00+08:00',
          sourceDate: '2026-08-10',
          sourceRef: 'fixtures/source.md',
          sourceKey: 'synthetic:task-done',
        }],
        completions: [{ layer: 'fact', taskId: 'task-done' }],
        artifacts: [{ layer: 'fact', status: 'available' }],
        acceptances: [{ layer: 'fact', status: 'accepted' }],
      },
    });
    const partialFocus = projection.focuses[1];
    const emptyFocus = projection.focuses[2];
    expect(partialFocus).toBeDefined();
    expect(emptyFocus).toBeDefined();
    if (partialFocus === undefined || emptyFocus === undefined) {
      throw new Error('expected all synthetic focuses to be projected');
    }
    expect(partialFocus.gaps.map(({ code, action }) => ({ code, action }))).toEqual(
      expect.arrayContaining([
        { code: 'acceptance_missing', action: '完成验收' },
        { code: 'acceptance_incomplete', action: '补齐未通过的验收项' },
      ]),
    );
    expect(emptyFocus.gaps).toContainEqual(expect.objectContaining({
      code: 'no_linked_task',
      action: '关联任务或说明本周调整原因',
    }));
    expect(projection.unassignedTasks).toEqual(['task-unassigned']);
    expect(projection.unassignedEvidence).toContainEqual(expect.objectContaining({
      topic: '尚未归属的周报事实',
      action: '关联到重点或明确忽略',
    }));
    expect(projection.reportDataCompleteness).toEqual({
      label: '周报数据完整性',
      value: '部分成功',
      detail: '1 项聚合遗漏，1 项待补齐',
    });
    expect(JSON.stringify(projection)).not.toContain('completionRate');
  });

  it('does not let completion and acceptance facts cross a task reopen boundary', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(['task-reopened']),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    document.record.taskAttributions = [{ focusIndex: 0, taskIds: ['task-reopened'] }];

    const projection = projectWeeklyFocusProgress({
      document,
      tasks: [task('task-reopened', {
        status: 'ready',
        updatedAt: '2026-08-15T14:00:00+08:00',
        artifactRefs: ['Artifacts/task-reopened/attempt-001.md'],
      })],
      auditEvents: [
        {
          event: 'task.completion_date_recorded',
          at: '2026-08-15T11:00:00+08:00',
          taskId: 'task-reopened',
          details: { source: 'manual_backfill' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-15T12:00:00+08:00',
          taskId: 'task-reopened',
          details: { decision: 'approve' },
        },
        {
          event: 'task.reopened',
          at: '2026-08-15T14:00:00+08:00',
          taskId: 'task-reopened',
        },
      ],
      artifacts: [{
        taskId: 'task-reopened',
        ref: 'Artifacts/task-reopened/attempt-001.md',
        status: 'available',
        summary: '历史合成结果。',
        checks: { met: 1, partial: 0, notMet: 0 },
      }],
      weeklyReport: null,
      readFailures: [],
    });

    const reopened = projection.focuses[0];
    expect(reopened?.facts.completions).toEqual([]);
    expect(reopened?.facts.acceptances).toContainEqual(expect.objectContaining({
      taskId: 'task-reopened',
      status: 'missing',
    }));
    expect(reopened?.gaps).toContainEqual(expect.objectContaining({
      code: 'task_reopened',
      action: '重新完成任务并重新验收',
    }));
    expect(reopened?.suggestion.status).toBe('partial_evidence');
  });

  it('keeps accepted task evidence partial until focus expectations are explicitly covered', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(['task-accepted']),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    document.record.taskAttributions = [{ focusIndex: 0, taskIds: ['task-accepted'] }];

    const facts = {
      tasks: [task('task-accepted', {
        status: 'done',
        artifactRefs: ['Artifacts/task-accepted/attempt-001.md'],
      })],
      auditEvents: [
        {
          event: 'task.completion_date_recorded',
          at: '2026-08-15T11:00:00+08:00',
          taskId: 'task-accepted',
          details: { source: 'manual_backfill' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-15T12:00:00+08:00',
          taskId: 'task-accepted',
          details: { decision: 'approve' },
        },
      ],
      artifacts: [{
        taskId: 'task-accepted',
        ref: 'Artifacts/task-accepted/attempt-001.md',
        status: 'available' as const,
        summary: '已通过合成验收。',
        checks: { met: 1, partial: 0, notMet: 0 },
      }],
      weeklyReport: null,
      readFailures: [],
    };
    const projection = projectWeeklyFocusProgress({ document, ...facts });

    expect(projection.focuses[0]?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'expected_outcome_uncovered',
        action: '核对事实并确认是否覆盖预期结果',
      }),
      expect.objectContaining({
        code: 'expected_evidence_uncovered',
        action: '核对事实并确认是否覆盖完成证据',
      }),
    ]));
    expect(projection.focuses[0]?.suggestion.status).toBe('partial_evidence');

    Object.assign(document.record, {
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedOutcomeCovered: true,
      }],
    });
    const partiallyConfirmed = projectWeeklyFocusProgress({ document, ...facts });
    expect(partiallyConfirmed.focuses[0]?.gaps).not.toContainEqual(expect.objectContaining({
      code: 'expected_outcome_uncovered',
    }));
    expect(partiallyConfirmed.focuses[0]?.gaps).toContainEqual(expect.objectContaining({
      code: 'expected_evidence_uncovered',
      message: '尚未确认当前事实是否覆盖该重点的完成证据。',
    }));

    Object.assign(document.record, {
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedOutcomeCovered: true,
        expectedEvidenceCovered: true,
      }],
    });
    const covered = projectWeeklyFocusProgress({ document, ...facts });
    expect(covered.focuses[0]?.gaps).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'expected_outcome_uncovered' }),
      expect.objectContaining({ code: 'expected_evidence_uncovered' }),
    ]));
    expect(covered.focuses[0]?.suggestion.status).toBe('evidence_supported');
  });

  it('projects stable weekly-report evidence keys with mapped and ignored decisions', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    document.record.weeklyEvidenceAttributions = [{
      focusIndex: 0,
      sourceKeys: ['weekly-report:progress-unassigned:v1'],
    }];
    document.record.ignoredWeeklyEvidence = ['weekly-report:progress-ignored:v2'];
    const report = weeklyReport();
    const firstItem = report.sections[0]?.items[0];
    if (firstItem === undefined) throw new Error('expected synthetic weekly evidence');
    report.sections[0]?.items.push({
      ...firstItem,
      progressRef: { progressId: 'progress-ignored', version: 2 },
      topic: '明确忽略的合成事实',
      sourceRefs: ['fixtures/ignored.md'],
    });

    const projection = projectWeeklyFocusProgress({
      document,
      tasks: [],
      auditEvents: [],
      artifacts: [],
      weeklyReport: report,
      readFailures: [],
    });

    expect(projection.weeklyEvidence).toEqual([
      {
        sourceKey: 'weekly-report:progress-unassigned:v1',
        topic: '尚未归属的周报事实',
        sourceRefs: ['fixtures/unassigned.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'focus', focusIndex: 0 },
        action: '关联到重点或明确忽略',
      },
      {
        sourceKey: 'weekly-report:progress-ignored:v2',
        topic: '明确忽略的合成事实',
        sourceRefs: ['fixtures/ignored.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'ignored' },
        action: '关联到重点或明确忽略',
      },
    ]);
    expect(projection.unassignedEvidence).toEqual([]);
  });

  it('surfaces stale, missing source, missing Artifact, returned, blocked, conflict, and read-failure actions', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput([
        'task-missing',
        'task-stale',
        'task-no-artifact',
        'task-returned',
        'task-blocked',
        'task-conflict',
      ]),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    document.record.taskAttributions = [{
      focusIndex: 0,
      taskIds: document.record.linkedTasks,
    }];

    const projection = projectWeeklyFocusProgress({
      document,
      tasks: [
        task('task-stale', { updatedAt: '2026-08-01T09:00:00+08:00' }),
        task('task-no-artifact', { status: 'done', artifactRefs: [] }),
        task('task-returned', {
          status: 'ready',
          artifactRefs: ['Artifacts/task-returned/attempt-001.md'],
          reviewFeedback: '需要返工。',
        }),
        task('task-blocked', { status: 'blocked', reviewFeedback: '缺少决策。' }),
        task('task-conflict', {
          status: 'done',
          artifactRefs: ['Artifacts/task-conflict/attempt-001.md'],
        }),
      ],
      auditEvents: [
        {
          event: 'task.reviewed',
          at: '2026-08-15T10:00:00+08:00',
          taskId: 'task-returned',
          details: { decision: 'request_changes' },
        },
        {
          event: 'task.reviewed',
          at: '2026-08-15T10:00:00+08:00',
          taskId: 'task-conflict',
          details: { decision: 'request_changes' },
        },
      ],
      artifacts: [
        {
          taskId: 'task-returned',
          ref: 'Artifacts/task-returned/attempt-001.md',
          status: 'available',
          summary: '待返工结果。',
          checks: { met: 0, partial: 0, notMet: 1 },
        },
        {
          taskId: 'task-conflict',
          ref: 'Artifacts/task-conflict/attempt-001.md',
          status: 'available',
          summary: '状态冲突结果。',
          checks: { met: 1, partial: 0, notMet: 0 },
        },
      ],
      weeklyReport: null,
      readFailures: [{ source: 'artifact', reference: 'task-no-artifact', code: 'read_failed' }],
    });

    const conflictFocus = projection.focuses[0];
    expect(conflictFocus).toBeDefined();
    if (conflictFocus === undefined) throw new Error('expected the synthetic focus to be projected');
    const gaps = conflictFocus.gaps;
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'task_source_missing', action: '修复任务来源或重新关联' }),
      expect.objectContaining({ code: 'task_stale', action: '更新任务状态或确认仍然有效' }),
      expect.objectContaining({ code: 'artifact_missing', action: '添加成果链接' }),
      expect.objectContaining({ code: 'artifact_returned', action: '按退回意见修订后重新验收' }),
      expect.objectContaining({ code: 'task_blocked', action: '处理阻塞或说明本周调整原因' }),
      expect.objectContaining({ code: 'source_conflict', action: '核对冲突来源并确认实际结果' }),
      expect.objectContaining({ code: 'partial_read_failure', action: '重试读取并保留当前人工判断' }),
    ]));
    expect(conflictFocus.suggestion.status).toBe('conflicting_evidence');
  });
});

describe('weekly focus progress query', () => {
  it('assembles read-only task, audit, Artifact, and weekly-report facts', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(['task-done']),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    await saveWeeklyFocusAttribution(gateway, emptyWeeklyReports, () => (
      new Date('2026-08-12T03:00:00.000Z')
    ), {
      document,
      taskAttributions: [{ focusIndex: 0, taskIds: ['task-done'] }],
      ignoredLinkedTasks: [],
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedOutcomeCovered: true,
        expectedEvidenceCovered: true,
      }],
    });
    const result = await queryWeeklyFocusProgress({
      gateway,
      week: WEEK,
      tasks: {
        list: async () => [task('task-done', {
          status: 'done',
          artifactRefs: ['Artifacts/task-done/attempt-001.md'],
        })],
      },
      audit: {
        listForTask: async () => [
          {
            event: 'task.completion_date_recorded',
            at: '2026-08-15T12:00:00+08:00',
            taskId: 'task-done',
          },
          {
            event: 'task.reviewed',
            at: '2026-08-15T13:00:00+08:00',
            taskId: 'task-done',
            details: { decision: 'approve' },
          },
        ],
      },
      artifacts: {
        readSummary: async () => ({
          summary: '合成 Artifact。',
          evidenceCount: 1,
          checks: { met: 1, partial: 0, notMet: 0 },
          sha256: 'synthetic',
        }),
      },
      weeklyReports: { listCurrent: async () => [weeklyReport()] },
    });

    expect(result?.projection.focuses[0]).toMatchObject({
      suggestion: { status: 'evidence_supported' },
      facts: {
        artifacts: [{ status: 'available', summary: '合成 Artifact。' }],
        acceptances: [{ status: 'accepted' }],
      },
    });
    expect(result?.projection.reportDataCompleteness?.label).toBe('周报数据完整性');
  });

  it('keeps the review open with an explicit smallest action after a source read failure', async () => {
    const gateway = new MemoryGateway();
    const document = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-12T02:00:00.000Z'),
      focusInput(['task-artifact-failed']),
      null,
      WEEK,
      'Asia/Shanghai',
    );
    await saveWeeklyFocusAttribution(gateway, emptyWeeklyReports, () => (
      new Date('2026-08-12T03:00:00.000Z')
    ), {
      document,
      taskAttributions: [{ focusIndex: 0, taskIds: ['task-artifact-failed'] }],
      ignoredLinkedTasks: [],
    });
    const result = await queryWeeklyFocusProgress({
      gateway,
      week: WEEK,
      tasks: {
        list: async () => [task('task-artifact-failed', {
          status: 'done',
          artifactRefs: ['Artifacts/task-artifact-failed/attempt-001.md'],
        })],
      },
      audit: { listForTask: async () => [] },
      artifacts: { readSummary: async () => { throw new Error('read failed'); } },
      weeklyReports: { listCurrent: async () => { throw new Error('read failed'); } },
    });

    expect(result?.projection.readFailures).toEqual(expect.arrayContaining([
      { source: 'artifact', reference: 'task-artifact-failed', code: 'read_failed' },
      { source: 'weekly_report', reference: WEEK, code: 'read_failed' },
    ]));
    const failedFocus = result?.projection.focuses[0];
    expect(failedFocus).toBeDefined();
    if (failedFocus === undefined) throw new Error('expected the synthetic focus to be projected');
    expect(failedFocus.gaps).toContainEqual(expect.objectContaining({
      code: 'partial_read_failure',
      action: '重试读取并保留当前人工判断',
    }));
  });
});

describe('weekly focus review index', () => {
  it('keeps current empty, previous pending, and reviewed weeks as separate states', async () => {
    const gateway = new MemoryGateway();
    const reviewed = await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-07-29T02:00:00.000Z'),
      focusInput(),
      null,
      '2026-W31',
      'Asia/Shanghai',
    );
    await saveWeeklyFocusReview(gateway, emptyWeeklyReports, () => (
      new Date('2026-08-02T10:00:00.000Z')
    ), {
      document: reviewed,
      taskAttributions: [],
      ignoredLinkedTasks: [],
      focusReviews: reviewed.record.input.focuses.map((_, focusIndex) => ({
        focusIndex,
        outcome: '已取消' as const,
        actualResult: '本周没有继续。',
        evidenceGapNote: '无任务证据。',
      })),
      overallResult: '已结束本周。',
      valueJudgment: '及时停止没有价值的方向。',
      hypothesisOutcome: '推翻原假设。',
      nextWeekAction: '停止',
    });
    await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-05T02:00:00.000Z'),
      focusInput(),
      null,
      '2026-W32',
      'Asia/Shanghai',
    );

    const index = await queryWeeklyFocusReviewIndex({
      gateway,
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(index.currentWeek).toBe(WEEK);
    expect(index.current).toBeNull();
    expect(index.previousPending.map(({ record }) => record.week)).toEqual(['2026-W32']);
    expect(index.reviewed.map(({ record }) => record.week)).toEqual(['2026-W31']);
  });

  it('skips malformed weekly paths as explicit read failures instead of hiding valid weeks', async () => {
    const gateway = new MemoryGateway();
    await confirmWeeklyFocus(
      gateway,
      () => new Date('2026-08-05T02:00:00.000Z'),
      focusInput(),
      null,
      '2026-W32',
      'Asia/Shanghai',
    );
    gateway.files.set('05_Reviews/Weekly/2026-W31 周度重点.md', 'invalid');

    const index = await queryWeeklyFocusReviewIndex({
      gateway,
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(index.previousPending).toHaveLength(1);
    expect(index.readFailures).toEqual([{
      path: '05_Reviews/Weekly/2026-W31 周度重点.md',
      code: 'weekly_focus_read_failed',
    }]);
    await expect(loadWeeklyFocus(gateway, '2026-W32')).resolves.not.toBeNull();
  });

  it('indexes confirmed weekly records only and excludes drafts', async () => {
    const gateway = new MemoryGateway();
    await saveWeeklyFocusDraft(
      gateway,
      () => new Date('2026-08-05T02:00:00.000Z'),
      focusInput(),
      null,
      'Asia/Shanghai',
    );

    const index = await queryWeeklyFocusReviewIndex({
      gateway,
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });

    expect(index.previousPending).toEqual([]);
    expect(index.reviewed).toEqual([]);
  });
});
