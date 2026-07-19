import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  setIcon,
  setTooltip,
} from 'obsidian';

import type { Priority } from '../domain/task.js';
import type { PreparedConfirmation } from './confirmation-controller.js';
import {
  ConfirmationController,
  InvalidConfirmationFormError,
} from './confirmation-controller.js';
import type {
  ConfirmationFormErrors,
  ConfirmationFormInput,
} from './confirmation-form.js';
import type {
  TaskEnrichment,
  TaskEnrichmentInput,
} from './task-enrichment.js';

const NEW_PROJECT_VALUE = '__atl_new_project__';
const NO_PROJECT_VALUE = '__atl_no_project__';

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string };
    if (coded.code === 'project_already_exists') {
      return '同名项目已经存在，请选择已有项目';
    }
    if (coded.code === 'confirm_task_project_not_found') {
      return '所选项目不存在，请重新选择';
    }
    if (coded.code === 'task_confirmation_invalid_state') {
      return '任务已经不在收件箱，请刷新看板';
    }
    if (coded.code === 'task_conflict') {
      return '任务刚刚被其他操作修改，请刷新后重试';
    }
  }
  return '确认失败，任务没有被移动。请刷新后重试';
}

export class TaskConfirmationModal extends Modal {
  private projectValue: string;
  private newProjectName = '';
  private newProjectDescription = '';
  private objective: string;
  private acceptanceCriteria: string[];
  private priority: Priority;
  private userIntent = '';
  private errors: ConfirmationFormErrors = {};
  private formError = '';
  private submitting = false;
  private enriching = false;

  constructor(
    app: App,
    private readonly controller: ConfirmationController,
    private readonly prepared: PreparedConfirmation,
    private readonly enrich?: (input: TaskEnrichmentInput) => Promise<TaskEnrichment>,
  ) {
    super(app);
    const knownProject = prepared.task.projectId !== null
      && prepared.projects.some(({ projectId }) => (
        projectId === prepared.task.projectId
      ));
    this.projectValue = knownProject
      ? prepared.task.projectId ?? NO_PROJECT_VALUE
      : NO_PROJECT_VALUE;
    this.objective = prepared.task.objective ?? '';
    this.acceptanceCriteria = prepared.task.acceptanceCriteria.length > 0
      ? [...prepared.task.acceptanceCriteria]
      : [''];
    this.priority = prepared.task.priority;
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-task-confirmation-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '移到待办' });
    contentEl.createDiv({
      cls: 'atl-task-title',
      text: this.prepared.task.title,
    });
    contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: '项目、目标和完成条件都可以稍后补充。',
    });

    if (this.formError !== '') {
      contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    this.renderProject(contentEl);
    this.renderEnrichment(contentEl);
    this.renderObjective(contentEl);
    this.renderAcceptanceCriteria(contentEl);
    this.renderPriority(contentEl);
    this.renderActions(contentEl);
  }

  private renderEnrichment(container: HTMLElement): void {
    if (this.enrich === undefined) return;
    new Setting(container)
      .setName('补充说明')
      .setDesc('可选，用一句话告诉 AI 你最终想得到什么')
      .addTextArea((text) => {
        text.inputEl.rows = 2;
        text
          .setPlaceholder('例如：给出是否值得接入的明确建议')
          .setValue(this.userIntent)
          .onChange((value) => {
            this.userIntent = value;
          });
      });
    new Setting(container)
      .setName('AI 整理')
      .setDesc('只生成目标和完成条件，生成后仍可编辑')
      .addButton((button) => button
        .setButtonText(this.enriching ? '正在整理...' : 'AI 帮我整理')
        .setIcon('sparkles')
        .setDisabled(this.enriching || this.submitting)
        .onClick(() => this.runEnrichment()));
  }

  private renderProject(container: HTMLElement): void {
    const projectSetting = new Setting(container)
      .setName('项目')
      .setDesc('可选，用于归类任务')
      .addDropdown((dropdown) => {
        dropdown.addOption(NO_PROJECT_VALUE, '暂不选择项目');
        for (const project of this.prepared.projects) {
          dropdown.addOption(project.projectId, project.name);
        }
        dropdown
          .addOption(NEW_PROJECT_VALUE, '新建项目...')
          .setValue(this.projectValue)
          .onChange((value) => {
            this.projectValue = value;
            delete this.errors.project;
            this.render();
          });
      });
    this.appendFieldError(projectSetting, this.errors.project);

    if (this.projectValue === NEW_PROJECT_VALUE) {
      new Setting(container)
        .setName('项目名称')
        .addText((text) => text
          .setPlaceholder('例如：AI 产品雷达')
          .setValue(this.newProjectName)
          .onChange((value) => {
            this.newProjectName = value;
          }));
      new Setting(container)
        .setName('项目说明')
        .addTextArea((text) => {
          text.inputEl.rows = 2;
          text
            .setPlaceholder('这个项目持续关注什么？')
            .setValue(this.newProjectDescription)
            .onChange((value) => {
              this.newProjectDescription = value;
            });
        });
    }
  }

  private renderObjective(container: HTMLElement): void {
    const setting = new Setting(container)
      .setName('任务目标')
      .setDesc('可选，说明希望最终得到什么结果')
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text
          .setPlaceholder('例如：梳理产品定位、核心能力和公开定价')
          .setValue(this.objective)
          .onChange((value) => {
            this.objective = value;
          });
      });
    this.appendFieldError(setting, this.errors.objective);
  }

  private renderAcceptanceCriteria(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'atl-criteria-section' });
    section.createDiv({ cls: 'setting-item-name', text: '验收标准' });
    section.createDiv({
      cls: 'setting-item-description',
      text: '每一条都应能在验收时明确判断是否满足',
    });
    const list = section.createDiv({ cls: 'atl-criteria-list' });
    this.acceptanceCriteria.forEach((criterion, index) => {
      const row = list.createDiv({ cls: 'atl-criterion-row' });
      const input = row.createEl('textarea', {
        attr: {
          'aria-label': `验收标准 ${index + 1}`,
          placeholder: `验收标准 ${index + 1}`,
          rows: '2',
        },
      });
      input.value = criterion;
      input.addEventListener('input', () => {
        this.acceptanceCriteria[index] = input.value;
      });
      const removeButton = row.createEl('button', {
        cls: 'clickable-icon atl-icon-button',
        attr: { 'aria-label': '删除这条验收标准' },
      });
      setIcon(removeButton, 'trash-2');
      setTooltip(removeButton, '删除');
      removeButton.disabled = this.acceptanceCriteria.length === 1;
      removeButton.addEventListener('click', () => {
        this.acceptanceCriteria.splice(index, 1);
        this.render();
      });
    });
    if (this.errors.acceptanceCriteria !== undefined) {
      section.createDiv({
        cls: 'atl-form-error',
        text: this.errors.acceptanceCriteria,
      });
    }
    const addButton = section.createEl('button', {
      cls: 'atl-add-criterion-button',
      text: '添加验收标准',
    });
    setIcon(addButton, 'plus');
    addButton.addEventListener('click', () => {
      this.acceptanceCriteria.push('');
      this.render();
    });
  }

  private renderPriority(container: HTMLElement): void {
    new Setting(container)
      .setName('优先级')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PRIORITY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.priority)
          .onChange((value) => {
            this.priority = value as Priority;
          });
      });
  }

  private renderActions(container: HTMLElement): void {
    const actions = new Setting(container).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));

    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button
        .setButtonText(this.submitting ? '正在移动...' : '移到待办')
        .setCta()
        .setDisabled(this.submitting)
        .onClick(() => this.submit(submitButton));
    });
  }

  private formInput(): ConfirmationFormInput {
    return {
      project: this.projectValue === NO_PROJECT_VALUE
        ? { mode: 'none' }
        : this.projectValue === NEW_PROJECT_VALUE
        ? {
            mode: 'new',
            name: this.newProjectName,
            description: this.newProjectDescription,
          }
        : { mode: 'existing', projectId: this.projectValue },
      objective: this.objective,
      acceptanceCriteria: this.acceptanceCriteria,
      priority: this.priority,
      autoExecutable: false,
    };
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) {
      return;
    }
    this.submitting = true;
    button.setDisabled(true).setButtonText('正在移动...');
    this.formError = '';
    try {
      await this.controller.confirm(this.prepared.task.taskId, this.formInput());
      new Notice('任务已移到待办');
      this.close();
    } catch (error) {
      if (error instanceof InvalidConfirmationFormError) {
        this.errors = error.errors;
        this.formError = error.message;
      } else {
        this.errors = {};
        this.formError = errorMessage(error);
      }
      this.submitting = false;
      this.render();
    }
  }

  private async runEnrichment(): Promise<void> {
    if (this.enrich === undefined || this.enriching || this.submitting) return;
    this.enriching = true;
    this.formError = '';
    this.render();
    try {
      const result = await this.enrich({
        title: this.prepared.task.title,
        body: this.prepared.task.body,
        userIntent: this.userIntent,
        projectNames: this.prepared.projects.map(({ name }) => name),
      });
      this.objective = result.objective;
      this.acceptanceCriteria = [...result.acceptanceCriteria];
    } catch (error) {
      this.formError = error instanceof Error && error.message.trim() !== ''
        ? `AI 整理失败：${error.message}`
        : 'AI 整理失败，请检查模型配置后重试';
    } finally {
      this.enriching = false;
      this.render();
    }
  }

  private appendFieldError(setting: Setting, message?: string): void {
    if (message !== undefined) {
      setting.settingEl.createDiv({ cls: 'atl-form-error', text: message });
    }
  }
}
