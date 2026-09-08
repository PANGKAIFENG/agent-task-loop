import { Setting } from 'obsidian';

import type { Task } from '../domain/task.js';
import { contractGaps, type ContractGap } from './development-contract.js';

// PAW-GOAL-003-V0.5 D1 (PRD 4.2): the Contract preview step rendered inside
// the confirmation Modal. Read-only summary of exactly what will be
// dispatched, plus the gap-driven gating of the dispatch button. The gap
// list comes from the service admission (contractGaps or the service's own
// admission error strings) — this view never re-derives rules, and TEP
// identifiers never appear here because nothing has been dispatched yet.

export interface DevelopmentContractViewOptions {
  task: Task;
  projectName: string;
  repoDeliveryAcknowledged: boolean;
  /** Service-returned admission gaps override the locally recomputed list. */
  gaps?: ContractGap[];
  /** False once the task is authorized (agent_executable): fields are fixed. */
  canReturnToForm?: boolean;
  onBackToForm(): void;
  onDefer(): void;
  onDispatch(): void;
  onAcknowledgementChange(acknowledged: boolean): void;
}

function appendSummaryValue(
  list: HTMLElement,
  label: string,
  populate: (value: HTMLElement) => void,
): void {
  const row = list.createEl('div', { cls: 'atl-task-brief-summary-row' });
  row.createEl('dt', { text: label });
  const value = row.createEl('dd');
  populate(value);
}

function appendTextSummary(list: HTMLElement, label: string, text: string): void {
  appendSummaryValue(list, label, (value) => {
    value.setText(text);
  });
}

function appendListSummary(
  list: HTMLElement,
  label: string,
  entries: readonly string[],
  monospace: boolean,
): void {
  appendSummaryValue(list, label, (value) => {
    if (entries.length === 0) {
      value.setText('—');
      return;
    }
    const items = value.createEl('ul');
    for (const entry of entries) {
      const item = items.createEl('li');
      if (monospace) {
        item.createEl('code', { text: entry });
      } else {
        item.setText(entry);
      }
    }
  });
}

function renderBanner(
  container: HTMLElement,
  title: string,
  body: string,
  error: boolean,
): void {
  const banner = container.createDiv({
    cls: `atl-task-brief-banner${error ? ' is-error' : ''}`,
  });
  banner.createDiv({ cls: 'atl-banner-title', text: title });
  banner.createDiv({ cls: 'atl-banner-body', text: body });
}

export function renderDevelopmentContract(
  container: HTMLElement,
  options: DevelopmentContractViewOptions,
): void {
  const { task } = options;
  const gaps = options.gaps ?? contractGaps(task, options.repoDeliveryAcknowledged);
  const dispatchable = gaps.length === 0;
  const canReturnToForm = options.canReturnToForm !== false;

  container.createEl('h2', { text: 'Task Contract' });
  container.createDiv({ cls: 'atl-task-title', text: task.title });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: dispatchable
      ? '确认投递前请核对以下内容；本界面不投递则不会有任何外部写入。'
      : '以下内容将随任务一起投递；存在缺口时不能交给 Multica。',
  });

  const summary = container.createEl('dl', { cls: 'atl-contract-summary' });
  appendTextSummary(summary, '目标', task.objective ?? '—');
  appendListSummary(summary, '验收标准', task.acceptanceCriteria, false);
  appendTextSummary(
    summary,
    '项目',
    options.projectName !== '' ? options.projectName : task.projectId ?? '—',
  );
  appendListSummary(summary, '上下文引用', task.contextRefs ?? [], true);
  appendTextSummary(
    summary,
    '权限范围',
    task.permissionProfile === 'repo_delivery'
      ? options.repoDeliveryAcknowledged
        ? 'repo_delivery · 允许在目标仓库内交付代码；发布仍需独立审批'
        : 'repo_delivery（勾选未生效：下方缺口未清）'
      : task.permissionProfile ?? '—',
  );
  appendTextSummary(summary, '执行目标', task.executionTarget ?? '—');

  renderPermissionDeclaration(container, options);

  if (dispatchable) {
    renderBanner(
      container,
      '确认后将创建唯一的 Multica Issue',
      '本任务的执行过程由 Multica 承载；关键决策与 RC 验收会经钉钉通知。点击确认前不会创建 Issue、分支或发送任何通知。',
      false,
    );
  } else {
    renderBanner(
      container,
      `还不能交给 Multica —— 有 ${gaps.length} 个缺口需要修正：`,
      '逐条修正后按钮自动恢复可用。',
      true,
    );
    const gapList = container.createDiv({ cls: 'atl-gap-list' });
    for (const gap of gaps) {
      gapList.createDiv({ cls: 'atl-gap-item', text: gap.message });
    }
  }

  renderActions(container, dispatchable, canReturnToForm, options);
}

// The acknowledgement checkbox also lives on the Contract step: a task can
// reach this step without passing the form (D2 补投入口), so the declaration
// must be makable here — and until it is made, the dispatch button stays
// disabled with an explicit gap (PRD 4.2 / D1 acceptance).
function renderPermissionDeclaration(
  container: HTMLElement,
  options: DevelopmentContractViewOptions,
): void {
  const section = container.createDiv({
    cls: 'atl-permission-section atl-contract-permission',
  });
  const label = section.createEl('label', { cls: 'atl-permission-label' });
  const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
  checkbox.checked = options.repoDeliveryAcknowledged;
  checkbox.addEventListener('change', () => {
    options.onAcknowledgementChange(checkbox.checked);
  });
  const text = label.createSpan({ cls: 'atl-permission-text' });
  text.createEl('strong', { text: 'repo_delivery' });
  text.append('：允许 Agent 在目标仓库内交付代码（分支、提交、PR）。独立 CR 与发布审批仍然必须人工通过。');
}

function renderActions(
  container: HTMLElement,
  dispatchable: boolean,
  canReturnToForm: boolean,
  options: DevelopmentContractViewOptions,
): void {
  const actions = new Setting(container).setClass('atl-modal-actions');
  if (canReturnToForm) {
    actions.addButton((button) => button
      .setButtonText('返回修改')
      .onClick(() => options.onBackToForm()));
  }
  actions.addButton((button) => button
    .setButtonText('稍后再投')
    .onClick(() => options.onDefer()));
  actions.addButton((button) => button
    .setButtonText('确认并交给 Multica')
    .setCta()
    .setDisabled(!dispatchable)
    .onClick(() => {
      if (dispatchable) options.onDispatch();
    }));
}
