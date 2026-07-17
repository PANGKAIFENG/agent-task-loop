import { randomUUID } from 'node:crypto';

import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

import type { Priority } from '../domain/task.js';
import type { CaptureTaskInput } from '../services/capture-task.js';
import {
  toQuickCaptureInput,
  validateQuickCapture,
  type QuickCaptureErrors,
  type QuickCaptureFormInput,
} from './quick-capture-form.js';

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

export class QuickCaptureModal extends Modal {
  private title = '';
  private body = '';
  private priority: Priority = 'normal';
  private errors: QuickCaptureErrors = {};
  private formError = '';
  private submitting = false;

  constructor(
    app: App,
    private readonly onSubmit: (input: CaptureTaskInput) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-quick-capture-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '新建任务' });
    contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: '任务会先进入 Inbox，稍后再补齐项目和验收标准。',
    });
    if (this.formError !== '') {
      contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    const titleSetting = new Setting(contentEl)
      .setName('任务标题')
      .addText((text) => text
        .setPlaceholder('例如：调研 Agent-Reach 的适用场景')
        .setValue(this.title)
        .onChange((value) => {
          this.title = value;
          delete this.errors.title;
        }));
    this.appendError(titleSetting, this.errors.title);

    new Setting(contentEl)
      .setName('补充说明')
      .setDesc('可选，记录背景或你希望后续关注的重点')
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text
          .setPlaceholder('不填时使用任务标题作为说明')
          .setValue(this.body)
          .onChange((value) => {
            this.body = value;
          });
      });

    const prioritySetting = new Setting(contentEl)
      .setName('优先级')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PRIORITY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.priority)
          .onChange((value) => {
            this.priority = value as Priority;
            delete this.errors.priority;
          });
      });
    this.appendError(prioritySetting, this.errors.priority);

    const actions = new Setting(contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button
        .setButtonText(this.submitting ? '正在加入...' : '加入 Inbox')
        .setCta()
        .setDisabled(this.submitting)
        .onClick(() => this.submit(submitButton));
    });
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) return;
    const form: QuickCaptureFormInput = {
      title: this.title,
      body: this.body,
      priority: this.priority,
    };
    this.errors = validateQuickCapture(form);
    if (Object.keys(this.errors).length > 0) {
      this.render();
      return;
    }
    this.submitting = true;
    this.formError = '';
    button.setDisabled(true).setButtonText('正在加入...');
    try {
      await this.onSubmit(toQuickCaptureInput(form, this.clock(), this.id()));
      this.close();
    } catch {
      this.submitting = false;
      this.formError = '任务未能加入 Inbox，请检查插件设置后重试。';
      this.render();
    }
  }

  private appendError(setting: Setting, message?: string): void {
    if (message !== undefined) {
      setting.settingEl.createDiv({ cls: 'atl-form-error', text: message });
    }
  }
}
