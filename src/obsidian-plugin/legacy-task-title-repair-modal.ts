import { App, Modal } from 'obsidian';

import type {
  LegacyTaskTitlePreview,
  LegacyTaskTitleRepairResult,
} from '../services/repair-legacy-task-titles.js';

export class LegacyTaskTitleRepairModal extends Modal {
  private submitting = false;
  private error = '';
  private result: LegacyTaskTitleRepairResult | null = null;

  constructor(
    app: App,
    private readonly preview: LegacyTaskTitlePreview,
    private readonly onSubmit: () => Promise<LegacyTaskTitleRepairResult>,
    private readonly canSubmit: () => boolean = () => true,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.classList.add('atl-legacy-title-repair-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }

  private render(): void {
    this.contentEl.replaceChildren();
    if (this.result !== null) {
      this.renderResult(this.result);
      return;
    }

    const title = document.createElement('h2');
    title.textContent = '修复旧任务标题';
    const description = document.createElement('p');
    description.className = 'atl-task-subtitle';
    description.textContent = [
      `扫描 ${this.preview.filesScanned} 个 Markdown 文件，`,
      `识别 ${this.preview.tasksScanned} 个任务，`,
      `发现 ${this.preview.candidates.length} 个可修复标题。`,
    ].join('');
    const boundary = document.createElement('p');
    boundary.className = 'atl-legacy-title-repair-boundary';
    boundary.textContent = '只把正文第一个一级标题写入空的 title；不会覆盖已有标题、修改正文或重命名文件。';
    this.contentEl.append(title, description, boundary);

    if (this.error !== '') {
      const error = document.createElement('div');
      error.className = 'atl-form-error atl-form-error-summary';
      error.setAttribute('role', 'alert');
      error.textContent = this.error;
      this.contentEl.append(error);
    }

    const list = document.createElement('div');
    list.className = 'atl-legacy-title-repair-list';
    for (const candidate of this.preview.candidates) {
      const row = document.createElement('div');
      row.className = 'atl-legacy-title-repair-row';
      const candidateTitle = document.createElement('strong');
      candidateTitle.textContent = candidate.title;
      const path = document.createElement('span');
      path.textContent = candidate.path;
      row.append(candidateTitle, path);
      list.append(row);
    }
    this.contentEl.append(list, this.createActions());
  }

  private createActions(): HTMLDivElement {
    const actions = document.createElement('div');
    actions.className = 'atl-legacy-title-repair-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.disabled = this.submitting;
    cancel.addEventListener('click', () => this.close());
    const repair = document.createElement('button');
    repair.type = 'button';
    repair.className = 'mod-cta';
    repair.textContent = `修复 ${this.preview.candidates.length} 个标题`;
    repair.disabled = this.submitting;
    repair.addEventListener('click', () => {
      void this.submit(repair, cancel);
    });
    actions.append(cancel, repair);
    return actions;
  }

  private async submit(
    repairButton: HTMLButtonElement,
    cancelButton: HTMLButtonElement,
  ): Promise<void> {
    if (this.submitting) return;
    if (!this.canSubmit()) {
      this.error = 'Vault 管理权限已关闭，请重新开启后再修复';
      this.render();
      return;
    }
    this.submitting = true;
    this.error = '';
    repairButton.disabled = true;
    cancelButton.disabled = true;
    try {
      this.result = await this.onSubmit();
      this.render();
    } catch {
      this.submitting = false;
      this.error = '修复失败，请重试';
      this.render();
    }
  }

  private renderResult(result: LegacyTaskTitleRepairResult): void {
    const title = document.createElement('h2');
    title.textContent = '旧任务标题修复完成';
    const summary = document.createElement('p');
    summary.className = 'atl-task-subtitle';
    summary.textContent = [
      `扫描 ${result.filesScanned} 个 Markdown 文件，`,
      `可修复 ${result.repairable} 个，`,
      `成功 ${result.repaired} 个，`,
      `跳过 ${result.skipped} 个，`,
      `失败 ${result.failed} 个。`,
    ].join('');
    this.contentEl.append(title, summary);
    if (!result.indexUpdated) {
      const warning = document.createElement('p');
      warning.className = 'atl-form-error atl-form-error-summary';
      warning.textContent = '标题已修复，但任务索引未能刷新；请稍后重试或重新打开 Obsidian。';
      this.contentEl.append(warning);
    }
    const actions = document.createElement('div');
    actions.className = 'atl-legacy-title-repair-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mod-cta';
    close.textContent = '完成';
    close.addEventListener('click', () => this.close());
    actions.append(close);
    this.contentEl.append(actions);
  }
}
