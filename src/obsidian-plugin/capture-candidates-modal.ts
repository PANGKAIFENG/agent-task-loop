import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

import type {
  CaptureCandidateView,
  PreparedCapture,
} from './capture-controller.js';
import {
  createCandidateSelection,
  selectedCandidateIds,
  setCandidateSelectionSubmitting,
  setIgnoreUnselected,
  toggleCandidate,
  type CandidateSelectionState,
} from './capture-candidates-state.js';

function sourceLabel(candidate: CaptureCandidateView): string {
  return candidate.recordedAt === null
    ? candidate.sourceDate
    : candidate.recordedAt.replace('T', ' ').slice(0, 16);
}

export interface CaptureCandidatesModalOptions {
  unselectedExplanation?: string;
  allowIgnoreUnselected?: boolean;
  initialSelectedCandidateIds?: readonly string[];
}

export class CaptureCandidatesModal extends Modal {
  private candidateSelection: CandidateSelectionState;
  private formError = '';

  constructor(
    app: App,
    private readonly prepared: PreparedCapture,
    private readonly onSubmit: (
      selectedIds: readonly string[],
      ignoredIds: readonly string[],
    ) => Promise<void>,
    private readonly options: CaptureCandidatesModalOptions = {},
  ) {
    super(app);
    this.candidateSelection = createCandidateSelection(
      prepared.candidates.map(({ candidateId }) => candidateId),
      options.initialSelectedCandidateIds,
    );
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-capture-candidates-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '确认待办候选' });
    contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: `扫描 ${this.prepared.filesScanned} 个文件，分析 ${this.prepared.recordsConsidered} 条记录，找到 ${this.prepared.candidates.length} 个候选。`,
    });
    if (this.formError !== '') {
      contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    const list = contentEl.createDiv({ cls: 'atl-candidate-list' });
    for (const candidate of this.prepared.candidates) {
      const row = list.createEl('label', { cls: 'atl-candidate-row' });
      const checkboxCell = row.createDiv({ cls: 'atl-candidate-checkbox' });
      const checkbox = checkboxCell.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': `选择 ${candidate.title}` },
      });
      checkbox.checked = this.candidateSelection.selectedIds.has(candidate.candidateId);
      checkbox.disabled = this.candidateSelection.submitting;
      checkbox.addEventListener('change', () => {
        this.candidateSelection = toggleCandidate(
          this.candidateSelection,
          candidate.candidateId,
        );
      });

      const content = row.createDiv({ cls: 'atl-candidate-content' });
      content.createDiv({ cls: 'atl-candidate-title', text: candidate.title });
      content.createDiv({ cls: 'atl-candidate-summary', text: candidate.summary });
      content.createDiv({
        cls: 'atl-candidate-source-date',
        text: `来源 ${sourceLabel(candidate)}`,
      });
      content.createEl('blockquote', {
        cls: 'atl-candidate-quote',
        text: candidate.sourceQuote.slice(0, 300),
      });
    }

    const resolution = contentEl.createDiv({ cls: 'atl-candidate-resolution' });
    resolution.createEl('p', {
      text: this.options.unselectedExplanation
        ?? '未勾选的候选会保留，下次扫描仍会出现。',
    });
    if (this.options.allowIgnoreUnselected !== false) {
      const ignoreControl = resolution.createDiv({
        cls: 'atl-candidate-ignore-unselected',
      });
      const ignoreCheckbox = ignoreControl.createEl('input', {
        type: 'checkbox',
        attr: { 'aria-label': '忽略所有未选候选' },
      });
      ignoreCheckbox.checked = this.candidateSelection.ignoreUnselected;
      ignoreCheckbox.disabled = this.candidateSelection.submitting;
      ignoreCheckbox.addEventListener('click', () => {
        this.candidateSelection = setIgnoreUnselected(
          this.candidateSelection,
          !this.candidateSelection.ignoreUnselected,
        );
      });
      ignoreControl.createEl('span', { text: '忽略所有未选候选（以后不再显示）' });
    }

    const actions = new Setting(contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.candidateSelection.submitting)
      .onClick(() => this.close()));
    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button
        .setButtonText(this.candidateSelection.submitting
          ? '正在加入...'
          : '将所选任务加入 Inbox')
        .setCta()
        .setDisabled(this.candidateSelection.submitting)
        .onClick(() => this.submit(submitButton));
    });
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.candidateSelection.submitting) return;
    const selectedIds = selectedCandidateIds(this.candidateSelection);
    const ignoredIds = this.candidateSelection.ignoreUnselected
      ? this.candidateSelection.candidateIds.filter((id) => (
        !this.candidateSelection.selectedIds.has(id)
      ))
      : [];
    this.candidateSelection = setCandidateSelectionSubmitting(
      this.candidateSelection,
      true,
    );
    this.formError = '';
    button.setDisabled(true).setButtonText('正在加入...');
    try {
      await this.onSubmit(
        selectedIds,
        ignoredIds,
      );
      this.close();
    } catch {
      this.candidateSelection = setCandidateSelectionSubmitting(
        this.candidateSelection,
        false,
      );
      this.formError = '候选未能全部处理，扫描进度没有更新。请重试。';
      this.render();
    }
  }
}
