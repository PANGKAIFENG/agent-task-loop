import { ButtonComponent, Setting } from 'obsidian';

import {
  DISPATCH_EXPECTATION_MINUTES,
  type DispatchResultView,
} from './dispatch-outcome-view.js';

// PAW-GOAL-003-V0.5 D2 (PRD 4.3 / 4.4): the dispatch-in-progress and result
// steps rendered inside the confirmation Modal. The in-progress step is a
// locked view (no close, no second click); the result step renders exactly
// the mapped DispatchResultView — success shows TEP only after the unique
// issue is bound, reconciling never pretends to be delivered.

export interface DispatchProgressViewOptions {
  taskTitle: string;
  startedAtMs: number;
  nowMs: number;
}

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatTimestamp(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function summaryList(container: HTMLElement): HTMLElement {
  return container.createEl('dl', { cls: 'atl-contract-summary' });
}

function summaryRow(
  list: HTMLElement,
  label: string,
  populate: (value: HTMLElement) => void,
): void {
  const row = list.createEl('div', { cls: 'atl-task-brief-summary-row' });
  row.createEl('dt', { text: label });
  populate(row.createEl('dd'));
}

function textRow(list: HTMLElement, label: string, text: string): void {
  summaryRow(list, label, (value) => {
    value.setText(text);
  });
}

function listRow(list: HTMLElement, label: string, entries: string[], empty: string): void {
  summaryRow(list, label, (value) => {
    if (entries.length === 0) {
      value.setText(empty);
      return;
    }
    const items = value.createEl('ul');
    for (const entry of entries) {
      items.createEl('li', { text: entry });
    }
  });
}

function banner(
  container: HTMLElement,
  title: string,
  body: string,
  error: boolean,
): void {
  const element = container.createDiv({
    cls: `atl-task-brief-banner${error ? ' is-error' : ' is-success'}`,
  });
  element.createDiv({ cls: 'atl-banner-title', text: title });
  element.createDiv({ cls: 'atl-banner-body', text: body });
}

export function renderDispatchInProgress(
  container: HTMLElement,
  options: DispatchProgressViewOptions,
): void {
  container.createEl('h2', { text: '正在交给 Multica…' });
  container.createDiv({ cls: 'atl-task-title', text: options.taskTitle });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: '任务已授权，正在创建唯一的 Multica Issue；请稍候。',
  });
  const progress = container.createDiv({ cls: 'atl-progress-block' });
  const head = progress.createDiv({ cls: 'atl-progress-head' });
  head.createDiv({ cls: 'atl-progress-spinner', attr: { 'aria-hidden': 'true' } });
  head.createDiv({ text: '正在投递到 Multica' });
  const meta = progress.createDiv({
    cls: 'atl-progress-meta',
  });
  meta.append('已用 ');
  meta.createEl('strong', { text: formatElapsed(options.startedAtMs, options.nowMs) });
  meta.append(` · 最长约 ${DISPATCH_EXPECTATION_MINUTES} 分钟，超时会自动转入对账`);

  const lockNote = progress.createDiv({ cls: 'atl-task-brief-banner' });
  lockNote.createDiv({
    cls: 'atl-banner-body',
    text: '投递期间本窗口已锁定、不会重复投递。即使窗口关闭或进程退出，任务也会由后台对账找回唯一绑定，不会产生第二个 Issue。',
  });

  const actions = new Setting(container).setClass('atl-modal-actions');
  actions.addButton((button) => button
    .setButtonText('投递中…')
    .setCta()
    .setDisabled(true));
}

export interface DispatchResultViewOptions {
  view: DispatchResultView;
  taskTitle: string;
  completedAt: string;
  onClose(): void;
  onConflictAcknowledge(): void;
  onRetryFromPalette(): void;
}

export function renderDispatchResult(
  container: HTMLElement,
  options: DispatchResultViewOptions,
): void {
  const { view } = options;
  if (view.status === 'linked') {
    renderLinked(container, options, view);
    return;
  }
  if (view.status === 'reconciling') {
    renderReconciling(container, options);
    return;
  }
  if (view.status === 'conflict') {
    renderConflict(container, options, view);
    return;
  }
  renderFailed(container, options, view);
}

function renderLinked(
  container: HTMLElement,
  options: DispatchResultViewOptions,
  view: Extract<DispatchResultView, { status: 'linked' }>,
): void {
  container.createEl('h2', { text: '已交给 Multica' });
  container.createDiv({ cls: 'atl-task-title', text: options.taskTitle });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: '投递成功，唯一 Issue 已绑定；后续进展不需要留在这个窗口。',
  });
  const summary = summaryList(container);
  summaryRow(summary, 'Multica Issue', (value) => {
    // A legacy bound link may lack the human identifier; fall back to the
    // issue id rather than rendering an empty label.
    value.createEl('strong', { text: view.issueIdentifier || view.issueId });
    value.append(` · ${options.taskTitle}`);
  });
  textRow(summary, '投递时间', formatTimestamp(view.dispatchedAt ?? options.completedAt));
  textRow(summary, '任务状态', 'Agent 可执行（agent_executable）');
  textRow(summary, '后续进展', '执行过程在 Multica；阻塞、关键决策与 RC 验收经钉钉通知，可在原任务查看');
  banner(
    container,
    '投递完成，本窗口可以关闭',
    view.recovered
      ? '唯一 Issue 绑定已确认（由后台对账找回）。原任务会显示 TEP 标识与最新状态投影。'
      : '唯一 Issue 绑定已确认。原任务会显示 TEP 标识与最新状态投影。',
    false,
  );
  const actions = new Setting(container).setClass('atl-modal-actions');
  actions.addButton((button: ButtonComponent) => button
    .setButtonText('完成')
    .setCta()
    .onClick(() => options.onClose()));
}

function renderReconciling(
  container: HTMLElement,
  options: DispatchResultViewOptions,
): void {
  container.createEl('h2', { text: '对账中' });
  container.createDiv({ cls: 'atl-task-title', text: options.taskTitle });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: '远端结果暂时未知，系统正在找回唯一绑定；不需要人工重试。',
  });
  const summary = summaryList(container);
  textRow(summary, 'Multica Issue', '待对账找回');
  textRow(summary, '当前状态', '对账中 · 再次投递已禁用');
  textRow(summary, '预计恢复', '对账周期内自动找回；找回后原任务显示 TEP 标识');
  banner(
    container,
    '为什么不能再次投递？',
    '上一次投递可能已经创建了 Issue。重复投递会产生第二个 Issue；对账会按任务标识找回唯一绑定，多条匹配时才会请求人工处理。',
    false,
  );
  const actions = new Setting(container).setClass('atl-modal-actions');
  actions.addButton((button) => button
    .setButtonText('稍后在原任务查看')
    .onClick(() => options.onClose()));
  actions.addButton((button) => button
    .setButtonText('再次投递')
    .setCta()
    .setDisabled(true));
}

function renderConflict(
  container: HTMLElement,
  options: DispatchResultViewOptions,
  view: Extract<DispatchResultView, { status: 'conflict' }>,
): void {
  container.createEl('h2', { text: '需要人工处理' });
  container.createDiv({ cls: 'atl-task-title', text: options.taskTitle });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: '远端发现多条匹配的 Multica Issue；系统已停止自动执行，不会任选一条绑定。',
  });
  const summary = summaryList(container);
  listRow(summary, '候选 Issue', view.candidateIssueIds, '候选清单见原任务的待处理请求');
  textRow(summary, '任务状态', '冲突待处理（duplicate_conflict）· 自动投递已停止');
  textRow(summary, '下一步', '在原任务的待处理请求中确认保留哪一条 Issue；确认前不再有自动写入');
  banner(
    container,
    '为什么停下来？',
    '对账按任务标识找到多条远端匹配，自动绑定可能选错执行载体。请在原任务中人工确认后继续。',
    true,
  );
  const actions = new Setting(container).setClass('atl-modal-actions');
  actions.addButton((button) => button
    .setButtonText('稍后在原任务处理')
    .onClick(() => options.onConflictAcknowledge()));
  actions.addButton((button) => button
    .setButtonText('知道了')
    .setCta()
    .onClick(() => options.onConflictAcknowledge()));
}

function renderFailed(
  container: HTMLElement,
  options: DispatchResultViewOptions,
  view: Extract<DispatchResultView, { status: 'failed' }>,
): void {
  container.createEl('h2', { text: '投递失败' });
  container.createDiv({ cls: 'atl-task-title', text: options.taskTitle });
  container.createDiv({
    cls: 'atl-task-subtitle',
    text: '这次没有创建 Multica Issue；修正原因后可以重新投递。',
  });
  const summary = summaryList(container);
  textRow(summary, '失败原因', view.reason);
  textRow(summary, '任务状态', '已授权（agent_executable）· 投递未成功，不会自动重试');
  textRow(summary, '建议动作', '根据失败原因修正（如启动 Multica 桌面端并确认已登录），然后从命令面板重新投递；任务信息无需重填');
  banner(
    container,
    '任务没有丢失',
    '授权与全部字段已保存；重新投递仍受唯一性保护，不会产生第二个 Issue。',
    true,
  );
  const actions = new Setting(container).setClass('atl-modal-actions');
  actions.addButton((button) => button
    .setButtonText('关闭')
    .onClick(() => options.onClose()));
  actions.addButton((button) => button
    .setButtonText('稍后从命令面板重投')
    .setCta()
    .onClick(() => options.onRetryFromPalette()));
}
