import { Modal } from 'obsidian';

import type {
  WeeklyFocusProgressItem,
  WeeklyFocusProgressProjection,
} from '../services/query-weekly-focus-review.js';
import type {
  WeeklyFocusDocument,
  WeeklyFocusItemReview,
  WeeklyFocusReviewOutcome,
  WeeklyFocusNextWeekAction,
} from '../services/weekly-focus.js';
import type {
  WeeklyFocusAttributionInput,
  WeeklyFocusReviewInput,
} from '../services/weekly-focus-review.js';

export interface WeeklyFocusReviewSession {
  document: WeeklyFocusDocument;
  projection: WeeklyFocusProgressProjection;
}

export interface WeeklyFocusReviewModalDependencies {
  week: string;
  load: () => Promise<WeeklyFocusReviewSession>;
  saveAttribution?: (input: WeeklyFocusAttributionInput) => Promise<WeeklyFocusDocument | void>;
  saveReview: (input: WeeklyFocusReviewInput) => Promise<WeeklyFocusDocument | void>;
  canManageVault: () => boolean;
  onChanged?: () => void;
}

type Assignment = '' | 'ignore' | `focus:${number}`;
type CoverageSelection = '' | 'covered' | 'uncovered';

interface FormState {
  taskAssignments: Map<string, Assignment>;
  weeklyEvidenceAssignments: Map<string, Assignment>;
  focusEvidenceCoverage: Map<number, {
    expectedOutcomeCovered?: boolean;
    expectedEvidenceCovered?: boolean;
  }>;
  focusReviews: Array<{
    outcome: WeeklyFocusReviewOutcome | '';
    actualResult: string;
    evidenceGapNote: string;
  }>;
  overallResult: string;
  valueJudgment: string;
  hypothesisOutcome: string;
  nextWeekAction: WeeklyFocusNextWeekAction | '';
}

const OUTCOMES: WeeklyFocusReviewOutcome[] = [
  '已完成',
  '部分完成',
  '未完成',
  '已调整',
  '已取消',
];

const ACTIONS: WeeklyFocusNextWeekAction[] = ['继续', '调整', '停止'];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function initialForm(session: WeeklyFocusReviewSession): FormState {
  const taskAssignments = new Map<string, Assignment>();
  const byTask = new Map<string, number>();
  for (const attribution of session.document.record.taskAttributions ?? []) {
    for (const taskId of attribution.taskIds) byTask.set(taskId, attribution.focusIndex);
  }
  const ignored = new Set(session.document.record.ignoredLinkedTasks ?? []);
  for (const taskId of session.document.record.linkedTasks) {
    const focusIndex = byTask.get(taskId);
    taskAssignments.set(
      taskId,
      focusIndex === undefined ? (ignored.has(taskId) ? 'ignore' : '') : `focus:${focusIndex}`,
    );
  }
  const weeklyEvidenceAssignments = new Map<string, Assignment>();
  for (const evidence of session.projection.weeklyEvidence) {
    weeklyEvidenceAssignments.set(
      evidence.sourceKey,
      evidence.assignment.kind === 'focus'
        ? `focus:${evidence.assignment.focusIndex}`
        : evidence.assignment.kind === 'ignored' ? 'ignore' : '',
    );
  }
  const focusEvidenceCoverage = new Map(
    (session.document.record.focusEvidenceCoverage ?? []).map((item) => [
      item.focusIndex,
      {
        ...(item.expectedOutcomeCovered === undefined
          ? {}
          : { expectedOutcomeCovered: item.expectedOutcomeCovered }),
        ...(item.expectedEvidenceCovered === undefined
          ? {}
          : { expectedEvidenceCovered: item.expectedEvidenceCovered }),
      },
    ]),
  );
  const existing = new Map(
    (session.document.record.review?.focusReviews ?? [])
      .map((review) => [review.focusIndex, review]),
  );
  const focusReviews = session.document.record.input.focuses.map((_, focusIndex): FormState['focusReviews'][number] => {
    const review = existing.get(focusIndex);
    return {
      outcome: review?.outcome ?? '',
      actualResult: review?.actualResult ?? '',
      evidenceGapNote: review?.evidenceGapNote ?? '',
    };
  });
  const review = session.document.record.review;
  return {
    taskAssignments,
    weeklyEvidenceAssignments,
    focusEvidenceCoverage,
    focusReviews,
    overallResult: review?.overallResult ?? '',
    valueJudgment: review?.valueJudgment ?? '',
    hypothesisOutcome: review?.hypothesisOutcome ?? '',
    nextWeekAction: review?.nextWeekAction ?? '',
  };
}

export class WeeklyFocusReviewModal extends Modal {
  private session: WeeklyFocusReviewSession | null = null;
  private form: FormState | null = null;
  private loading = true;
  private saving = false;
  private error = '';
  private savedMessage = '';

  constructor(
    app: unknown,
    private readonly dependencies: WeeklyFocusReviewModalDependencies,
  ) {
    super(app as never);
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-weekly-focus-review-modal');
    this.render();
    void this.loadSession();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async loadSession(): Promise<void> {
    this.loading = true;
    try {
      this.session = await this.dependencies.load();
      this.form = initialForm(this.session);
      this.error = '';
    } catch {
      this.error = '本周重点读取失败，请稍后重试。';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `${this.dependencies.week} 周重点复盘` });
    this.contentEl.createEl('p', {
      cls: 'atl-weekly-focus-review-intro',
      text: '先查看来源事实，再记录系统建议之外的用户判断。任务数量和周报完整性不能证明重点已完成。',
    });
    if (this.loading) {
      this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-empty', text: '正在读取本周事实…' });
      return;
    }
    if (this.session === null || this.form === null) {
      this.contentEl.createDiv({ cls: 'atl-form-error atl-form-error-summary', text: this.error });
      return;
    }
    if (this.error !== '') {
      const error = this.contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary atl-weekly-focus-review-error',
        text: this.error,
      });
      if (error.textContent?.includes('当前输入已保留')) {
        const reload = element('button', undefined, '重新载入');
        reload.type = 'button';
        reload.addEventListener('click', () => void this.loadSession());
        error.append(' ', reload);
      }
    }
    if (this.savedMessage !== '') {
      this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-saved', text: this.savedMessage });
    }
    this.renderCompleteness();
    this.renderAssignments();
    this.renderWeeklyEvidenceAssignments();
    this.renderFocuses();
    this.renderRecordJudgment();
    this.renderActions();
  }

  private renderCompleteness(): void {
    const projection = this.session?.projection;
    if (projection === undefined) return;
    const section = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-integrity' });
    section.createEl('strong', { text: '周报数据完整性' });
    const report = projection.reportDataCompleteness;
    section.createEl('span', {
      text: report === null ? '本周尚无周报聚合' : `${report.value} · ${report.detail}`,
    });
    if (projection.unassignedEvidence.length > 0) {
      section.createEl('small', {
        text: `待归属周报事实 ${projection.unassignedEvidence.length} 项：先关联到重点或明确忽略。`,
      });
    }
    if (projection.readFailures.length > 0) {
      section.createEl('small', {
        text: '部分来源读取失败：重试读取并保留当前人工判断。',
      });
    }
  }

  private renderAssignments(): void {
    const document = this.session?.document;
    const form = this.form;
    if (document === undefined || form === null || document.record.linkedTasks.length === 0) return;
    const section = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-assignments' });
    section.createEl('h3', { text: '周级关联任务' });
    section.createEl('p', {
      cls: 'atl-weekly-focus-review-help',
      text: '旧记录只有周级任务时，逐项选择重点、忽略，或保留为尚未逐项归属；原始关联任务不会被删除。',
    });
    for (const taskId of document.record.linkedTasks) {
      const row = section.createDiv({ cls: 'atl-weekly-focus-review-assignment-row' });
      row.createEl('span', {
        cls: 'atl-weekly-focus-review-assignment-id',
        text: taskId,
      });
      const select = row.createEl('select', {
        attr: { 'aria-label': `${taskId} 的归属` },
      });
      select.append(new Option('尚未逐项归属', ''));
      document.record.input.focuses.forEach((focus, index) => {
        select.append(new Option(`重点 ${index + 1}：${focus.focus}`, `focus:${index}`));
      });
      select.append(new Option('明确忽略', 'ignore'));
      select.value = form.taskAssignments.get(taskId) ?? '';
      select.addEventListener('change', () => {
        form.taskAssignments.set(taskId, select.value as Assignment);
      });
      row.append(select);
    }
  }

  private renderWeeklyEvidenceAssignments(): void {
    const session = this.session;
    const form = this.form;
    if (session === null || form === null || session.projection.weeklyEvidence.length === 0) return;
    const section = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-assignments' });
    section.createEl('h3', { text: '周报来源事实' });
    section.createEl('p', {
      cls: 'atl-weekly-focus-review-help',
      text: '逐项关联到重点、明确忽略，或保留为待归属；周度记录原正文不会被删除。',
    });
    for (const evidence of session.projection.weeklyEvidence) {
      const row = section.createDiv({ cls: 'atl-weekly-focus-review-assignment-row' });
      const detail = row.createDiv({ cls: 'atl-weekly-focus-review-assignment-detail' });
      detail.createEl('span', { text: evidence.topic });
      detail.createEl('small', {
        text: `来源时间：${evidence.sourceUpdatedAt} · 来源：${
          evidence.sourceRefs.length === 0 ? '无来源' : evidence.sourceRefs.join('、')
        }`,
      });
      const select = row.createEl('select', {
        attr: { 'aria-label': `周报证据 ${evidence.sourceKey} 的归属` },
      });
      select.append(new Option('待归属', ''));
      session.document.record.input.focuses.forEach((focus, index) => {
        select.append(new Option(`重点 ${index + 1}：${focus.focus}`, `focus:${index}`));
      });
      select.append(new Option('明确忽略', 'ignore'));
      select.value = form.weeklyEvidenceAssignments.get(evidence.sourceKey) ?? '';
      select.addEventListener('change', () => {
        form.weeklyEvidenceAssignments.set(evidence.sourceKey, select.value as Assignment);
      });
    }
  }

  private renderFocuses(): void {
    const session = this.session;
    const form = this.form;
    if (session === null || form === null) return;
    const section = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-focuses' });
    section.createEl('h3', { text: '逐项重点' });
    session.projection.focuses.forEach((item, index) => this.renderFocus(section, item, index));
  }

  private renderFocus(section: HTMLElement, item: WeeklyFocusProgressItem, index: number): void {
    const form = this.form;
    if (form === null) return;
    const review = form.focusReviews[index];
    if (review === undefined) return;
    const card = section.createDiv({ cls: 'atl-weekly-focus-review-focus-card' });
    const heading = card.createDiv({ cls: 'atl-weekly-focus-review-focus-heading' });
    heading.createEl('span', { text: `重点 ${index + 1}` });
    heading.createEl('strong', { text: item.focus });
    const expectations = card.createDiv({ cls: 'atl-weekly-focus-review-expectations' });
    expectations.createEl('span', { text: `预期结果：${item.expectedOutcome}` });
    expectations.createEl('span', { text: `完成证据：${item.expectedEvidence}` });
    this.coverageControl(expectations, index, 'expectedOutcomeCovered', '预期结果覆盖');
    this.coverageControl(expectations, index, 'expectedEvidenceCovered', '完成证据覆盖');
    const facts = card.createDiv({ cls: 'atl-weekly-focus-review-facts' });
    facts.createEl('strong', { text: '来源事实' });
    facts.createEl('span', { text: `任务 ${item.facts.tasks.length} 项 · 完成事实 ${item.facts.completions.length} 项` });
    facts.createEl('span', { text: `Artifact ${item.facts.artifacts.length} 项 · 验收 ${this.acceptanceLabel(item)}` });
    for (const task of item.facts.tasks) {
      facts.createEl('small', { text: `${task.title} · 状态：${task.status}` });
      facts.createEl('small', { text: `任务事实更新时间：${task.updatedAt}` });
      facts.createEl('small', {
        text: `来源日期：${task.sourceDate ?? '未提供'} · 来源：${
          task.sourceRef ?? (task.sourceKey === '' ? '无来源' : task.sourceKey)
        } · 来源键：${task.sourceKey === '' ? '无来源键' : task.sourceKey}`,
      });
      if (task.blocker !== null) {
        facts.createEl('small', { text: `阻塞：${task.blocker}` });
      }
    }
    for (const completion of item.facts.completions) {
      facts.createEl('small', {
        text: `完成事实：${completion.taskId} · ${completion.completedAt} · ${completion.source}`,
      });
    }
    for (const artifact of item.facts.artifacts) {
      facts.createEl('small', {
        text: `Artifact：${artifact.ref} · ${artifact.status}${
          artifact.summary === null ? '' : ` · ${artifact.summary}`
        }`,
      });
    }
    for (const acceptance of item.facts.acceptances) {
      facts.createEl('small', {
        text: `验收：${acceptance.taskId} · ${acceptance.status} · ${acceptance.detail}`,
      });
    }
    if (item.gaps.length > 0) {
      const gaps = card.createDiv({ cls: 'atl-weekly-focus-review-gaps' });
      gaps.createEl('strong', { text: '待补齐动作' });
      item.gaps.forEach((gap) => gaps.createEl('span', { text: `${gap.message} → ${gap.action}` }));
    }
    const suggestion = card.createDiv({ cls: 'atl-weekly-focus-review-suggestion' });
    suggestion.createEl('strong', { text: '系统建议' });
    suggestion.createEl('span', { text: item.suggestion.label });
    suggestion.createEl('small', { text: item.suggestion.reasons.join('；') });

    const judgment = card.createDiv({ cls: 'atl-weekly-focus-review-judgment' });
    judgment.createEl('strong', { text: '用户判断' });
    const select = judgment.createEl('select', {
      attr: { 'aria-label': `重点 ${index + 1} 用户判断` },
    });
    select.append(new Option('请选择', ''));
    OUTCOMES.forEach((outcome) => select.append(new Option(outcome, outcome)));
    select.value = review.outcome;
    select.addEventListener('change', () => {
      review.outcome = select.value as WeeklyFocusReviewOutcome | '';
    });
    this.textControl(judgment, '实际结果', review.actualResult, (value) => {
      review.actualResult = value;
    }, false, `重点 ${index + 1} 实际结果`);
    this.textControl(judgment, '证据不足说明', review.evidenceGapNote, (value) => {
      review.evidenceGapNote = value;
    }, true, `重点 ${index + 1} 证据不足说明`);
  }

  private coverageControl(
    parent: HTMLElement,
    focusIndex: number,
    field: 'expectedOutcomeCovered' | 'expectedEvidenceCovered',
    label: string,
  ): void {
    const form = this.form;
    if (form === null) return;
    const wrapper = parent.createEl('label', { cls: 'atl-weekly-focus-review-field' });
    wrapper.createEl('span', { text: label });
    const select = wrapper.createEl('select', {
      attr: { 'aria-label': `重点 ${focusIndex + 1} ${label}` },
    });
    select.append(new Option('未确认', ''));
    select.append(new Option('已有明确事实支持', 'covered'));
    select.append(new Option('尚无明确事实支持', 'uncovered'));
    const coverage = form.focusEvidenceCoverage.get(focusIndex);
    select.value = coverage?.[field] === undefined
      ? ''
      : coverage[field] ? 'covered' : 'uncovered';
    select.addEventListener('change', () => {
      const value = select.value as CoverageSelection;
      const current = { ...(form.focusEvidenceCoverage.get(focusIndex) ?? {}) };
      if (value === '') {
        delete current[field];
        if (
          current.expectedOutcomeCovered === undefined
          && current.expectedEvidenceCovered === undefined
        ) {
          form.focusEvidenceCoverage.delete(focusIndex);
        } else {
          form.focusEvidenceCoverage.set(focusIndex, current);
        }
        return;
      }
      current[field] = value === 'covered';
      form.focusEvidenceCoverage.set(focusIndex, current);
    });
  }

  private acceptanceLabel(item: WeeklyFocusProgressItem): string {
    if (item.facts.acceptances.length === 0) return '暂无';
    return item.facts.acceptances.map(({ status }) => status).join('、');
  }

  private textControl(
    parent: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    optional = false,
    ariaLabel = label,
  ): void {
    const wrapper = parent.createEl('label', { cls: 'atl-weekly-focus-review-field' });
    wrapper.createEl('span', { text: optional ? `${label}（可选）` : label });
    const input = wrapper.createEl('input', {
      type: 'text',
      attr: { 'aria-label': ariaLabel },
    });
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
  }

  private renderRecordJudgment(): void {
    const form = this.form;
    if (form === null) return;
    const section = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-record' });
    section.createEl('h3', { text: '记录级判断' });
    this.textControl(section, '本周总体结果', form.overallResult, (value) => {
      form.overallResult = value;
    });
    this.textControl(section, '价值判断', form.valueJudgment, (value) => {
      form.valueJudgment = value;
    });
    this.textControl(section, '被验证或推翻的假设', form.hypothesisOutcome, (value) => {
      form.hypothesisOutcome = value;
    });
    const action = section.createEl('label', { cls: 'atl-weekly-focus-review-field' });
    action.createEl('span', { text: '下周动作' });
    const select = action.createEl('select', { attr: { 'aria-label': '下周动作' } });
    select.append(new Option('请选择', ''));
    ACTIONS.forEach((value) => select.append(new Option(value, value)));
    select.value = form.nextWeekAction;
    select.addEventListener('change', () => {
      form.nextWeekAction = select.value as WeeklyFocusNextWeekAction | '';
    });
  }

  private renderActions(): void {
    const actions = this.contentEl.createDiv({ cls: 'atl-weekly-focus-review-actions' });
    if (this.dependencies.saveAttribution !== undefined) {
      const attribution = actions.createEl('button', {
        text: this.saving ? '正在保存…' : '保存任务归属',
      });
      attribution.type = 'button';
      attribution.disabled = this.saving;
      attribution.addEventListener('click', () => void this.submitAttribution());
    }
    const save = actions.createEl('button', { text: this.saving ? '正在保存…' : '保存复盘' });
    save.type = 'button';
    save.disabled = this.saving;
    save.addEventListener('click', () => void this.submit());
    const cancel = actions.createEl('button', { text: '关闭' });
    cancel.type = 'button';
    cancel.disabled = this.saving;
    cancel.addEventListener('click', () => this.close());
  }

  private attributionInput(): Pick<
  WeeklyFocusReviewInput,
  | 'document'
  | 'taskAttributions'
  | 'ignoredLinkedTasks'
  | 'focusEvidenceCoverage'
  | 'weeklyEvidenceAttributions'
  | 'ignoredWeeklyEvidence'
  > | null {
    if (this.session === null || this.form === null) return null;
    const taskAttributions = this.session.document.record.input.focuses.map((_, focusIndex) => ({
      focusIndex,
      taskIds: [...this.form!.taskAssignments.entries()]
        .filter(([, assignment]) => assignment === `focus:${focusIndex}`)
        .map(([taskId]) => taskId),
    })).filter(({ taskIds }) => taskIds.length > 0);
    const ignoredLinkedTasks = [...this.form.taskAssignments.entries()]
      .filter(([, assignment]) => assignment === 'ignore')
      .map(([taskId]) => taskId);
    const weeklyEvidenceAttributions = this.session.document.record.input.focuses
      .map((_, focusIndex) => ({
        focusIndex,
        sourceKeys: [...this.form!.weeklyEvidenceAssignments.entries()]
          .filter(([, assignment]) => assignment === `focus:${focusIndex}`)
          .map(([sourceKey]) => sourceKey),
      }))
      .filter(({ sourceKeys }) => sourceKeys.length > 0);
    const ignoredWeeklyEvidence = [...this.form.weeklyEvidenceAssignments.entries()]
      .filter(([, assignment]) => assignment === 'ignore')
      .map(([sourceKey]) => sourceKey);
    const focusEvidenceCoverage = [...this.form.focusEvidenceCoverage.entries()]
      .map(([focusIndex, coverage]) => ({ focusIndex, ...coverage }))
      .sort((left, right) => left.focusIndex - right.focusIndex);
    return {
      document: this.session.document,
      taskAttributions,
      ignoredLinkedTasks,
      focusEvidenceCoverage,
      weeklyEvidenceAttributions,
      ignoredWeeklyEvidence,
    };
  }

  private async submitAttribution(): Promise<void> {
    const input = this.attributionInput();
    const save = this.dependencies.saveAttribution;
    if (this.saving || input === null || save === undefined) return;
    if (!this.dependencies.canManageVault()) {
      this.error = '请先允许 ATL 管理此 Vault；当前输入已保留。';
      this.render();
      return;
    }
    this.saving = true;
    this.error = '';
    this.savedMessage = '';
    this.render();
    try {
      const saved = await save(input);
      if (saved !== undefined && this.session !== null) this.session.document = saved;
      try {
        this.session = await this.dependencies.load();
        this.savedMessage = '任务归属已保存，事实已刷新；复盘仍为待复盘。';
      } catch {
        this.savedMessage = '任务归属已保存，复盘仍为待复盘。';
        this.error = '事实刷新失败，当前输入已保留；重新打开可再次读取。';
      }
      this.dependencies.onChanged?.();
    } catch (error) {
      this.error = errorCode(error) === 'weekly_focus_conflict'
        ? '检测到并发修改，当前输入已保留。请重新载入后再决定是否覆盖。'
        : '任务归属保存失败，当前输入已保留。';
    } finally {
      this.saving = false;
      this.render();
    }
  }

  private async submit(): Promise<void> {
    if (this.saving || this.session === null || this.form === null) return;
    if (!this.dependencies.canManageVault()) {
      this.error = '请先允许 ATL 管理此 Vault；当前输入已保留。';
      this.render();
      return;
    }
    const missing = this.form.focusReviews.some((review) => (
      review.outcome === '' || review.actualResult.trim() === ''
    ));
    if (
      missing
      || this.form.overallResult.trim() === ''
      || this.form.valueJudgment.trim() === ''
      || this.form.hypothesisOutcome.trim() === ''
      || this.form.nextWeekAction === ''
    ) {
      this.error = '请逐项填写用户判断、实际结果和记录级判断。';
      this.render();
      return;
    }
    const attribution = this.attributionInput();
    if (attribution === null) return;
    const focusReviews: WeeklyFocusItemReview[] = this.form.focusReviews.map((review, focusIndex) => ({
      focusIndex,
      outcome: review.outcome as WeeklyFocusReviewOutcome,
      actualResult: review.actualResult,
      evidenceGapNote: review.evidenceGapNote,
    }));
    const input: WeeklyFocusReviewInput = {
      document: this.session.document,
      taskAttributions: attribution.taskAttributions,
      ignoredLinkedTasks: attribution.ignoredLinkedTasks,
      focusEvidenceCoverage: attribution.focusEvidenceCoverage ?? [],
      weeklyEvidenceAttributions: attribution.weeklyEvidenceAttributions ?? [],
      ignoredWeeklyEvidence: attribution.ignoredWeeklyEvidence ?? [],
      focusReviews,
      overallResult: this.form.overallResult,
      valueJudgment: this.form.valueJudgment,
      hypothesisOutcome: this.form.hypothesisOutcome,
      nextWeekAction: this.form.nextWeekAction as WeeklyFocusNextWeekAction,
    };
    this.saving = true;
    this.error = '';
    this.savedMessage = '';
    this.render();
    try {
      const saved = await this.dependencies.saveReview(input);
      if (saved !== undefined && this.session !== null) this.session.document = saved;
      this.savedMessage = '已保存：复盘状态已更新为已复盘，可继续修订。';
      this.dependencies.onChanged?.();
    } catch (error) {
      if (errorCode(error) === 'weekly_focus_conflict') {
        this.error = '检测到并发修改，当前输入已保留。请重新载入后再决定是否覆盖。';
      } else {
        this.error = '保存失败，当前输入已保留。';
      }
    } finally {
      this.saving = false;
      this.render();
    }
  }
}
