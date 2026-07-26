import {
  App,
  Modal,
  Notice,
  Setting,
} from 'obsidian';

import { InvalidTaskBriefInputError } from '../services/save-task-brief.js';
import {
  TaskBriefController,
  type PreparedTaskBrief,
} from './task-brief-controller.js';
import type {
  TaskBriefDraft,
  TaskBriefGenerationInput,
} from './task-brief-generation.js';

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
  }
  return '任务简报保存失败，原任务没有被移动，请重试';
}

function isSavedWithStaleIndex(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'task_saved_index_stale';
}

export class TaskBriefModal extends Modal {
  private objective: string;
  private nextAction: string;
  private completionCriteria: string;
  private generating = false;
  private saving = false;
  private saved = false;
  private indexStale = false;
  private error = '';
  private closed = false;

  constructor(
    app: App,
    private readonly controller: TaskBriefController,
    private readonly prepared: PreparedTaskBrief,
    private readonly generate?: (
      input: TaskBriefGenerationInput,
    ) => Promise<TaskBriefDraft>,
  ) {
    super(app);
    this.objective = prepared.task.taskBrief?.objective ?? '';
    this.nextAction = prepared.task.taskBrief?.nextAction ?? '';
    this.completionCriteria = prepared.task.taskBrief?.completionCriteria ?? '';
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
    this.renderGeneration();
    this.renderBriefFields();
    this.renderActions();
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
      this.objective = draft.objective;
      this.nextAction = draft.nextAction;
      this.completionCriteria = draft.completionCriteria;
    } catch {
      this.error = 'AI 暂时无法生成任务简报。你可以检查模型配置后重试，或直接人工填写并保存。';
    } finally {
      this.generating = false;
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
