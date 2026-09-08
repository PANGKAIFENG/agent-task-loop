import {
  App,
  Modal,
  Notice,
  Setting,
} from 'obsidian';

import {
  type CandidateField,
  type CandidateUnderstanding,
} from '../domain/candidate-understanding.js';
import {
  sourceActionsFor,
  type CandidateInspectorProjection,
} from '../services/candidate-inspector-projection.js';
import { InvalidTaskBriefInputError } from '../services/save-task-brief.js';
import {
  type PreparedTaskBrief,
  type TaskBriefSaver,
} from './task-brief-controller.js';
import type {
  TaskBriefDraft,
  TaskBriefGenerationInput,
} from './task-brief-generation.js';

const CANDIDATE_FIELD_LABELS: Record<CandidateField, string> = {
  title: '任务标题',
  objective: '任务目标',
  next_action: '下一步动作',
  expected_artifact: '预期 Artifact',
  completion_criteria: '完成条件',
};

const ATTRIBUTION_LABELS = {
  source_fact: '来源事实',
  ai_inference: 'AI 推断',
  missing: '信息缺失',
} as const;

const SOURCE_STATUS_LABELS = {
  available: '可用',
  moved: '已移动',
  changed: '内容已变化',
  unavailable: '暂不可用',
  missing: '缺失',
} as const;

function saveErrorMessage(error: unknown): string {
  if (error instanceof InvalidTaskBriefInputError) return error.message;
  if (error instanceof Error) {
    const coded = error as Error & { code?: string };
    if (coded.code === 'task_conflict') {
      return '任务刚刚被其他操作修改，请关闭后重新打开';
    }
    if (coded.code === 'task_not_found') {
      return '任务已经不存在，请关闭后刷新';
    }
    if (coded.code === 'candidate_understanding_blocked') {
      return '仍有阻断缺口，任务未变化；请补充后再确认';
    }
  }
  return '任务简报保存失败，原任务没有被移动，请重试';
}

function isSavedWithStaleIndex(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'task_saved_index_stale';
}

export class TaskBriefModal extends Modal {
  private title: string;
  private objective: string;
  private nextAction: string;
  private expectedArtifact: string;
  private completionCriteria: string;
  private candidateInspector: CandidateInspectorProjection | undefined;
  private candidateUnderstanding: CandidateUnderstanding | undefined;
  private candidateMessage = '';
  private generating = false;
  private saving = false;
  private saved = false;
  private indexStale = false;
  private error = '';
  private closed = false;

  constructor(
    app: App,
    private readonly controller: TaskBriefSaver,
    private readonly prepared: PreparedTaskBrief,
    private readonly generate?: (
      input: TaskBriefGenerationInput,
    ) => Promise<TaskBriefDraft | CandidateUnderstanding>,
  ) {
    super(app);
    this.candidateInspector = prepared.candidateInspector;
    this.candidateUnderstanding = prepared.candidateUnderstanding;
    this.title = this.candidateValue('title') ?? prepared.task.title;
    this.objective = this.candidateValue('objective') ?? prepared.task.taskBrief?.objective ?? '';
    this.nextAction = this.candidateValue('next_action') ?? prepared.task.taskBrief?.nextAction ?? '';
    this.expectedArtifact = this.candidateValue('expected_artifact') ?? '';
    this.completionCriteria = this.candidateValue('completion_criteria')
      ?? prepared.task.taskBrief?.completionCriteria
      ?? '';
  }

  override onOpen(): void {
    this.closed = false;
    this.modalEl.addClass('atl-task-brief-modal');
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '智能完善任务' });
    this.contentEl.createDiv({
      cls: 'atl-task-title',
      text: this.prepared.task.title,
    });
    this.contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: '基于已有信息智能梳理任务上下文，并通过对话与你共同补全目标、行动步骤和完成标准。',
    });

    if (this.saved) {
      this.renderSaved();
      return;
    }

    this.renderContextSummary();
    if (this.error !== '') {
      this.contentEl.createDiv({
        cls: 'atl-task-brief-banner is-error',
        text: this.error,
      });
    }
    if (this.candidateMessage !== '') {
      this.contentEl.createDiv({
        cls: 'atl-task-brief-banner is-success',
        text: this.candidateMessage,
      });
    }
    this.renderGeneration();
    if (this.isCandidateMode()) {
      this.renderCandidateFields();
      this.renderCandidateSources();
      this.renderCandidateGaps();
      this.renderCandidateAdmission();
      this.renderCandidateActions();
    } else {
      this.renderBriefFields();
      this.renderActions();
    }
  }

  private candidateValue(field: CandidateField): string | null {
    return this.candidateInspector?.suggestions
      .find((suggestion) => suggestion.field === field)?.suggestedValue ?? null;
  }

  private isCandidateMode(): boolean {
    return this.candidateInspector !== undefined
      && this.candidateUnderstanding !== undefined
      && this.controller.saveCandidate !== undefined;
  }

  private renderContextSummary(): void {
    const context = this.contentEl.createDiv({ cls: 'atl-task-brief-context' });
    context.createEl('strong', { text: '本次读取' });
    context.createEl('span', {
      text: this.prepared.project === null
        ? '任务标题与正文'
        : `任务标题、正文与项目「${this.prepared.project.name}」`,
    });
  }

  private renderGeneration(): void {
    if (this.generate === undefined) return;
    new Setting(this.contentEl)
      .setName('智能生成建议')
      .setDesc('系统基于当前信息生成建议；信息不足时由你补充，确认后再保存。')
      .addButton((button) => button
        .setButtonText(this.generating ? '正在智能完善...' : '开始智能完善')
        .setDisabled(this.generating || this.saving)
        .onClick(() => this.runGeneration()));
  }

  private renderBriefFields(): void {
    const section = this.contentEl.createDiv({ cls: 'atl-task-brief-fields' });
    section.createDiv({ cls: 'atl-task-brief-section-title', text: '智能建议' });
    section.createDiv({
      cls: 'atl-task-brief-section-note',
      text: '以下建议都可以人工修改；模型不可用时也能直接填写。',
    });
    this.renderTextArea(section, {
      label: '任务目标',
      description: '这项任务最终要解决什么或得到什么',
      placeholder: '例如：明确一期任务面板需要保留的核心字段',
      value: this.objective,
      rows: 3,
      onChange: (value) => { this.objective = value; },
    });
    this.renderTextArea(section, {
      label: '下一步动作',
      description: '现在可以开始做的一个明确动作',
      placeholder: '例如：逐项对照现有字段并给出保留或隐藏建议',
      value: this.nextAction,
      rows: 3,
      onChange: (value) => { this.nextAction = value; },
    });
    this.renderTextArea(section, {
      label: '完成条件',
      description: '满足什么条件时可以判断任务已完成',
      placeholder: '例如：形成一份可评审的字段清单',
      value: this.completionCriteria,
      rows: 3,
      onChange: (value) => { this.completionCriteria = value; },
    });
  }

  private candidateValues(): Record<CandidateField, string> {
    return {
      title: this.title,
      objective: this.objective,
      next_action: this.nextAction,
      expected_artifact: this.expectedArtifact,
      completion_criteria: this.completionCriteria,
    };
  }

  private setCandidateValue(field: CandidateField, value: string): void {
    if (field === 'title') this.title = value;
    if (field === 'objective') this.objective = value;
    if (field === 'next_action') this.nextAction = value;
    if (field === 'expected_artifact') this.expectedArtifact = value;
    if (field === 'completion_criteria') this.completionCriteria = value;
  }

  private renderCandidateFields(): void {
    const projection = this.candidateInspector;
    if (projection === undefined) return;
    const section = this.contentEl.createDiv({ cls: 'atl-task-brief-fields atl-candidate-fields' });
    section.createDiv({ cls: 'atl-task-brief-section-title', text: '候选理解' });
    section.createDiv({
      cls: 'atl-task-brief-section-note',
      text: '所有字段均可人工编辑；确认只保存新 revision，不授权 Agent。',
    });
    const values = this.candidateValues();
    for (const suggestion of projection.suggestions) {
      const field = section.createDiv({ cls: 'atl-candidate-field' });
      const original = suggestion.suggestedValue;
      const label = CANDIDATE_FIELD_LABELS[suggestion.field];
      let reset: HTMLButtonElement | null = null;
      new Setting(field)
        .setName(label)
        .setDesc(suggestion.reason)
        .addTextArea((text) => {
          text.inputEl.rows = suggestion.field === 'title' ? 2 : 3;
          text.inputEl.setAttribute('aria-label', label);
          text.inputEl.disabled = this.generating || this.saving;
          text.setValue(values[suggestion.field]).onChange((value) => {
            this.setCandidateValue(suggestion.field, value);
            if (reset !== null) {
              reset.disabled = value === original || this.generating || this.saving;
            }
          });
        });
      const meta = field.createDiv({ cls: 'atl-candidate-field-meta' });
      meta.createEl('span', {
        cls: `atl-candidate-attribution is-${suggestion.attribution}`,
        text: ATTRIBUTION_LABELS[suggestion.attribution],
      });
      if (suggestion.sourceRefIds.length > 0) {
        meta.createEl('span', { text: `来源：${suggestion.sourceRefIds.join('、')}` });
      }
      reset = meta.createEl('button', {
        cls: 'clickable-icon',
        text: '撤销',
        attr: {
          type: 'button',
          'aria-label': `撤销 ${label} 修改`,
          title: `撤销 ${label} 修改`,
        },
      });
      reset.disabled = values[suggestion.field] === original || this.generating || this.saving;
      reset.addEventListener('click', () => {
        this.setCandidateValue(suggestion.field, original);
        this.render();
      });
    }
  }

  private renderCandidateSources(): void {
    const sources = this.candidateInspector?.sourceRefs ?? [];
    const section = this.contentEl.createDiv({ cls: 'atl-candidate-section' });
    section.createEl('h3', { text: '来源与依据' });
    if (sources.length === 0) {
      section.createEl('p', { cls: 'atl-candidate-empty', text: '当前没有有限来源引用。' });
      return;
    }
    for (const source of sources) {
      const item = section.createDiv({ cls: 'atl-candidate-source' });
      const heading = item.createDiv({ cls: 'atl-candidate-source-heading' });
      heading.createEl('strong', { text: source.sourceNote ?? source.sourceType });
      heading.createEl('span', { text: SOURCE_STATUS_LABELS[source.status] });
      if (source.anchor !== null) item.createEl('p', { text: `定位：${source.anchor}` });
      item.createEl('blockquote', { text: source.quote === '' ? '未保留可显示引用' : source.quote });
      if (source.parentContext !== null) {
        item.createEl('p', { text: `上层上下文：${source.parentContext}` });
      }
      if (source.failureReason !== null) {
        item.createEl('p', { cls: 'atl-candidate-source-failure', text: `失效原因：${source.failureReason}` });
      }
      item.createEl('p', {
        cls: 'atl-candidate-source-verified',
        text: `最近验证：${source.lastVerifiedAt ?? '尚未验证'}${source.lastVerifiedEvidence?.resolvedNote === null || source.lastVerifiedEvidence?.resolvedNote === undefined ? '' : ` · ${source.lastVerifiedEvidence.resolvedNote}`}`,
      });
      const action = this.candidateInspector?.sourceActions.find(
        ({ sourceRefId }) => sourceRefId === source.sourceRefId,
      );
      if (action !== undefined) {
        const button = item.createEl('button', {
          cls: 'atl-candidate-source-action',
          text: action.label,
        });
        button.disabled = this.saving || this.generating || this.controller.openSource === undefined;
        button.addEventListener('click', () => void this.openCandidateSource(source.sourceRefId));
      }
    }
  }

  private async openCandidateSource(sourceRefId: string): Promise<void> {
    const openSource = this.controller.openSource;
    if (openSource === undefined || this.saving || this.generating) return;
    this.error = '';
    try {
      const result = await openSource(this.prepared.task.taskId, sourceRefId);
      this.candidateMessage = result.outcome === 'located'
        ? '已打开原始输入并定位。'
        : `来源仍不可定位：${result.failureReason}。有限引用已保留，请修复路径或补充来源。`;
    } catch {
      this.error = '来源定位失败。有限引用已保留，请稍后重试或补充来源。';
    }
    if (!this.closed) this.render();
  }

  private renderCandidateGaps(): void {
    const gaps = this.candidateInspector?.gaps ?? [];
    const section = this.contentEl.createDiv({ cls: 'atl-candidate-section' });
    section.createEl('h3', { text: '缺口' });
    if (gaps.length === 0) {
      section.createEl('p', { cls: 'atl-candidate-empty', text: '当前没有候选理解缺口。' });
      return;
    }
    const list = section.createEl('ul', { cls: 'atl-candidate-gap-list' });
    for (const gap of gaps) {
      const item = list.createEl('li', { cls: `is-${gap.severity}` });
      item.createEl('strong', { text: gap.severity === 'blocking' ? '阻断' : '可选' });
      item.createEl('span', { text: gap.question });
      item.createEl('code', { text: gap.reasonCode });
    }
  }

  private renderCandidateAdmission(): void {
    const projection = this.candidateInspector;
    if (projection === undefined) return;
    const section = this.contentEl.createDiv({ cls: 'atl-candidate-section atl-candidate-admission' });
    section.createEl('h3', { text: `准入与权限 · ${projection.admission.verdict}` });
    section.createEl('p', {
      cls: 'atl-candidate-authorization-boundary',
      text: '确认任务理解不等于 Agent 授权，也不授予任何外部写权限。',
    });
    const list = section.createEl('ul', { cls: 'atl-candidate-reason-list' });
    for (const reason of projection.admission.reasons) {
      const item = list.createEl('li');
      item.createEl('code', { text: reason.code });
      item.createEl('span', { text: reason.message });
      item.createEl('small', { text: reason.next_action });
    }
    section.createEl('p', {
      cls: 'atl-candidate-permission-summary',
      text: `权限模式：${projection.permissionGate.mode ?? 'unknown'} · 外部写：${projection.permissionGate.external_writes.length} · 已授权：${String(projection.permissionGate.authorized)}`,
    });
  }

  private renderCandidateActions(): void {
    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.saving || this.generating)
      .onClick(() => this.close()));
    actions.addButton((button) => button
      .setButtonText(this.saving ? '正在保存...' : '保存候选草稿')
      .setDisabled(this.saving || this.generating)
      .onClick(() => this.saveCandidate(false)));
    actions.addButton((button) => button
      .setButtonText(this.saving ? '正在确认...' : '确认任务理解')
      .setCta()
      .setDisabled(this.saving || this.generating)
      .onClick(() => this.saveCandidate(true)));
  }

  private renderTextArea(
    container: HTMLElement,
    options: {
      label: string;
      description: string;
      placeholder: string;
      value: string;
      rows: number;
      onChange: (value: string) => void;
    },
  ): void {
    new Setting(container)
      .setName(options.label)
      .setDesc(options.description)
      .addTextArea((text) => {
        text.inputEl.rows = options.rows;
        text.inputEl.setAttribute('aria-label', options.label);
        text.inputEl.disabled = this.generating || this.saving;
        text
          .setPlaceholder(options.placeholder)
          .setValue(options.value)
          .onChange(options.onChange);
      });
  }

  private renderActions(): void {
    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.saving || this.generating)
      .onClick(() => this.close()));
    actions.addButton((button) => {
      button
        .setButtonText(this.saving ? '正在保存...' : '确认并保存')
        .setCta()
        .setDisabled(this.saving || this.generating)
        .onClick(() => this.save());
    });
  }

  private renderSaved(): void {
    this.contentEl.createDiv({
      cls: 'atl-task-brief-banner is-success',
      text: this.indexStale
        ? '任务简报已保存；任务索引暂未刷新，后续任务操作会再次尝试。看板字段均未改变。'
        : '任务简报已保存。看板状态、计划时间、优先级和项目均未改变。',
    });
    const summary = this.contentEl.createDiv({ cls: 'atl-task-brief-summary' });
    this.renderSummaryRow(summary, '目标', this.objective);
    this.renderSummaryRow(summary, '下一步', this.nextAction);
    this.renderSummaryRow(summary, '完成条件', this.completionCriteria);
    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('返回任务')
      .setCta()
      .onClick(() => this.close()));
  }

  private renderSummaryRow(container: HTMLElement, label: string, value: string): void {
    const row = container.createDiv({ cls: 'atl-task-brief-summary-row' });
    row.createEl('strong', { text: label });
    row.createEl('span', { text: value });
  }

  private async runGeneration(): Promise<void> {
    if (this.generate === undefined || this.generating || this.saving) return;
    this.generating = true;
    this.error = '';
    this.render();
    try {
      const draft = await this.generate({
        title: this.prepared.task.title,
        body: this.prepared.task.body,
        project: this.prepared.project === null ? null : {
          name: this.prepared.project.name,
          description: this.prepared.project.description,
        },
      });
      if ('suggestions' in draft) {
        this.candidateUnderstanding = draft;
        if (this.candidateInspector !== undefined) {
          this.candidateInspector = {
            ...this.candidateInspector,
            suggestions: draft.suggestions,
            sourceRefs: draft.sourceRefs,
            sourceActions: sourceActionsFor(draft.sourceRefs),
            gaps: draft.gaps,
          };
        }
        for (const suggestion of draft.suggestions) {
          this.setCandidateValue(suggestion.field, suggestion.suggestedValue);
        }
      } else {
        this.objective = draft.objective;
        this.nextAction = draft.nextAction;
        this.completionCriteria = draft.completionCriteria;
      }
    } catch {
      this.error = 'AI 暂时无法生成任务简报。你可以检查模型配置后重试，或直接人工填写并保存。';
    } finally {
      this.generating = false;
      if (!this.closed) this.render();
    }
  }

  private async saveCandidate(confirm: boolean): Promise<void> {
    const projection = this.candidateInspector;
    const understanding = this.candidateUnderstanding;
    const saveCandidate = this.controller.saveCandidate;
    if (
      projection === undefined
      || understanding === undefined
      || saveCandidate === undefined
      || this.saving
      || this.generating
    ) return;
    this.saving = true;
    this.error = '';
    this.candidateMessage = '';
    this.render();
    try {
      const updated = await saveCandidate.call(
        this.controller,
        this.prepared.task.taskId,
        {
          understanding,
          expectedRevision: projection.taskIdentity.candidateRevision,
          expectedTaskUpdatedAt: projection.taskIdentity.updatedAt,
          confirm,
          values: this.candidateValues(),
        },
      );
      this.candidateInspector = updated;
      this.candidateUnderstanding = {
        schemaVersion: understanding.schemaVersion,
        generationId: updated.suggestions[0]?.generationId ?? understanding.generationId,
        taskType: understanding.taskType,
        suggestions: updated.suggestions,
        sourceRefs: updated.sourceRefs,
        gaps: updated.gaps,
      };
      for (const suggestion of updated.suggestions) {
        this.setCandidateValue(suggestion.field, suggestion.suggestedValue);
      }
      this.candidateMessage = confirm
        ? '任务理解已确认并保存新 revision；Agent 与外部写仍未授权。'
        : '候选草稿已保存新 revision。';
      new Notice(confirm ? '任务理解已确认' : '候选草稿已保存');
    } catch (error) {
      this.error = saveErrorMessage(error);
    } finally {
      this.saving = false;
      if (!this.closed) this.render();
    }
  }

  private async save(): Promise<void> {
    if (this.saving || this.generating) return;
    this.saving = true;
    this.error = '';
    this.render();
    try {
      await this.controller.save(this.prepared.task.taskId, {
        objective: this.objective,
        nextAction: this.nextAction,
        completionCriteria: this.completionCriteria,
      }, this.prepared.task.taskBrief?.updatedAt ?? null);
      this.saved = true;
      new Notice('任务简报已保存');
    } catch (error) {
      if (isSavedWithStaleIndex(error)) {
        this.saved = true;
        this.indexStale = true;
        new Notice('任务简报已保存，任务索引待刷新');
      } else {
        this.error = saveErrorMessage(error);
      }
    } finally {
      this.saving = false;
      if (!this.closed) this.render();
    }
  }
}
