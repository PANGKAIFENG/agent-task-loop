/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { WeeklyFocusDocument } from '../../../src/services/weekly-focus.js';
import type { WeeklyFocusProgressProjection } from '../../../src/services/query-weekly-focus-review.js';
import { WeeklyFocusReviewModal } from '../../../src/obsidian-plugin/weekly-focus-review-modal.js';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.createDiv = function createDiv(options = {}): HTMLDivElement {
    return this.createEl('div', options);
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: DomElementInfo | string = {},
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    const info = typeof options === 'string' ? { text: options } : options;
    if (info.cls !== undefined) {
      element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    }
    if (info.text instanceof DocumentFragment) element.append(info.text);
    else if (info.text !== undefined) element.textContent = info.text;
    if (info.type !== undefined) element.setAttribute('type', info.type);
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    this.append(element);
    callback?.(element);
    return element;
  };
});

function documentFixture(): WeeklyFocusDocument {
  return {
    path: '05_Reviews/Weekly/2026-W33 周度重点.md',
    raw: 'synthetic weekly focus',
    record: {
      type: '周度重点',
      week: '2026-W33',
      status: '已确认',
      linkedGoals: [],
      linkedTasks: ['task-done', 'task-unassigned'],
      createdBy: 'ATL 思考教练',
      confirmedAt: '2026-08-12T10:00:00+08:00',
      reviewStatus: '待复盘',
      taskAttributions: [{ focusIndex: 0, taskIds: ['task-done'] }],
      ignoredLinkedTasks: [],
      focusEvidenceCoverage: [],
      weeklyEvidenceAttributions: [],
      ignoredWeeklyEvidence: [],
      review: null,
      reviewedAt: null,
      updatedAt: '2026-08-12T10:00:00+08:00',
      input: {
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
        linkedTasks: ['task-done', 'task-unassigned'],
        adjustmentNote: '',
        unassignedDeferredTaskQuestions: [],
      },
    },
  };
}

function projectionFixture(): WeeklyFocusProgressProjection {
  return {
    week: '2026-W33',
    reviewStatus: '待复盘',
    reviewedAt: null,
    focuses: [
      {
        focusIndex: 0,
        focus: '交付可验收结果',
        expectedOutcome: 'Artifact 通过验收',
        expectedEvidence: '完成事件、Artifact 与验收',
        facts: {
          tasks: [{
            layer: 'fact',
            taskId: 'task-done',
            title: '合成交付任务',
            status: 'done',
            updatedAt: '2026-08-15T09:00:00+08:00',
            sourceDate: '2026-08-10',
            sourceRef: 'fixtures/source.md',
            sourceKey: 'synthetic:task-done',
            blocker: null,
          }],
          completions: [{
            layer: 'fact',
            taskId: 'task-done',
            completedAt: '2026-08-15T09:00:00+08:00',
            source: 'task.completion_date_recorded',
          }],
          artifacts: [{
            layer: 'fact',
            taskId: 'task-done',
            ref: 'Artifacts/task-done/attempt-001.md',
            status: 'available',
            summary: '合成 Artifact 已生成。',
            checks: { met: 1, partial: 0, notMet: 0 },
          }],
          acceptances: [{
            layer: 'fact',
            taskId: 'task-done',
            status: 'accepted',
            detail: '存在完成事实、Artifact 和通过验收。',
          }],
        },
        gaps: [],
        suggestion: {
          layer: 'suggestion',
          status: 'evidence_supported',
          label: '证据支持完成',
          reasons: ['直接关联任务具有完成事实、Artifact 和通过验收。'],
        },
        userJudgment: null,
      },
      {
        focusIndex: 1,
        focus: '决定是否继续',
        expectedOutcome: '形成继续或停止判断',
        expectedEvidence: '用户价值判断',
        facts: { tasks: [], completions: [], artifacts: [], acceptances: [] },
        gaps: [{
          code: 'no_linked_task',
          message: '该重点没有直接关联任务或结果证据。',
          action: '关联任务或说明本周调整原因',
        }],
        suggestion: {
          layer: 'suggestion',
          status: 'no_evidence',
          label: '无关联证据',
          reasons: ['该重点没有直接关联任务或结果证据。'],
        },
        userJudgment: null,
      },
    ],
    unassignedTasks: ['task-unassigned'],
    weeklyEvidence: [
      {
        sourceKey: 'weekly-report:progress-unassigned:v1',
        topic: '尚未归属的周报事实',
        sourceRefs: ['fixtures/progress.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'unassigned' },
        action: '关联到重点或明确忽略',
      },
      {
        sourceKey: 'weekly-report:progress-ignore:v1',
        topic: '可明确忽略的周报事实',
        sourceRefs: ['fixtures/ignore.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'unassigned' },
        action: '关联到重点或明确忽略',
      },
    ],
    unassignedEvidence: [
      {
        sourceKey: 'weekly-report:progress-unassigned:v1',
        topic: '尚未归属的周报事实',
        sourceRefs: ['fixtures/progress.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'unassigned' },
        action: '关联到重点或明确忽略',
      },
      {
        sourceKey: 'weekly-report:progress-ignore:v1',
        topic: '可明确忽略的周报事实',
        sourceRefs: ['fixtures/ignore.md'],
        sourceUpdatedAt: '2026-08-16T10:00:00+08:00',
        assignment: { kind: 'unassigned' },
        action: '关联到重点或明确忽略',
      },
    ],
    reportDataCompleteness: {
      label: '周报数据完整性',
      value: '部分成功',
      detail: '1 项聚合遗漏，1 项待补齐',
    },
    readFailures: [],
  };
}

function setValue(modal: WeeklyFocusReviewModal, label: string, value: string): void {
  const control = modal.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (control === null) throw new Error(`Missing control: ${label}`);
  control.value = value;
  control.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function selectValue(modal: WeeklyFocusReviewModal, label: string, value: string): void {
  const control = modal.contentEl.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (control === null) throw new Error(`Missing select: ${label}`);
  control.value = value;
  control.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function click(modal: WeeklyFocusReviewModal, label: string): void {
  const control = [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === label);
  if (control === undefined) throw new Error(`Missing button: ${label}`);
  control.click();
}

function setup(saveReview = vi.fn(async () => undefined)) {
  const session = { document: documentFixture(), projection: projectionFixture() };
  const saveAttribution = vi.fn(async () => undefined);
  const modal = new WeeklyFocusReviewModal({} as never, {
    week: '2026-W33',
    load: vi.fn(async () => session),
    saveAttribution,
    saveReview,
    canManageVault: () => true,
    onChanged: vi.fn(),
  });
  return { modal, saveAttribution, saveReview };
}

describe('WeeklyFocusReviewModal', () => {
  it('separates facts, suggestions, user judgment, and legacy task attribution', async () => {
    const { modal, saveAttribution, saveReview } = setup();
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    expect(modal.contentEl.textContent).toContain('来源事实');
    expect(modal.contentEl.textContent).toContain('合成交付任务');
    expect(modal.contentEl.textContent).toContain('Artifact');
    expect(modal.contentEl.textContent).toContain('完成事实：task-done');
    expect(modal.contentEl.textContent).toContain('任务事实更新时间：2026-08-15T09:00:00+08:00');
    expect(modal.contentEl.textContent).toContain('来源日期：2026-08-10');
    expect(modal.contentEl.textContent).toContain('来源：fixtures/source.md');
    expect(modal.contentEl.textContent).not.toContain('完成时间：2026-08-15T09:00:00+08:00');
    expect(modal.contentEl.textContent).toContain('Artifacts/task-done/attempt-001.md');
    expect(modal.contentEl.textContent).toContain('合成 Artifact 已生成。');
    expect(modal.contentEl.textContent).toContain('存在完成事实、Artifact 和通过验收。');
    expect(modal.contentEl.textContent).toContain('系统建议');
    expect(modal.contentEl.textContent).toContain('证据支持完成');
    expect(modal.contentEl.textContent).toContain('用户判断');
    expect(modal.contentEl.textContent).toContain('预期结果：Artifact 通过验收');
    expect(modal.contentEl.textContent).toContain('完成证据：完成事件、Artifact 与验收');
    expect(modal.contentEl.textContent).toContain('尚未逐项归属');
    expect(modal.contentEl.textContent).toContain('周报数据完整性');
    expect(modal.contentEl.textContent).not.toContain('完成度');

    selectValue(modal, 'task-unassigned 的归属', 'focus:1');
    selectValue(
      modal,
      '周报证据 weekly-report:progress-unassigned:v1 的归属',
      'focus:0',
    );
    selectValue(modal, '周报证据 weekly-report:progress-ignore:v1 的归属', 'ignore');
    selectValue(modal, '重点 1 预期结果覆盖', 'covered');
    selectValue(modal, '重点 1 完成证据覆盖', 'covered');
    click(modal, '保存任务归属');
    await vi.waitFor(() => expect(saveAttribution).toHaveBeenCalledWith(expect.objectContaining({
      taskAttributions: [
        { focusIndex: 0, taskIds: ['task-done'] },
        { focusIndex: 1, taskIds: ['task-unassigned'] },
      ],
      ignoredLinkedTasks: [],
      weeklyEvidenceAttributions: [{
        focusIndex: 0,
        sourceKeys: ['weekly-report:progress-unassigned:v1'],
      }],
      ignoredWeeklyEvidence: ['weekly-report:progress-ignore:v1'],
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedOutcomeCovered: true,
        expectedEvidenceCovered: true,
      }],
    })));
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('事实已刷新'));
    selectValue(modal, '重点 1 用户判断', '已完成');
    setValue(modal, '重点 1 实际结果', '  已交付并通过验收。  ');
    selectValue(modal, '重点 2 用户判断', '已调整');
    setValue(modal, '重点 2 实际结果', '调整到下周验证。');
    setValue(modal, '重点 2 证据不足说明', '本周无直接任务。');
    setValue(modal, '本周总体结果', '完成一项，调整一项。');
    setValue(modal, '价值判断', '已验证交付路径可用。');
    setValue(modal, '被验证或推翻的假设', '验证了先验收再扩展。');
    selectValue(modal, '下周动作', '调整');
    click(modal, '保存复盘');

    await vi.waitFor(() => expect(saveReview).toHaveBeenCalledWith(expect.objectContaining({
      taskAttributions: [
        { focusIndex: 0, taskIds: ['task-done'] },
        { focusIndex: 1, taskIds: ['task-unassigned'] },
      ],
      focusReviews: [
        expect.objectContaining({ focusIndex: 0, outcome: '已完成' }),
        expect.objectContaining({ focusIndex: 1, outcome: '已调整' }),
      ],
      overallResult: '完成一项，调整一项。',
      nextWeekAction: '调整',
    })));
  });

  it('shows blocker details and a smallest retry action for partial source reads', async () => {
    const session = { document: documentFixture(), projection: projectionFixture() };
    const firstTask = session.projection.focuses[0]?.facts.tasks[0];
    if (firstTask === undefined) throw new Error('expected a synthetic task fact');
    firstTask.status = 'blocked';
    firstTask.blocker = '等待合成依赖确认。';
    session.projection.readFailures = [{
      source: 'weekly_report',
      reference: '2026-W33',
      code: 'read_failed',
    }];
    const modal = new WeeklyFocusReviewModal({} as never, {
      week: '2026-W33',
      load: vi.fn(async () => session),
      saveReview: vi.fn(async () => undefined),
      canManageVault: () => true,
    });
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('等待合成依赖确认。'));
    expect(modal.contentEl.textContent).toContain('部分来源读取失败');
    expect(modal.contentEl.textContent).toContain('重试读取并保留当前人工判断');
  });

  it('persists only the coverage judgment the user explicitly selected', async () => {
    const { modal, saveAttribution } = setup();
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    selectValue(modal, '重点 1 预期结果覆盖', 'covered');
    click(modal, '保存任务归属');

    await vi.waitFor(() => expect(saveAttribution).toHaveBeenCalledWith(expect.objectContaining({
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedOutcomeCovered: true,
      }],
    })));
    expect(modal.contentEl.querySelector<HTMLSelectElement>(
      '[aria-label="重点 1 完成证据覆盖"]',
    )?.value).toBe('');
  });

  it('clears one coverage judgment without deleting the other existing judgment', async () => {
    const session = { document: documentFixture(), projection: projectionFixture() };
    session.document.record.focusEvidenceCoverage = [{
      focusIndex: 0,
      expectedOutcomeCovered: true,
      expectedEvidenceCovered: false,
    }];
    const saveAttribution = vi.fn(async () => undefined);
    const modal = new WeeklyFocusReviewModal({} as never, {
      week: '2026-W33',
      load: vi.fn(async () => session),
      saveAttribution,
      saveReview: vi.fn(async () => undefined),
      canManageVault: () => true,
    });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    selectValue(modal, '重点 1 预期结果覆盖', '');
    click(modal, '保存任务归属');

    await vi.waitFor(() => expect(saveAttribution).toHaveBeenCalledWith(expect.objectContaining({
      focusEvidenceCoverage: [{
        focusIndex: 0,
        expectedEvidenceCovered: false,
      }],
    })));
    expect(modal.contentEl.querySelector<HTMLSelectElement>(
      '[aria-label="重点 1 完成证据覆盖"]',
    )?.value).toBe('uncovered');
  });

  it('retains every field when optimistic concurrency rejects the save', async () => {
    const conflict = Object.assign(new Error('conflict'), { code: 'weekly_focus_conflict' });
    const saveReview = vi.fn(async () => { throw conflict; });
    const { modal } = setup(saveReview);
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    selectValue(modal, '重点 1 用户判断', '部分完成');
    setValue(modal, '重点 1 实际结果', '人工输入不能丢。');
    selectValue(modal, '重点 2 用户判断', '未完成');
    setValue(modal, '重点 2 实际结果', '第二项输入也要保留。');
    setValue(modal, '本周总体结果', '存在并发编辑。');
    setValue(modal, '价值判断', '仍需人工判断。');
    setValue(modal, '被验证或推翻的假设', '尚未验证。');
    selectValue(modal, '下周动作', '继续');
    selectValue(modal, '重点 1 预期结果覆盖', 'covered');
    click(modal, '保存复盘');

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('当前输入已保留'));
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      '[aria-label="重点 1 实际结果"]',
    )?.value).toBe('人工输入不能丢。');
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      '[aria-label="本周总体结果"]',
    )?.value).toBe('存在并发编辑。');
    expect(modal.contentEl.querySelector<HTMLSelectElement>(
      '[aria-label="重点 1 预期结果覆盖"]',
    )?.value).toBe('covered');
    expect(modal.contentEl.querySelector<HTMLSelectElement>(
      '[aria-label="重点 1 完成证据覆盖"]',
    )?.value).toBe('');
    expect(modal.contentEl.textContent).toContain('重新载入');
  });

  it('uses the saved document as the optimistic concurrency baseline for later edits', async () => {
    const firstSaved = documentFixture();
    firstSaved.raw = 'synthetic saved weekly focus';
    firstSaved.record.reviewStatus = '已复盘';
    firstSaved.record.reviewedAt = '2026-08-16T20:00:00+08:00';
    const saveReview = vi.fn()
      .mockResolvedValueOnce(firstSaved)
      .mockResolvedValueOnce(firstSaved);
    const { modal } = setup(saveReview);
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    selectValue(modal, '重点 1 用户判断', '已完成');
    setValue(modal, '重点 1 实际结果', '已交付。');
    selectValue(modal, '重点 2 用户判断', '已取消');
    setValue(modal, '重点 2 实际结果', '不再继续。');
    setValue(modal, '本周总体结果', '完成并收敛。');
    setValue(modal, '价值判断', '结果有价值。');
    setValue(modal, '被验证或推翻的假设', '验证交付路径。');
    selectValue(modal, '下周动作', '继续');

    click(modal, '保存复盘');
    await vi.waitFor(() => expect(saveReview).toHaveBeenCalledTimes(1));
    click(modal, '保存复盘');
    await vi.waitFor(() => expect(saveReview).toHaveBeenCalledTimes(2));

    expect(saveReview.mock.calls[1]?.[0].document.raw).toBe('synthetic saved weekly focus');
  });

  it('refreshes projected facts after saving attribution without losing review input', async () => {
    const initial = { document: documentFixture(), projection: projectionFixture() };
    const savedDocument = documentFixture();
    savedDocument.raw = 'synthetic attribution saved';
    savedDocument.record.taskAttributions = [
      { focusIndex: 0, taskIds: ['task-done'] },
      { focusIndex: 1, taskIds: ['task-unassigned'] },
    ];
    const refreshedProjection = projectionFixture();
    const secondFocus = refreshedProjection.focuses[1];
    if (secondFocus === undefined) throw new Error('expected a second synthetic focus');
    secondFocus.facts.tasks = [{
      layer: 'fact',
      taskId: 'task-unassigned',
      title: '映射后任务',
      status: 'ready',
      updatedAt: '2026-08-15T09:00:00+08:00',
      sourceDate: '2026-08-10',
      sourceRef: 'fixtures/mapped.md',
      sourceKey: 'synthetic:task-unassigned',
      blocker: null,
    }];
    const refreshed = { document: savedDocument, projection: refreshedProjection };
    const load = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const saveAttribution = vi.fn(async () => savedDocument);
    const modal = new WeeklyFocusReviewModal({} as never, {
      week: '2026-W33',
      load,
      saveAttribution,
      saveReview: vi.fn(async () => undefined),
      canManageVault: () => true,
    });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('交付可验收结果'));

    setValue(modal, '本周总体结果', '这段人工输入必须保留。');
    selectValue(modal, 'task-unassigned 的归属', 'focus:1');
    click(modal, '保存任务归属');

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(modal.contentEl.textContent).toContain('映射后任务');
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      '[aria-label="本周总体结果"]',
    )?.value).toBe('这段人工输入必须保留。');
  });
});
