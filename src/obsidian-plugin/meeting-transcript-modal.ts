import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

import type { DingTalkMeetingSource, MeetingType } from './meeting-note.js';
import {
  normalizeMeetingTranscriptForm,
  validateMeetingTranscriptForm,
  type MeetingTranscriptFormErrors,
  type MeetingTranscriptFormInput,
  type NormalizedMeetingTranscriptForm,
} from './meeting-transcript-form.js';

export type MeetingTranscriptSubmitAction = 'save' | 'analyze';

const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  interview: '面试',
  discussion: '讨论',
  review: '复盘',
  other: '其他',
};

function scheduledLabel(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

export class MeetingTranscriptModal extends Modal {
  private meetingType: MeetingType = 'discussion';
  private participants = '';
  private transcript = '';
  private errors: MeetingTranscriptFormErrors = {};
  private formError = '';
  private submitting = false;

  constructor(
    app: App,
    private readonly source: DingTalkMeetingSource,
    private readonly onSubmit: (
      input: NormalizedMeetingTranscriptForm,
      action: MeetingTranscriptSubmitAction,
    ) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-meeting-transcript-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '添加会议听记' });
    contentEl.createDiv({
      cls: 'atl-meeting-event-title',
      text: this.source.title,
    });
    contentEl.createDiv({
      cls: 'atl-task-subtitle',
      text: scheduledLabel(this.source.scheduled),
    });
    if (this.formError !== '') {
      contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    const typeSetting = new Setting(contentEl)
      .setName('会议类型')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(MEETING_TYPE_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.meetingType)
          .onChange((value) => {
            this.meetingType = value as MeetingType;
            delete this.errors.meetingType;
          });
      });
    this.appendError(typeSetting, this.errors.meetingType);

    new Setting(contentEl)
      .setName('参与人')
      .setDesc('可选，用逗号或换行分隔')
      .addText((text) => {
        text.inputEl.setAttribute('aria-label', '参与人');
        text
          .setPlaceholder('例如：候选人，面试官')
          .setValue(this.participants)
          .onChange((value) => {
            this.participants = value;
          });
      });

    const transcriptSetting = new Setting(contentEl)
      .setName('会议听记原文')
      .setDesc('保存在本地会议笔记中，不会回写钉钉日程')
      .addTextArea((text) => {
        text.inputEl.rows = 14;
        text.inputEl.setAttribute('aria-label', '会议听记原文');
        text
          .setPlaceholder('粘贴 AI 听记或会议原文')
          .setValue(this.transcript)
          .onChange((value) => {
            this.transcript = value;
            delete this.errors.transcript;
          });
      });
    this.appendError(transcriptSetting, this.errors.transcript);

    const actions = new Setting(contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
    let saveButton: ButtonComponent;
    actions.addButton((button) => {
      saveButton = button;
      button
        .setButtonText('仅保存')
        .setDisabled(this.submitting)
        .onClick(() => this.submit('save', saveButton));
    });
    let analyzeButton: ButtonComponent;
    actions.addButton((button) => {
      analyzeButton = button;
      button
        .setButtonText('保存并分析')
        .setCta()
        .setDisabled(this.submitting)
        .onClick(() => this.submit('analyze', analyzeButton));
    });
  }

  private async submit(
    action: MeetingTranscriptSubmitAction,
    button: ButtonComponent,
  ): Promise<void> {
    if (this.submitting) return;
    const form: MeetingTranscriptFormInput = {
      meetingType: this.meetingType,
      participants: this.participants,
      transcript: this.transcript,
    };
    this.errors = validateMeetingTranscriptForm(form);
    if (Object.keys(this.errors).length > 0) {
      this.render();
      return;
    }
    this.submitting = true;
    this.formError = '';
    for (const actionButton of this.contentEl.querySelectorAll('button')) {
      actionButton.disabled = true;
    }
    button.setButtonText(action === 'analyze' ? '正在分析...' : '正在保存...');
    try {
      await this.onSubmit(normalizeMeetingTranscriptForm(form), action);
      this.close();
    } catch {
      this.submitting = false;
      this.formError = '会议听记未能保存，请重试。';
      this.render();
    }
  }

  private appendError(setting: Setting, message?: string): void {
    if (message !== undefined) {
      setting.settingEl.createDiv({ cls: 'atl-form-error', text: message });
    }
  }
}
