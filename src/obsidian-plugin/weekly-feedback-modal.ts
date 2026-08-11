import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

export interface WeeklyFeedbackTarget {
  weekKey: string;
  version: number;
}

export class WeeklyFeedbackModal extends Modal {
  private feedback = '';
  private formError = '';
  private submitting = false;
  private completed = false;

  constructor(
    app: App,
    private readonly target: WeeklyFeedbackTarget,
    private readonly onSubmit: (feedback: string) => Promise<void>,
    private readonly onCancel?: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-weekly-feedback-modal');
    this.render();
  }

  override onClose(): void {
    if (!this.completed) this.onCancel?.();
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '退回周报修改' });
    this.contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: `${this.target.weekKey} · v${this.target.version}`,
    });
    this.contentEl.createEl('p', {
      text: '将复制当前内容生成下一版本，源进展不会被修改。',
    });
    if (this.formError !== '') {
      this.contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    new Setting(this.contentEl)
      .setName('修改意见')
      .setDesc('说明需要调整的表达、证据或待确认项')
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.setAttribute('aria-label', '周报修改意见');
        text
          .setPlaceholder('例如：压缩背景，补充输出产物和当前卡点')
          .setValue(this.feedback)
          .onChange((value) => {
            this.feedback = value;
            this.formError = '';
          });
      });

    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button.buttonEl.classList.add('mod-warning');
      button
        .setButtonText('退回并生成新版')
        .setDisabled(this.submitting)
        .onClick(() => this.submit(submitButton));
    });
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) return;
    const feedback = this.feedback.trim();
    if (feedback === '') {
      this.formError = '请填写修改意见';
      this.render();
      return;
    }
    this.submitting = true;
    this.formError = '';
    for (const action of this.contentEl.querySelectorAll('button')) {
      action.disabled = true;
    }
    button.setButtonText('正在生成新版...');
    try {
      await this.onSubmit(feedback);
      this.completed = true;
      this.close();
    } catch {
      this.submitting = false;
      this.formError = '退回失败，请重试';
      this.render();
    }
  }
}
