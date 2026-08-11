import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { ProgressDraft } from '../domain/progress.js';
import type { CreateMaterialGapInput } from '../services/create-material-gap.js';
import {
  type WorkProgressHubController,
  type WorkProgressHubSnapshot,
  type WorkProgressHubState,
  type WorkProgressHubTab,
} from './work-progress-hub-controller.js';

export const WORK_PROGRESS_VIEW_TYPE = 'atl-work-progress';

export interface WorkProgressViewDependencies {
  createController(): WorkProgressHubController;
  openPath(path: string): Promise<void> | void;
  requestWeeklyFeedback(report: WorkProgressHubSnapshot['weeklyReports'][number]):
    Promise<string | null>;
  requestProgressDraft(): Promise<ProgressDraft | null>;
  requestMaterialGap(
    progress: WorkProgressHubSnapshot['progress'],
  ): Promise<CreateMaterialGapInput | null>;
}

const TAB_LABELS: Array<{ tab: WorkProgressHubTab; label: string }> = [
  { tab: 'matches', label: '待匹配听记' },
  { tab: 'progress', label: '工作进展' },
  { tab: 'materials', label: '待补材料' },
  { tab: 'weekly', label: '待验收' },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(value: string | null): string {
  if (value === null) return '未知时间';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(parsed)
    : value;
}

function sourceLabel(status: WorkProgressHubSnapshot['source']['status']): string {
  switch (status) {
    case 'never_scanned': return '千问尚未扫描';
    case 'connected': return '千问已连接';
    case 'login_required': return '千问需要登录';
    case 'incompatible': return '千问页面暂不兼容';
    case 'network_failed': return '千问网络读取失败';
  }
}

function countForTab(snapshot: WorkProgressHubSnapshot, tab: WorkProgressHubTab): number {
  switch (tab) {
    case 'matches': return snapshot.matches.length;
    case 'progress': return snapshot.progress.length;
    case 'materials': return snapshot.materialGaps.length;
    case 'weekly': return snapshot.acceptanceObjects.length;
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    available: '原文可用',
    waiting: '等待转写',
    failed: '读取失败',
    draft: '草稿',
    needs_material: '待补材料',
    needs_contact: '待确认联系人',
    resolved: '已补齐',
    eligible: '可入周报',
    included: '已纳入',
    pending: '待验收',
    accepted: '已通过',
    rejected: '已退回',
    later: '稍后处理',
    complete: '完整',
    partial_success: '部分完成',
  };
  return labels[status] ?? status;
}

function notificationLabel(
  notification: WorkProgressHubSnapshot['acceptanceObjects'][number]['notification'],
): string {
  if (notification === null) return '钉钉通知：未配置';
  switch (notification.status) {
    case 'sent': return `钉钉通知：已发送 · ${formatTime(notification.attemptedAt)}`;
    case 'conflict': return '钉钉通知：定位冲突';
    case 'failed': return `钉钉通知：发送失败（${notification.errorCode ?? 'unknown_error'}）`;
  }
}

export class WorkProgressView extends ItemView {
  private controller: WorkProgressHubController | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly dependencies: WorkProgressViewDependencies,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return WORK_PROGRESS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return '工作沉淀';
  }

  getIcon(): string {
    return 'notebook-tabs';
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add('atl-work-progress-view');
    this.controller = this.dependencies.createController();
    this.unsubscribe = this.controller.subscribe((state) => this.render(state));
    await this.controller.initialize();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.dispose();
    this.controller = null;
    this.contentEl.replaceChildren();
  }

  refresh(): Promise<void> {
    return this.controller?.refresh() ?? Promise.resolve();
  }

  private render(state: WorkProgressHubState): void {
    const root = element('div', 'atl-work-progress-shell');
    root.append(this.renderHeader(state));
    if (state.status === 'error' && state.snapshot === null) {
      root.append(element(
        'div',
        'atl-work-progress-empty atl-form-error',
        `工作沉淀读取失败：${state.errorCode ?? 'unknown_error'}`,
      ));
    } else if (state.snapshot === null) {
      root.append(element('div', 'atl-work-progress-empty', '正在读取工作沉淀…'));
    } else {
      root.append(this.renderBody(state, state.snapshot));
      root.append(this.renderSourceStatus(state, state.snapshot));
    }
    this.contentEl.replaceChildren(root);
  }

  private renderHeader(state: WorkProgressHubState): HTMLElement {
    const header = element('header', 'atl-work-progress-header');
    const heading = element('div', 'atl-work-progress-heading');
    heading.append(element('h1', 'atl-work-progress-title', '工作沉淀'));
    heading.append(element(
      'p',
      'atl-work-progress-subtitle',
      '从会议证据到项目进展与产物验收',
    ));
    const actions = element('div', 'atl-work-progress-header-actions');
    const generate = element(
      'button',
      'mod-cta atl-work-progress-generate-weekly',
      '生成本周周报',
    );
    generate.type = 'button';
    generate.dataset.action = 'generate-weekly';
    generate.disabled = state.busyAction !== null || state.status === 'loading';
    generate.addEventListener('click', () => {
      void this.controller?.generateCurrentWeeklyReport().catch(() => undefined);
    });
    const refresh = element('button', 'clickable-icon atl-work-progress-refresh');
    refresh.type = 'button';
    refresh.title = '刷新工作沉淀';
    refresh.setAttribute('aria-label', '刷新工作沉淀');
    refresh.disabled = state.busyAction !== null || state.status === 'loading';
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => {
      void this.controller?.refresh().catch(() => undefined);
    });
    actions.append(generate, refresh);
    header.append(heading, actions);

    const tabs = element('div', 'atl-work-progress-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '工作沉淀视图');
    for (const { tab, label } of TAB_LABELS) {
      const button = element('button', 'atl-work-progress-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(state.activeTab === tab));
      button.dataset.tab = tab;
      button.append(element('span', undefined, label));
      if (state.snapshot !== null) {
        button.append(element(
          'span',
          'atl-work-progress-tab-count',
          String(countForTab(state.snapshot, tab)),
        ));
      }
      button.addEventListener('click', () => this.controller?.setActiveTab(tab));
      tabs.append(button);
    }
    const shell = element('div', 'atl-work-progress-header-shell');
    shell.append(header, tabs);
    return shell;
  }

  private renderBody(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const body = element('main', 'atl-work-progress-body');
    if (state.errorCode !== null) {
      body.append(element(
        'div',
        'atl-work-progress-inline-error atl-form-error',
        `操作未完成：${state.errorCode}`,
      ));
    }
    switch (state.activeTab) {
      case 'matches': body.append(this.renderMatches(state, snapshot)); break;
      case 'progress': body.append(this.renderProgress(state, snapshot)); break;
      case 'materials': body.append(this.renderMaterials(state, snapshot)); break;
      case 'weekly': body.append(this.renderWeekly(state, snapshot)); break;
    }
    return body;
  }

  private renderMatches(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const list = element('section', 'atl-work-progress-list atl-work-progress-matches');
    if (snapshot.matches.length === 0) {
      list.append(element('p', 'atl-work-progress-empty', '当前没有已采集的听记。'));
      return list;
    }
    for (const item of snapshot.matches) {
      const card = element('article', 'atl-work-progress-card atl-work-progress-match');
      const title = element('div', 'atl-work-progress-card-title');
      title.append(element('h2', undefined, item.title));
      title.append(element('span', 'atl-work-progress-status', statusLabel(item.status)));
      card.append(title);
      card.append(element('p', 'atl-work-progress-meta', formatTime(item.createdAt)));
      if (item.activeDecision !== null) {
        const action = item.activeDecision.action === 'confirmed'
          ? '已确认日程匹配'
          : '已标记无对应日程';
        card.append(element('p', 'atl-work-progress-decision', action));
        const revoke = element('button', 'mod-muted', '撤销决定');
        revoke.type = 'button';
        revoke.dataset.action = 'revoke-match';
        revoke.disabled = state.busyAction !== null;
        revoke.addEventListener('click', () => {
          void this.controller?.revokeDecision(item.activeDecision!.decisionId)
            .catch(() => undefined);
        });
        card.append(revoke);
        list.append(card);
        continue;
      }
      if (item.candidates.length === 0) {
        card.append(element(
          'p',
          'atl-work-progress-empty',
          item.status === 'waiting' ? '听记仍在转写，暂不匹配。' : '没有达到阈值的日程候选。',
        ));
      }
      for (const candidate of item.candidates) {
        const candidateRow = element('label', 'atl-work-progress-candidate');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `work-progress-match-${item.recordingId}`;
        input.checked = state.selectedCandidate?.recordingId === item.recordingId
          && state.selectedCandidate.eventKeyHash === candidate.eventKeyHash;
        input.addEventListener('click', () => {
          this.controller?.selectCandidate(item.recordingId, candidate.eventKeyHash);
        });
        const details = element('div', 'atl-work-progress-candidate-body');
        details.append(element('strong', undefined, candidate.title));
        details.append(element(
          'span',
          'atl-work-progress-meta',
          `${formatTime(candidate.scheduled)} · ${(candidate.score * 100).toFixed(0)}%`,
        ));
        details.append(this.renderEvidence('支持', candidate.support, 'support'));
        details.append(this.renderEvidence('反对', candidate.opposition, 'opposition'));
        details.append(this.renderEvidence('缺失', candidate.missing, 'missing'));
        const open = element('button', 'clickable-icon atl-work-progress-open');
        open.type = 'button';
        open.title = '打开日程来源';
        open.setAttribute('aria-label', '打开日程来源');
        open.dataset.openPath = candidate.eventPath;
        setIcon(open, 'external-link');
        open.addEventListener('click', (event) => {
          event.preventDefault();
          void this.dependencies.openPath(candidate.eventPath);
        });
        candidateRow.append(input, details, open);
        card.append(candidateRow);
      }
      const actions = element('div', 'atl-work-progress-actions');
      const confirm = element('button', 'mod-cta', '确认匹配');
      confirm.type = 'button';
      confirm.dataset.action = 'confirm-match';
      confirm.disabled = state.busyAction !== null
        || state.selectedCandidate?.recordingId !== item.recordingId;
      confirm.addEventListener('click', () => {
        void this.controller?.confirmSelectedMatch().catch(() => undefined);
      });
      const noCalendar = element('button', 'mod-muted', '无对应日程');
      noCalendar.type = 'button';
      noCalendar.dataset.action = 'no-calendar';
      noCalendar.disabled = state.busyAction !== null;
      noCalendar.addEventListener('click', () => {
        void this.controller?.markSelectedRecordingWithoutCalendar(item.recordingId)
          .catch(() => undefined);
      });
      actions.append(confirm, noCalendar);
      card.append(actions);
      list.append(card);
    }
    return list;
  }

  private renderEvidence(label: string, items: string[], kind: string): HTMLElement {
    const row = element('div', `atl-work-progress-evidence atl-work-progress-evidence-${kind}`);
    row.append(element('span', 'atl-work-progress-evidence-label', label));
    row.append(element('span', undefined, items.length === 0 ? '无' : items.join('；')));
    return row;
  }

  private renderProgress(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const section = element('section', 'atl-work-progress-section');
    const actions = element('div', 'atl-work-progress-section-actions');
    const create = element('button', 'mod-cta', '新建进展');
    create.type = 'button';
    create.dataset.action = 'create-progress';
    create.disabled = state.busyAction !== null;
    create.addEventListener('click', () => {
      void this.createProgress().catch(() => undefined);
    });
    actions.append(create);
    section.append(actions, this.renderPersistedList(snapshot.progress.map((item) => ({
      key: item.progressId,
      title: item.topic,
      meta: `${item.projectId ?? '待确认项目'} · v${item.version}`,
      status: statusLabel(item.lifecycleStatus),
      path: item.path,
    })), '当前没有工作进展版本。'));
    return section;
  }

  private renderMaterials(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const section = element('section', 'atl-work-progress-section');
    const actions = element('div', 'atl-work-progress-section-actions');
    const create = element('button', 'mod-cta', '登记缺口');
    create.type = 'button';
    create.dataset.action = 'create-material-gap';
    create.disabled = state.busyAction !== null || snapshot.progress.length === 0;
    create.addEventListener('click', () => {
      void this.createMaterialGap(snapshot.progress).catch(() => undefined);
    });
    actions.append(create);
    section.append(actions, this.renderPersistedList(snapshot.materialGaps.map((item) => ({
      key: item.gapId,
      title: item.title,
      meta: item.gapId,
      status: statusLabel(item.status),
      path: item.path,
    })), '当前没有待补材料。'));
    return section;
  }

  private async createProgress(): Promise<void> {
    const draft = await this.dependencies.requestProgressDraft();
    if (draft === null) return;
    await this.controller?.createProgressVersion(draft);
  }

  private async createMaterialGap(
    progress: WorkProgressHubSnapshot['progress'],
  ): Promise<void> {
    const input = await this.dependencies.requestMaterialGap(progress);
    if (input === null) return;
    await this.controller?.registerMaterialGap(input);
  }

  private renderPersistedList(
    items: Array<{ key: string; title: string; meta: string; status: string; path: string }>,
    empty: string,
  ): HTMLElement {
    const list = element('section', 'atl-work-progress-list');
    if (items.length === 0) {
      list.append(element('p', 'atl-work-progress-empty', empty));
      return list;
    }
    for (const item of items) {
      const button = element('button', 'atl-work-progress-row');
      button.type = 'button';
      button.dataset.openPath = item.path;
      button.dataset.objectId = item.key;
      const copy = element('span', 'atl-work-progress-row-copy');
      copy.append(element('strong', undefined, item.title));
      copy.append(element('span', 'atl-work-progress-meta', item.meta));
      button.append(copy, element('span', 'atl-work-progress-status', item.status));
      button.addEventListener('click', () => {
        void this.dependencies.openPath(item.path);
      });
      list.append(button);
    }
    return list;
  }

  private renderWeekly(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const list = element('section', 'atl-work-progress-list');
    if (snapshot.acceptanceObjects.length === 0) {
      list.append(element('p', 'atl-work-progress-empty', '当前没有待验收对象。'));
      return list;
    }
    for (const object of snapshot.acceptanceObjects) {
      const card = element('article', 'atl-work-progress-card atl-work-progress-weekly');
      const title = element('div', 'atl-work-progress-card-title');
      title.append(element('h2', undefined, object.title));
      title.append(element(
        'span',
        'atl-work-progress-status',
        statusLabel(object.state),
      ));
      card.append(title);
      card.append(element(
        'p',
        'atl-work-progress-meta',
        `${object.objectType === 'artifact' ? 'Artifact' : '周报'} · v${object.version} · ${object.pendingCount} 项待确认`,
      ));
      card.append(element(
        'p',
        'atl-work-progress-meta atl-work-progress-notification',
        notificationLabel(object.notification),
      ));
      const open = element(
        'button',
        'mod-muted',
        object.objectType === 'artifact' ? '打开 Artifact' : '打开周报',
      );
      open.type = 'button';
      open.dataset.openPath = object.path;
      open.addEventListener('click', () => void this.dependencies.openPath(object.path));
      card.append(open);
      const report = object.objectType === 'weekly'
        ? snapshot.weeklyReports.find((candidate) => (
          candidate.weeklyId === object.objectId && candidate.version === object.version
        ))
        : undefined;
      if (report !== undefined) {
        const actions = element('div', 'atl-work-progress-actions');
        const accept = element('button', 'mod-cta', '通过本版');
        accept.type = 'button';
        accept.dataset.action = 'accept-weekly';
        accept.disabled = state.busyAction !== null;
        accept.addEventListener('click', () => {
          void this.controller?.acceptWeeklyReport(report.weeklyId, report.version)
            .catch(() => undefined);
        });
        const reject = element('button', 'mod-warning', '退回修改');
        reject.type = 'button';
        reject.dataset.action = 'reject-weekly';
        reject.disabled = state.busyAction !== null;
        reject.addEventListener('click', () => {
          void this.rejectWeekly(report);
        });
        const later = element('button', 'mod-muted', '稍后处理');
        later.type = 'button';
        later.dataset.action = 'defer-weekly';
        later.disabled = state.busyAction !== null;
        later.addEventListener('click', () => {
          void this.controller?.deferWeeklyReport(report.weeklyId, report.version)
            .catch(() => undefined);
        });
        actions.append(accept, reject, later);
        card.append(actions);
      }
      list.append(card);
    }
    return list;
  }

  private async rejectWeekly(
    report: WorkProgressHubSnapshot['weeklyReports'][number],
  ): Promise<void> {
    const feedback = await this.dependencies.requestWeeklyFeedback(report);
    if (feedback === null || feedback.trim() === '') return;
    await this.controller?.rejectWeeklyReport(report.weeklyId, report.version, feedback.trim())
      .catch(() => undefined);
  }

  private renderSourceStatus(
    state: WorkProgressHubState,
    snapshot: WorkProgressHubSnapshot,
  ): HTMLElement {
    const footer = element('footer', 'atl-work-progress-source');
    const copy = element('div', 'atl-work-progress-source-copy');
    copy.append(element(
      'strong',
      `atl-work-progress-source-${snapshot.source.status}`,
      sourceLabel(snapshot.source.status),
    ));
    copy.append(element(
      'span',
      'atl-work-progress-meta',
      `最近扫描 ${formatTime(snapshot.source.scannedAt)} · 可用 ${snapshot.source.available} · 等待 ${snapshot.source.waiting} · 失败 ${snapshot.source.failed}`,
    ));
    footer.append(copy);
    if (snapshot.source.status !== 'connected') {
      const retry = element('button', 'mod-cta', '重新同步');
      retry.type = 'button';
      retry.dataset.action = 'retry-source';
      retry.disabled = state.busyAction !== null;
      retry.addEventListener('click', () => {
        void this.controller?.retrySource().catch(() => undefined);
      });
      footer.append(retry);
    }
    return footer;
  }
}
