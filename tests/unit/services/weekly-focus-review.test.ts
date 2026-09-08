import { describe, expect, it } from 'vitest';

import type { WeeklyReportVersion } from '../../../src/domain/weekly-report.js';
import {
  confirmWeeklyFocus,
  loadWeeklyFocus,
  type WeeklyFocusGateway,
  type WeeklyFocusInput,
} from '../../../src/services/weekly-focus.js';
import {
  saveWeeklyFocusAttribution,
  saveWeeklyFocusReview,
} from '../../../src/services/weekly-focus-review.js';

const WEEK = '2026-W33';
const CONFIRMED_AT = new Date('2026-08-12T02:00:00.000Z');
const REVIEWED_AT = new Date('2026-08-16T12:30:00.000Z');

function weeklyReport(weekKey = WEEK): WeeklyReportVersion {
  const item = (progressId: string, version: number) => ({
    progressRef: { progressId, version },
    topic: `合成周报事实 ${progressId}`,
    reportCategory: 'project_acceptance' as const,
    contribution: 'self' as const,
    changes: ['合成变化'],
    conclusions: [],
    artifacts: [],
    blockers: [],
    pending: [],
    sourceRefs: [`fixtures/${progressId}.md`],
  });
  return {
    schemaVersion: 1,
    weeklyId: `weekly-${weekKey}`,
    version: 1,
    weekKey,
    week: { startDate: '2026-08-10', endDate: '2026-08-16' },
    acceptanceState: 'pending',
    publicationState: 'not_published',
    completeness: 'complete',
    progressRefs: [
      { progressId: 'progress-mapped', version: 1 },
      { progressId: 'progress-ignored', version: 2 },
    ],
    sections: [{
      primaryProjectId: 'project-synthetic',
      items: [item('progress-mapped', 1), item('progress-ignored', 2)],
    }],
    omissions: [],
    excludedProgressIds: [],
    pendingCount: 0,
    supersedesVersion: null,
    createdAt: '2026-08-16T10:00:00+08:00',
  };
}

const weeklyReports = { listCurrent: async () => [weeklyReport()] };

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
}

function input(): WeeklyFocusInput {
  return {
    conversationTopic: '验证本周三项重点。',
    selectedSources: ['目标', '项目', '任务'],
    currentQuestion: '哪些结果有证据？',
    coachSummary: '需要区分事实和用户判断。',
    focuses: [
      {
        focus: '完成重点一',
        outcome: '验收结果一',
        whyThisWeek: '本周承诺',
        evidence: 'Artifact 与验收',
        deferredTaskQuestions: [],
      },
      {
        focus: '推进重点二',
        outcome: '得到阶段结论',
        whyThisWeek: '依赖本周数据',
        evidence: '阶段事实',
        deferredTaskQuestions: [],
      },
      {
        focus: '判断重点三',
        outcome: '确认是否继续',
        whyThisWeek: '周末需要取舍',
        evidence: '用户判断',
        deferredTaskQuestions: [],
      },
    ],
    noNewFocus: false,
    notDoing: [],
    background: { facts: [], assumptions: [], gaps: [], sources: [] },
    coachInsights: [],
    consideredDirections: [],
    keyAnswers: [],
    linkedGoals: ['[[合成目标]]'],
    linkedTasks: ['task-done', 'task-partial', 'task-unassigned'],
    adjustmentNote: '',
    unassignedDeferredTaskQuestions: [],
  };
}

async function confirmedDocument(gateway: MemoryGateway) {
  return confirmWeeklyFocus(
    gateway,
    () => CONFIRMED_AT,
    input(),
    null,
    WEEK,
    'Asia/Shanghai',
  );
}

function completeReview(
  document: Awaited<ReturnType<typeof confirmedDocument>>,
): Parameters<typeof saveWeeklyFocusReview>[3] {
  return {
    document,
    taskAttributions: [],
    ignoredLinkedTasks: [],
    focusReviews: document.record.input.focuses.map((_, focusIndex) => ({
      focusIndex,
      outcome: '已完成',
      actualResult: `重点 ${focusIndex + 1} 已形成合成结果。`,
      evidenceGapNote: '',
    })),
    overallResult: '本周形成合成结果。',
    valueJudgment: '结果具有合成验证价值。',
    hypothesisOutcome: '验证了合成假设。',
    nextWeekAction: '继续',
  };
}

describe('weekly focus review persistence', () => {
  it('loads a legacy week-level task list as unassigned without inventing review data', async () => {
    const gateway = new MemoryGateway();
    await confirmedDocument(gateway);

    const loaded = await loadWeeklyFocus(gateway, WEEK);

    expect(loaded?.record.taskAttributions).toEqual([]);
    expect(loaded?.record.ignoredLinkedTasks).toEqual([]);
    expect(loaded?.record.review).toBeNull();
    expect(loaded?.record.reviewedAt).toBeNull();
    expect(loaded?.record.linkedTasks).toEqual([
      'task-done',
      'task-partial',
      'task-unassigned',
    ]);
  });

  it('saves per-focus task attribution without completing review or losing manual text', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const manualBody = '\n\n用户手工正文：这段内容必须逐字保留。\n';
    gateway.files.set(confirmed.path, `${confirmed.raw}${manualBody}`);
    const loaded = await loadWeeklyFocus(gateway, WEEK);

    const saved = await saveWeeklyFocusAttribution(gateway, weeklyReports, () => REVIEWED_AT, {
      document: loaded!,
      taskAttributions: [
        { focusIndex: 0, taskIds: ['task-done'] },
        { focusIndex: 1, taskIds: ['task-partial'] },
      ],
      ignoredLinkedTasks: ['task-unassigned'],
    });

    expect(saved.record.reviewStatus).toBe('待复盘');
    expect(saved.record.taskAttributions).toEqual([
      { focusIndex: 0, taskIds: ['task-done'] },
      { focusIndex: 1, taskIds: ['task-partial'] },
    ]);
    expect(saved.record.ignoredLinkedTasks).toEqual(['task-unassigned']);
    expect(saved.raw.endsWith(manualBody)).toBe(true);
    expect(saved.raw).toContain('## 逐项任务归属');
    expect(saved.raw).toContain('### 已忽略的周级关联任务');
  });

  it('persists weekly-report evidence mapping and ignore decisions without losing manual text', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const manualBody = '\n\n用户手工正文：周报证据归属不得改写这里。\n';
    gateway.files.set(confirmed.path, `${confirmed.raw}${manualBody}`);
    const loaded = await loadWeeklyFocus(gateway, WEEK);

    const saved = await saveWeeklyFocusAttribution(gateway, weeklyReports, () => REVIEWED_AT, {
      document: loaded!,
      taskAttributions: [],
      ignoredLinkedTasks: [],
      weeklyEvidenceAttributions: [{
        focusIndex: 0,
        sourceKeys: ['weekly-report:progress-mapped:v1'],
      }],
      ignoredWeeklyEvidence: ['weekly-report:progress-ignored:v2'],
    } as Parameters<typeof saveWeeklyFocusAttribution>[3]);
    const reloaded = await loadWeeklyFocus(gateway, WEEK);

    expect(reloaded?.record).toMatchObject({
      weeklyEvidenceAttributions: [{
        focusIndex: 0,
        sourceKeys: ['weekly-report:progress-mapped:v1'],
      }],
      ignoredWeeklyEvidence: ['weekly-report:progress-ignored:v2'],
    });
    expect(saved.raw.endsWith(manualBody)).toBe(true);
    expect(saved.raw).toContain('weekly-report:progress-mapped:v1');
    expect(saved.raw).toContain('weekly-report:progress-ignored:v2');
  });

  it('rejects invented weekly-report evidence keys without changing the weekly-focus bytes', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const before = gateway.files.get(confirmed.path);

    await expect(saveWeeklyFocusAttribution(gateway, weeklyReports, () => REVIEWED_AT, {
      document: confirmed,
      taskAttributions: [],
      ignoredLinkedTasks: [],
      weeklyEvidenceAttributions: [{
        focusIndex: 0,
        sourceKeys: ['weekly-report:not-present:v99'],
      }],
      ignoredWeeklyEvidence: ['weekly-report:also-not-present:v100'],
    })).rejects.toThrow('周报证据键不属于当前周报');

    expect(gateway.files.get(confirmed.path)).toBe(before);
  });

  it('rejects a canonical key from a different week and preserves the original bytes', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const before = gateway.files.get(confirmed.path);
    const previous = weeklyReport('2026-W32');
    const previousItem = previous.sections[0]?.items[0];
    if (previousItem === undefined) throw new Error('expected synthetic weekly evidence');
    previousItem.progressRef = { progressId: 'previous-week-only', version: 1 };

    await expect(saveWeeklyFocusAttribution(
      gateway,
      { listCurrent: async () => [weeklyReport(), previous] },
      () => REVIEWED_AT,
      {
        document: confirmed,
        taskAttributions: [],
        ignoredLinkedTasks: [],
        weeklyEvidenceAttributions: [{
          focusIndex: 0,
          sourceKeys: ['weekly-report:previous-week-only:v1'],
        }],
        ignoredWeeklyEvidence: [],
      },
    )).rejects.toThrow('周报证据键不属于当前周报');

    expect(gateway.files.get(confirmed.path)).toBe(before);
  });

  it('fails closed when current weekly reports cannot be read', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const before = gateway.files.get(confirmed.path);

    await expect(saveWeeklyFocusAttribution(
      gateway,
      { listCurrent: async () => { throw new Error('synthetic read failure'); } },
      () => REVIEWED_AT,
      {
        document: confirmed,
        taskAttributions: [],
        ignoredLinkedTasks: [],
      },
    )).rejects.toThrow('当前周报读取失败，无法校验周报证据键');

    expect(gateway.files.get(confirmed.path)).toBe(before);
  });

  it('persists and reloads one independent coverage judgment without inventing the other', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);

    const saved = await saveWeeklyFocusAttribution(
      gateway,
      weeklyReports,
      () => REVIEWED_AT,
      {
        document: confirmed,
        taskAttributions: [],
        ignoredLinkedTasks: [],
        focusEvidenceCoverage: [{
          focusIndex: 0,
          expectedOutcomeCovered: true,
        }],
      },
    );
    const reloaded = await loadWeeklyFocus(gateway, WEEK);

    expect(reloaded?.record.focusEvidenceCoverage).toEqual([{
      focusIndex: 0,
      expectedOutcomeCovered: true,
    }]);
    expect(saved.raw).toContain('预期结果已覆盖: true');
    expect(saved.raw).not.toContain('完成证据已覆盖: false');
  });

  it('rejects an unreconcilable stored key on review save without changing bytes', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    confirmed.record.ignoredWeeklyEvidence = ['weekly-report:stale:v1'];
    const before = gateway.files.get(confirmed.path);

    await expect(saveWeeklyFocusReview(
      gateway,
      weeklyReports,
      () => REVIEWED_AT,
      completeReview(confirmed),
    )).rejects.toThrow('周报证据键不属于当前周报');

    expect(gateway.files.get(confirmed.path)).toBe(before);
  });

  it('persists and reloads a complete user review, then allows a revision', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const first = await saveWeeklyFocusReview(gateway, weeklyReports, () => REVIEWED_AT, {
      document: confirmed,
      taskAttributions: [
        { focusIndex: 0, taskIds: ['task-done'] },
        { focusIndex: 1, taskIds: ['task-partial'] },
      ],
      ignoredLinkedTasks: ['task-unassigned'],
      focusReviews: [
        {
          focusIndex: 0,
          outcome: '已完成',
          actualResult: '重点一已通过验收。',
          evidenceGapNote: '',
        },
        {
          focusIndex: 1,
          outcome: '部分完成',
          actualResult: '阶段结果已形成，验收待补。',
          evidenceGapNote: '缺少最终验收。',
        },
        {
          focusIndex: 2,
          outcome: '已调整',
          actualResult: '改为下周验证。',
          evidenceGapNote: '本周没有直接任务。',
        },
      ],
      overallResult: '完成一项，推进一项，调整一项。',
      valueJudgment: '重点一产生了可复用结果。',
      hypothesisOutcome: '验证了先验收再扩展的假设。',
      nextWeekAction: '调整',
    });

    expect(first.record.reviewStatus).toBe('已复盘');
    expect(first.record.reviewedAt).toBe('2026-08-16T20:30:00+08:00');
    expect(first.record.review?.focusReviews.map(({ outcome }) => outcome)).toEqual([
      '已完成', '部分完成', '已调整',
    ]);
    const reopened = await loadWeeklyFocus(gateway, WEEK);
    expect(reopened?.record.review).toEqual(first.record.review);

    const revised = await saveWeeklyFocusReview(
      gateway,
      weeklyReports,
      () => new Date('2026-08-16T13:00:00.000Z'),
      {
        document: reopened!,
        taskAttributions: first.record.taskAttributions ?? [],
        ignoredLinkedTasks: first.record.ignoredLinkedTasks ?? [],
        focusReviews: first.record.review!.focusReviews,
        overallResult: '修订：一项完成，一项推进，一项调整。',
        valueJudgment: first.record.review!.valueJudgment,
        hypothesisOutcome: first.record.review!.hypothesisOutcome,
        nextWeekAction: first.record.review!.nextWeekAction,
      },
    );
    expect(revised.record.review?.overallResult).toContain('修订');
    expect(revised.record.reviewedAt).toBe('2026-08-16T21:00:00+08:00');
  });

  it('rejects stale content without overwriting the concurrent manual edit', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    gateway.files.set(confirmed.path, `${confirmed.raw}\n并发人工输入`);

    await expect(saveWeeklyFocusAttribution(gateway, weeklyReports, () => REVIEWED_AT, {
      document: confirmed,
      taskAttributions: [{ focusIndex: 0, taskIds: ['task-done'] }],
      ignoredLinkedTasks: [],
    })).rejects.toMatchObject({ code: 'weekly_focus_conflict' });
    expect(gateway.files.get(confirmed.path)).toBe(`${confirmed.raw}\n并发人工输入`);
  });

  it('rejects an invalid review outcome before writing the weekly focus record', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const before = gateway.files.get(confirmed.path);
    const review = completeReview(confirmed);
    const first = review.focusReviews[0];
    if (first === undefined) throw new Error('expected a synthetic focus review');
    first.outcome = 'completed' as never;

    expect(() => saveWeeklyFocusReview(gateway, weeklyReports, () => REVIEWED_AT, review))
      .toThrow('重点复盘结果无效');
    expect(gateway.files.get(confirmed.path)).toBe(before);
  });

  it('rejects an invalid next-week action before writing the weekly focus record', async () => {
    const gateway = new MemoryGateway();
    const confirmed = await confirmedDocument(gateway);
    const before = gateway.files.get(confirmed.path);
    const review = completeReview(confirmed);
    review.nextWeekAction = '推迟' as never;

    expect(() => saveWeeklyFocusReview(gateway, weeklyReports, () => REVIEWED_AT, review))
      .toThrow('下周动作无效');
    expect(gateway.files.get(confirmed.path)).toBe(before);
  });
});
