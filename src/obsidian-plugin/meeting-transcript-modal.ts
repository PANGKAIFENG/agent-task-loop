import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

import type {
  MeetingAnalysisView,
} from './meeting-analysis.js';
import type {
  MeetingAttachment,
  MeetingAttachmentDraft,
} from './meeting-attachment.js';
import { deduplicateMeetingAttachments } from './meeting-attachment.js';
import type { PreparedMeetingCandidates } from './meeting-candidate-controller.js';
import type { DingTalkMeetingSource, MeetingType } from './meeting-note.js';
import {
  normalizeMeetingTranscriptForm,
  validateMeetingTranscriptForm,
  type MeetingTranscriptAttachment,
  type MeetingTranscriptFormErrors,
  type MeetingTranscriptFormInput,
  type NormalizedMeetingTranscriptForm,
} from './meeting-transcript-form.js';

export type MeetingTranscriptSubmitAction = 'save' | 'analyze' | 'retry';

export interface MeetingTranscriptModalResult {
  meetingPath: string;
  analysis: MeetingAnalysisView;
  transcript: string;
  attachments: readonly MeetingAttachment[];
  prepared: PreparedMeetingCandidates | null;
}

export interface MeetingTranscriptInitialForm {
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  attachments: readonly MeetingTranscriptAttachment[];
}

export interface MeetingTranscriptModalOptions {
  initialForm?: MeetingTranscriptInitialForm;
  initialResult?: MeetingTranscriptModalResult;
  initialAnalysisStatus?: MeetingAnalysisView['status'];
  modelLabel?: string;
  pickTranscriptFile?: () => Promise<MeetingAttachmentDraft | null>;
  pickReferenceFiles?: () => Promise<readonly MeetingAttachmentDraft[]>;
  onCommitCandidates?: (
    prepared: PreparedMeetingCandidates,
    selectedIds: readonly string[],
  ) => Promise<{ createdTaskIds: string[]; existingTaskIds: string[] }>;
}

type MeetingModalView = 'input' | 'processing' | 'result';

const MEETING_TYPE_LABELS: Record<MeetingType, string> = {
  interview: '面试',
  discussion: '讨论',
  review: '复盘',
  other: '其他',
};

function scheduledLabel(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function cloneAttachment(
  attachment: MeetingTranscriptAttachment,
): MeetingTranscriptAttachment {
  return { ...attachment };
}

export class MeetingTranscriptModal extends Modal {
  private meetingType: MeetingType = 'discussion';
  private participants = '';
  private transcript = '';
  private attachments: MeetingTranscriptAttachment[] = [];
  private errors: MeetingTranscriptFormErrors = {};
  private formError = '';
  private submitting = false;
  private view: MeetingModalView = 'input';
  private result: MeetingTranscriptModalResult | null = null;
  private inputAnalysisStatus: MeetingAnalysisView['status'] = 'pending';
  private selectedCandidateIds = new Set<string>();
  private captureMessage = '';

  constructor(
    app: App,
    private readonly source: DingTalkMeetingSource,
    private readonly onSubmit: (
      input: NormalizedMeetingTranscriptForm,
      action: MeetingTranscriptSubmitAction,
    ) => Promise<MeetingTranscriptModalResult | null | void>,
    private readonly options: MeetingTranscriptModalOptions = {},
  ) {
    super(app);
    if (options.initialForm !== undefined) {
      this.meetingType = options.initialForm.meetingType;
      this.participants = options.initialForm.participants.join('，');
      this.transcript = options.initialForm.transcript;
      this.attachments = options.initialForm.attachments.map(cloneAttachment);
    }
    this.inputAnalysisStatus = options.initialAnalysisStatus
      ?? options.initialResult?.analysis.status
      ?? 'pending';
    if (
      options.initialResult !== undefined
      && options.initialResult.analysis.result !== null
    ) {
      this.result = options.initialResult;
      this.view = 'result';
    }
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-meeting-transcript-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    if (this.view === 'processing') {
      this.renderProcessing();
      return;
    }
    if (this.view === 'result' && this.result !== null) {
      this.renderResult(this.result);
      return;
    }
    this.renderInput();
  }

  private renderEventHeader(title: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: title });
    contentEl.createDiv({
      cls: 'atl-meeting-event-title',
      text: this.source.title,
    });
    contentEl.createDiv({
      cls: 'atl-task-subtitle',
      text: scheduledLabel(this.source.scheduled),
    });
  }

  private renderFormError(): void {
    if (this.formError !== '') {
      this.contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }
  }

  private renderInput(): void {
    const { contentEl } = this;
    this.renderEventHeader(this.result === null ? '添加会议听记' : '编辑会议资料');
    this.renderFormError();
    if (this.result === null && this.inputAnalysisStatus === 'failed') {
      contentEl.createDiv({
        cls: 'atl-meeting-stale-notice',
        text: '上次分析失败，会议资料已保留，可以直接重试。',
      });
    }
    if (this.result === null && this.inputAnalysisStatus === 'stale') {
      contentEl.createDiv({
        cls: 'atl-meeting-stale-notice',
        text: '原总结仍保留在会议笔记中，但当前版本无法恢复结果。请重新分析。',
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

    new Setting(contentEl)
      .setName('导入听记文件')
      .setDesc('支持 txt、md、docx、pdf；导入后仍可编辑原文')
      .addButton((button) => button
        .setButtonText('从文件导入原文')
        .setDisabled(this.submitting || this.options.pickTranscriptFile === undefined)
        .onClick(() => {
          void this.pickTranscript();
        }));

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

    new Setting(contentEl)
      .setName('关联资料')
      .setDesc('可添加多个文件；只有显式勾选的可解析资料会发送给模型')
      .addButton((button) => button
        .setButtonText('添加关联资料')
        .setDisabled(this.submitting || this.options.pickReferenceFiles === undefined)
        .onClick(() => {
          void this.pickReferences();
        }));
    this.renderAttachments();

    contentEl.createEl('p', {
      cls: 'atl-meeting-model-disclosure',
      text: `会议听记和你勾选的资料将发送到 ${this.options.modelLabel ?? '当前配置的模型服务'}；未勾选资料只保存在本地。`,
    });

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
        .onClick(() => {
          void this.submit('save', saveButton);
        });
    });
    const analyzeAction: MeetingTranscriptSubmitAction = this.result !== null
      || this.inputAnalysisStatus === 'failed'
      || this.inputAnalysisStatus === 'stale'
      ? 'retry'
      : 'analyze';
    let analyzeButton: ButtonComponent;
    actions.addButton((button) => {
      analyzeButton = button;
      button
        .setButtonText(
          analyzeAction === 'retry'
            ? this.result === null
              ? this.inputAnalysisStatus === 'stale' ? '重新分析' : '重试分析'
              : '保存并重新分析'
            : '保存并分析',
        )
        .setCta()
        .setDisabled(this.submitting)
        .onClick(() => {
          void this.submit(analyzeAction, analyzeButton);
        });
    });
  }

  private renderAttachments(): void {
    if (this.attachments.length === 0) return;
    const list = this.contentEl.createDiv({ cls: 'atl-meeting-attachment-list' });
    for (const [index, attachment] of this.attachments.entries()) {
      const row = list.createDiv({ cls: 'atl-meeting-attachment-row' });
      const content = row.createDiv({ cls: 'atl-meeting-attachment-content' });
      content.createDiv({ cls: 'atl-meeting-attachment-name', text: attachment.name });
      const role = attachment.unavailableReason !== undefined
        ? attachment.unavailableReason
        : attachment.role === 'transcript'
        ? '听记原文附件，会随原文参与分析'
        : attachment.analyzable
          ? '可解析资料'
          : '仅保存附件';
      content.createDiv({ cls: 'atl-meeting-attachment-meta', text: role });
      if (
        attachment.unavailableReason === undefined
        && attachment.role === 'reference'
        && attachment.analyzable
      ) {
        const label = row.createEl('label', { cls: 'atl-meeting-attachment-toggle' });
        const checkbox = label.createEl('input', {
          type: 'checkbox',
          attr: { 'aria-label': `用于分析 ${attachment.name}` },
        });
        checkbox.checked = attachment.includeInAnalysis;
        checkbox.addEventListener('change', () => {
          this.attachments[index] = {
            ...attachment,
            includeInAnalysis: checkbox.checked,
          };
        });
        label.createEl('span', { text: '用于分析' });
      }
      const remove = row.createEl('button', {
        text: '移除',
        attr: { type: 'button', 'aria-label': `移除 ${attachment.name}` },
      });
      remove.addEventListener('click', () => {
        this.attachments.splice(index, 1);
        this.render();
      });
    }
  }

  private renderProcessing(): void {
    this.renderEventHeader('正在处理会议资料');
    this.contentEl.createDiv({
      cls: 'atl-meeting-processing',
      text: '正在分析会议资料，请保持 Obsidian 打开。',
    });
    this.contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: `模型：${this.options.modelLabel ?? '当前配置的模型服务'}`,
    });
  }

  private renderResult(result: MeetingTranscriptModalResult): void {
    this.renderEventHeader('会议总结');
    this.renderFormError();
    if (result.analysis.status === 'stale') {
      this.contentEl.createDiv({
        cls: 'atl-meeting-stale-notice',
        text: '内容已更新，建议重新分析。旧总结仍保留。',
      });
    }
    const metadata = this.contentEl.createDiv({ cls: 'atl-meeting-result-meta' });
    metadata.createEl('span', { text: `状态：${this.statusLabel(result.analysis.status)}` });
    metadata.createEl('span', { text: `模型：${result.analysis.model ?? 'inherit'}` });

    const analysis = result.analysis.result;
    if (analysis !== null) {
      const summary = this.contentEl.createEl('section', { cls: 'atl-meeting-result-section' });
      summary.createEl('h3', { text: '摘要' });
      summary.createEl('p', { text: analysis.summary });

      const conclusions = this.contentEl.createEl('section', {
        cls: 'atl-meeting-result-section',
      });
      conclusions.createEl('h3', { text: '关键结论' });
      const list = conclusions.createEl('ul');
      for (const conclusion of analysis.conclusions) {
        list.createEl('li', { text: conclusion });
      }

      const candidates = this.contentEl.createEl('section', {
        cls: 'atl-meeting-result-section',
      });
      candidates.createEl('h3', { text: '待办候选' });
      if (analysis.taskCandidates.length === 0) {
        candidates.createEl('p', { text: '本次分析未发现明确待办。' });
      } else {
        const candidateList = candidates.createDiv({ cls: 'atl-candidate-list' });
        analysis.taskCandidates.forEach((candidate, index) => {
          const prepared = result.prepared?.candidates[index];
          const row = candidateList.createDiv({ cls: 'atl-candidate-row' });
          const checkboxCell = row.createDiv({ cls: 'atl-candidate-checkbox' });
          if (prepared !== undefined) {
            const checkbox = checkboxCell.createEl('input', {
              type: 'checkbox',
              attr: { 'aria-label': `选择 ${candidate.title}` },
            });
            checkbox.checked = this.selectedCandidateIds.has(prepared.candidateId);
            checkbox.disabled = this.submitting;
            checkbox.addEventListener('change', () => {
              if (checkbox.checked) this.selectedCandidateIds.add(prepared.candidateId);
              else this.selectedCandidateIds.delete(prepared.candidateId);
            });
          }
          const candidateContent = row.createDiv({ cls: 'atl-candidate-content' });
          candidateContent.createDiv({ cls: 'atl-candidate-title', text: candidate.title });
          candidateContent.createDiv({
            cls: 'atl-candidate-summary',
            text: candidate.explanation,
          });
          candidateContent.createDiv({
            cls: 'atl-candidate-source-date',
            text: `来源：${candidate.sourceName}`,
          });
          candidateContent.createEl('blockquote', {
            cls: 'atl-candidate-quote',
            text: candidate.sourceQuote,
          });
        });
      }
    }

    if (result.attachments.length > 0) {
      const sources = this.contentEl.createEl('section', {
        cls: 'atl-meeting-result-section',
      });
      sources.createEl('h3', { text: '关联资料' });
      const list = sources.createEl('ul');
      for (const attachment of result.attachments) {
        list.createEl('li', {
          text: `${attachment.name} · ${attachment.includeInAnalysis ? '已用于分析' : '仅本地保存'}`,
        });
      }
    }

    const transcript = this.contentEl.createEl('details', {
      cls: 'atl-meeting-transcript-details',
    });
    transcript.createEl('summary', { text: '查看会议听记原文' });
    transcript.createEl('pre', { text: result.transcript });

    if (this.captureMessage !== '') {
      this.contentEl.createDiv({
        cls: 'atl-meeting-capture-result',
        text: this.captureMessage,
      });
    }

    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('编辑资料')
      .setDisabled(this.submitting)
      .onClick(() => {
        this.view = 'input';
        this.formError = '';
        this.render();
      }));
    if (result.analysis.status === 'stale' || result.analysis.status === 'failed') {
      let retryButton: ButtonComponent;
      actions.addButton((button) => {
        retryButton = button;
        button
          .setButtonText(result.analysis.status === 'stale' ? '重新分析' : '重试分析')
          .setDisabled(this.submitting)
          .onClick(() => {
            void this.submit('retry', retryButton);
          });
      });
    }
    if (result.prepared !== null && result.prepared.candidates.length > 0) {
      let captureButton: ButtonComponent;
      actions.addButton((button) => {
        captureButton = button;
        button
          .setButtonText('将所选任务加入 Inbox')
          .setCta()
          .setDisabled(this.submitting || this.options.onCommitCandidates === undefined)
          .onClick(() => {
            void this.commitCandidates(captureButton);
          });
      });
    }
    actions.addButton((button) => button
      .setButtonText('关闭')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
  }

  private statusLabel(status: MeetingAnalysisView['status']): string {
    if (status === 'ready_for_confirm') return '分析完成';
    if (status === 'stale') return '内容已更新';
    if (status === 'failed') return '分析失败';
    return '待分析';
  }

  private async pickTranscript(): Promise<void> {
    if (this.options.pickTranscriptFile === undefined || this.submitting) return;
    this.submitting = true;
    this.formError = '';
    try {
      const attachment = await this.options.pickTranscriptFile();
      if (attachment === null) return;
      this.attachments = deduplicateMeetingAttachments([
        attachment,
        ...this.attachments.filter((item) => (
          item.role !== 'transcript' && item.id !== attachment.id
        )),
      ]);
      this.transcript = attachment.extractedText ?? '';
      delete this.errors.transcript;
    } catch {
      this.formError = '听记文件未能导入，请确认格式和文件大小后重试。';
    } finally {
      this.submitting = false;
      this.render();
    }
  }

  private async pickReferences(): Promise<void> {
    if (this.options.pickReferenceFiles === undefined || this.submitting) return;
    this.submitting = true;
    this.formError = '';
    try {
      const picked = await this.options.pickReferenceFiles();
      const known = new Set(this.attachments.map((item) => item.id));
      for (const item of picked) {
        const attachment = { ...item, includeInAnalysis: false };
        if (known.has(attachment.id)) continue;
        known.add(attachment.id);
        this.attachments.push(attachment);
      }
    } catch {
      this.formError = '关联资料未能添加，请确认文件大小后重试。';
    } finally {
      this.submitting = false;
      this.render();
    }
  }

  private currentForm(): MeetingTranscriptFormInput {
    return {
      meetingType: this.meetingType,
      participants: this.participants,
      transcript: this.transcript,
      attachments: this.attachments,
    };
  }

  private async submit(
    action: MeetingTranscriptSubmitAction,
    button: ButtonComponent,
  ): Promise<void> {
    if (this.submitting) return;
    const form = this.currentForm();
    this.errors = validateMeetingTranscriptForm(form);
    if (Object.keys(this.errors).length > 0) {
      this.view = 'input';
      this.render();
      return;
    }
    const previousView = this.view;
    this.submitting = true;
    this.formError = '';
    this.view = 'processing';
    this.render();
    button.setDisabled(true);
    try {
      const result = await this.onSubmit(normalizeMeetingTranscriptForm(form), action);
      if (action === 'save') {
        this.close();
        return;
      }
      if (result === null || result === undefined) {
        throw new Error('会议分析没有返回结果');
      }
      this.result = result;
      this.inputAnalysisStatus = result.analysis.status;
      this.transcript = result.transcript;
      this.attachments = result.attachments.map(cloneAttachment);
      this.selectedCandidateIds.clear();
      this.captureMessage = '';
      this.view = 'result';
    } catch {
      this.formError = action === 'save'
        ? '会议听记未能保存，请重试。'
        : '会议资料已保留，但分析未完成。请重试。';
      this.view = previousView === 'result' ? 'result' : 'input';
    } finally {
      this.submitting = false;
      this.render();
    }
  }

  private async commitCandidates(button: ButtonComponent): Promise<void> {
    if (
      this.submitting
      || this.result?.prepared === null
      || this.result?.prepared === undefined
      || this.options.onCommitCandidates === undefined
    ) return;
    this.submitting = true;
    this.formError = '';
    button.setDisabled(true).setButtonText('正在加入...');
    try {
      const committed = await this.options.onCommitCandidates(
        this.result.prepared,
        [...this.selectedCandidateIds],
      );
      const accepted = committed.createdTaskIds.length + committed.existingTaskIds.length;
      this.captureMessage = accepted === 0
        ? '尚未选择待办，候选仍保留在会议总结中。'
        : `已将 ${accepted} 个任务加入 Inbox。`;
    } catch {
      this.formError = '所选候选未能加入 Inbox，请重试。';
    } finally {
      this.submitting = false;
      this.render();
    }
  }

  private appendError(setting: Setting, message?: string): void {
    if (message !== undefined) {
      setting.settingEl.createDiv({ cls: 'atl-form-error', text: message });
    }
  }
}
