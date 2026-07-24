import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { ContributionRange } from '../services/query-contribution.js';
import type { PersonalHomeTask } from '../services/query-personal-home.js';
import {
  type ContributionDashboardController,
  type ContributionDashboardState,
} from './contribution-dashboard-controller.js';

export const WORK_CONTRIBUTION_VIEW_TYPE = 'atl-work-contribution';

export interface WorkContributionViewDependencies {
  createController: () => ContributionDashboardController;
  openTask: (taskId: string) => Promise<void> | void;
  openArtifact: (artifactRef: string, taskId: string) => Promise<void> | void;
  openSettings: () => Promise<void> | void;
}

type HomeTab = 'overview' | 'today' | 'input' | 'review';
type PulseMode = 'tasks' | 'consumption' | 'outputs' | 'ai';

const RANGE_OPTIONS: Array<{ value: ContributionRange; label: string }> = [
  { value: '7d', label: '7 天' },
  { value: '26w', label: '26 周' },
  { value: '1y', label: '1 年' },
];

const TAB_OPTIONS: Array<{ value: HomeTab; label: string; icon: string }> = [
  { value: 'overview', label: '总览', icon: 'layout-dashboard' },
  { value: 'today', label: '推进', icon: 'list-checks' },
  { value: 'input', label: '输入', icon: 'inbox' },
  { value: 'review', label: '复盘', icon: 'chart-no-axes-combined' },
];

const PULSE_OPTIONS: Array<{ value: PulseMode; label: string }> = [
  { value: 'tasks', label: '任务' },
  { value: 'consumption', label: '消费' },
  { value: 'outputs', label: '产出' },
  { value: 'ai', label: 'AI' },
];

const PULSE_HEATMAP_LABELS: Record<Exclude<PulseMode, 'consumption'>, string> = {
  tasks: '任务',
  outputs: '产出',
  ai: 'AI',
};

const STATUS_LABELS: Record<string, string> = {
  inbox: '收件箱',
  ready: '待执行',
  in_progress: '执行中',
  review: '待验收',
  blocked: '已阻塞',
};

const PRIORITY_LABELS: Record<PersonalHomeTask['priority'], string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

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

function section(title: string, className: string): {
  root: HTMLElement;
  body: HTMLElement;
} {
  const root = element('section', `atl-contribution-section ${className}`);
  root.append(element('h2', 'atl-contribution-section-title', title));
  const body = element('div', 'atl-contribution-section-body');
  root.append(body);
  return { root, body };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(parsed)
    : '--';
}

function formatCompactDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    month: '2-digit',
  }).format(parsed).replace('/', '·');
}

function mondayBasedWeekday(date: string): number {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function lineChart(values: number[], label: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('atl-contribution-chart-svg');
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const maximum = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 36 - (value / maximum) * 30;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('vector-effect', 'non-scaling-stroke');
  polyline.classList.add('atl-contribution-chart-line');
  svg.append(polyline);
  return svg;
}

function tokenStatusText(state: ContributionDashboardState): string {
  switch (state.token.status) {
    case 'ready': return 'OpenToken 已更新';
    case 'cached': return '正在更新 OpenToken';
    case 'stale': return 'OpenToken 缓存已过期';
    case 'missing': return '未检测到 OpenToken';
    case 'error': return 'OpenToken 暂时不可用';
    case 'loading': return '正在读取 OpenToken';
  }
}

function contributionStatusText(state: ContributionDashboardState): string {
  switch (state.contribution.status) {
    case 'ready': return 'ATL 任务已读取';
    case 'error': return state.contribution.snapshot === null
      ? 'ATL 任务读取失败'
      : 'ATL 任务数据可能已过期';
    case 'loading': return 'ATL 任务读取中';
  }
}

function pulseLevel(value: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / maximum) * 4))) as 1 | 2 | 3 | 4;
}

export class WorkContributionView extends ItemView {
  private readonly dependencies: WorkContributionViewDependencies;
  private controller: ContributionDashboardController | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: ContributionDashboardState | null = null;
  private activeTab: HomeTab = 'overview';
  private pulseMode: PulseMode = 'tasks';

  constructor(
    leaf: WorkspaceLeaf,
    dependencies: WorkContributionViewDependencies,
  ) {
    super(leaf);
    this.dependencies = dependencies;
  }

  getViewType(): string {
    return WORK_CONTRIBUTION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'ClawVault 个人首页';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add('atl-contribution-view');
    this.controller = this.dependencies.createController();
    this.unsubscribe = this.controller.subscribe((state) => {
      this.state = state;
      this.render(state);
    });
    await this.controller.initialize();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.dispose();
    this.controller = null;
    this.state = null;
    this.contentEl.replaceChildren();
  }

  refreshContribution(): Promise<void> {
    return this.controller?.refreshContribution() ?? Promise.resolve();
  }

  private render(state: ContributionDashboardState): void {
    const root = element('div', 'atl-contribution-shell atl-home-app-shell');
    root.append(this.renderSidebar(state));
    const main = element('div', 'atl-home-main');
    const scroll = element('div', 'atl-home-main-scroll');
    scroll.append(this.renderActiveView(state));
    main.append(scroll);
    root.append(main);
    this.contentEl.replaceChildren(root);
  }

  private rerender(): void {
    if (this.state !== null) this.render(this.state);
  }

  private renderSidebar(state: ContributionDashboardState): HTMLElement {
    const sidebar = element('aside', 'atl-home-sidebar');
    const brand = element('header', 'atl-home-sidebar-brand');
    brand.append(element('span', 'atl-home-brand-mark', 'CV'));
    const identity = element('div', 'atl-contribution-identity');
    identity.append(element('h1', 'atl-contribution-title', 'ClawVault'));
    identity.append(element('p', 'atl-contribution-subtitle', '个人工作台'));
    brand.append(identity);
    sidebar.append(brand, this.renderTabs(state));

    const footer = element('footer', 'atl-home-sidebar-footer');
    const sources = element('div', 'atl-contribution-sources');
    sources.append(element(
      'span',
      `atl-contribution-source atl-contribution-source-${state.contribution.status}`,
      contributionStatusText(state),
    ));
    sources.append(element(
      'span',
      `atl-contribution-source atl-contribution-source-${state.token.status}`,
      tokenStatusText(state),
    ));
    footer.append(sources);

    const actions = element('div', 'atl-home-sidebar-actions');
    const settings = element('button', 'atl-home-settings');
    settings.type = 'button';
    settings.setAttribute('aria-label', '工作台设置');
    setIcon(settings, 'sliders-horizontal');
    settings.append(element('span', undefined, '工作台设置'));
    settings.addEventListener('click', () => {
      void this.dependencies.openSettings();
    });

    const refresh = element('button', 'clickable-icon atl-contribution-refresh');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', '刷新数据');
    refresh.title = '刷新数据';
    refresh.disabled = state.refreshing;
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => {
      void this.controller?.refreshAll();
    });
    actions.append(settings, refresh);
    footer.append(actions);
    sidebar.append(footer);
    return sidebar;
  }

  private renderTabs(state: ContributionDashboardState): HTMLElement {
    const tabs = element('nav', 'atl-home-tabs');
    tabs.setAttribute('aria-label', '个人首页视图');
    for (const option of TAB_OPTIONS) {
      const button = element('button', 'atl-home-tab');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(this.activeTab === option.value));
      const icon = element('span', 'atl-home-tab-icon');
      setIcon(icon, option.icon);
      button.append(icon, element('span', 'atl-home-tab-label', option.label));
      const count = option.value === 'input'
        ? state.home.snapshot?.counts.inbox
        : option.value === 'review'
          ? state.home.snapshot?.counts.review
          : undefined;
      if (count !== undefined) {
        button.append(element('span', 'atl-home-tab-count', formatNumber(count)));
      }
      button.addEventListener('click', () => {
        this.activeTab = option.value;
        this.rerender();
      });
      tabs.append(button);
    }
    return tabs;
  }

  private renderActiveView(state: ContributionDashboardState): HTMLElement {
    switch (this.activeTab) {
      case 'today': return this.renderToday(state);
      case 'input': return this.renderInput(state);
      case 'review': return this.renderReview(state);
      case 'overview': return this.renderOverview(state);
    }
  }

  private renderOverview(state: ContributionDashboardState): HTMLElement {
    const view = element('main', 'atl-home-view atl-home-view-overview');
    view.append(this.renderPulse(state));
    view.append(this.renderFocus(state));
    view.append(this.renderOverviewMetrics(state));
    view.append(this.renderNextAction(state));
    view.append(this.renderOverviewLower(state));
    return view;
  }

  private renderPulse(state: ContributionDashboardState): HTMLElement {
    const pulse = element('section', 'atl-home-pulse');
    const heading = element('div', 'atl-home-pulse-heading');
    const title = element('div');
    title.append(element('p', 'atl-home-eyebrow', 'PERSONAL PULSE'));
    const rangeLabel = RANGE_OPTIONS.find((option) => option.value === state.range)?.label ?? '26 周';
    title.append(element('h2', 'atl-home-pulse-title', `最近 ${rangeLabel}`));

    const controls = element('div', 'atl-contribution-controls');
    const ranges = element('div', 'atl-contribution-ranges');
    ranges.setAttribute('role', 'group');
    ranges.setAttribute('aria-label', '统计范围');
    for (const option of RANGE_OPTIONS) {
      const button = element('button', 'atl-contribution-range', option.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.range === option.value));
      button.addEventListener('click', () => {
        void this.controller?.setRange(option.value);
      });
      ranges.append(button);
    }
    const modes = element('div', 'atl-pulse-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '贡献类型');
    for (const option of PULSE_OPTIONS) {
      const button = element('button', 'atl-pulse-mode', option.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(this.pulseMode === option.value));
      button.addEventListener('click', () => {
        this.pulseMode = option.value;
        this.rerender();
      });
      modes.append(button);
    }
    controls.append(modes, ranges);
    heading.append(title, controls);
    pulse.append(heading);

    const body = element('div', 'atl-home-pulse-body');
    if (this.pulseMode === 'consumption') {
      body.classList.add('is-consumption');
      const pending = element('div', 'atl-home-consumption-pending');
      pending.append(element('strong', undefined, '文章消费标记待接入'));
      pending.append(element(
        'span',
        undefined,
        '首页暂不推测文章是否被消费，后续以你的重要度与个人判断为准。',
      ));
      body.append(pending);
    } else {
      body.append(this.renderHeatmap(state), this.renderPulseSummary(state));
    }
    pulse.append(body);
    if (this.pulseMode !== 'consumption') {
      pulse.append(this.renderTrends(state));
    }
    return pulse;
  }

  private renderHeatmap(state: ContributionDashboardState): HTMLElement {
    const wrapper = element('div', 'atl-contribution-heatmap-scroll');
    const snapshot = state.contribution.snapshot;
    if (snapshot === null) {
      wrapper.append(element(
        'p',
        'atl-contribution-empty',
        state.contribution.status === 'error'
          ? '暂时无法读取完成记录，请稍后刷新。'
          : '正在读取完成记录…',
      ));
      return wrapper;
    }

    const tokenByDate = new Map(
      (state.token.snapshot?.days ?? []).map((day) => [day.date, day.normalized]),
    );
    const values = snapshot.days.map((day) => {
      if (this.pulseMode === 'outputs') return day.outputCount;
      if (this.pulseMode === 'ai') return tokenByDate.get(day.date) ?? 0;
      return day.completed;
    });
    const maximum = Math.max(...values, 0);
    const grid = element('div', 'atl-contribution-heatmap');
    grid.dataset.range = snapshot.range;
    const mode = this.pulseMode === 'consumption' ? 'tasks' : this.pulseMode;
    grid.setAttribute('aria-label', `${PULSE_HEATMAP_LABELS[mode]}每日贡献图`);
    const firstDay = snapshot.days[0];
    const firstRow = firstDay === undefined ? 1 : mondayBasedWeekday(firstDay.date);
    for (const [index, day] of snapshot.days.entries()) {
      const value = values[index] ?? 0;
      const level = this.pulseMode === 'tasks'
        ? day.level
        : pulseLevel(value, maximum);
      const button = element(
        'button',
        `atl-contribution-day atl-contribution-level-${level} atl-pulse-${this.pulseMode}`,
      );
      button.type = 'button';
      button.dataset.date = day.date;
      const valueLabel = mode === 'tasks'
        ? `${day.completed} 个完成任务，${day.projectCount} 个项目`
        : mode === 'outputs'
          ? `${value} 个有效产出`
          : `${formatNumber(value)} Normalized Token`;
      button.setAttribute('aria-label', `${day.date}，${valueLabel}`);
      button.title = `${day.date} · ${valueLabel}`;
      button.style.gridRow = String(mondayBasedWeekday(day.date));
      button.style.gridColumn = String(Math.floor((firstRow - 1 + index) / 7) + 1);
      if (state.selectedDate === day.date) {
        button.classList.add('is-selected');
        button.setAttribute('aria-current', 'date');
      }
      button.addEventListener('click', () => {
        void this.controller?.setSelectedDate(day.date);
      });
      grid.append(button);
    }
    wrapper.append(grid);
    return wrapper;
  }

  private renderPulseSummary(state: ContributionDashboardState): HTMLElement {
    const snapshot = state.contribution.snapshot;
    const today = snapshot?.days.at(-1)?.date;
    const tokenToday = state.token.snapshot?.days.find((day) => day.date === today);
    const values = [
      ['本周完成', snapshot === null ? '--' : `${formatNumber(snapshot.kpis.completedThisWeek)} 项`],
      ['今日完成', snapshot === null ? '--' : `${formatNumber(snapshot.kpis.completedToday)} 项`],
      ['今日 Token', tokenToday === undefined ? '--' : formatNumber(tokenToday.normalized)],
    ];
    const summary = element('div', 'atl-home-pulse-summary');
    const hero = element('div', 'atl-home-pulse-hero');
    hero.append(element(
      'strong',
      undefined,
      snapshot === null ? '--' : `${formatNumber(snapshot.kpis.currentStreak)} 天`,
    ));
    hero.append(element('span', undefined, '当前连续推进'));
    summary.append(hero);

    const details = element('div', 'atl-home-pulse-details');
    for (const [label, value] of values) {
      const item = element('div', 'atl-home-pulse-detail');
      item.append(element('span', undefined, label));
      item.append(element('strong', undefined, value));
      details.append(item);
    }
    summary.append(details);
    if ((snapshot?.coverage.historicalCompletionDateUnavailable ?? 0) > 0) {
      summary.append(element(
        'p',
        'atl-contribution-coverage',
        `${snapshot!.coverage.historicalCompletionDateUnavailable} 个历史完成任务缺少可核对日期。`,
      ));
    }
    return summary;
  }

  private renderTrends(state: ContributionDashboardState): HTMLElement {
    const taskDays = state.contribution.snapshot?.days ?? [];
    const tokenByDate = new Map(
      (state.token.snapshot?.days ?? []).map((day) => [day.date, day]),
    );
    const definitions = [
      {
        title: '完成任务',
        value: taskDays.reduce((sum, day) => sum + day.completed, 0),
        values: taskDays.map((day) => day.completed),
        label: '每日完成任务趋势',
        className: 'is-task atl-contribution-chart',
      },
      {
        title: '有效产出',
        value: taskDays.reduce((sum, day) => sum + day.outputCount, 0),
        values: taskDays.map((day) => day.outputCount),
        label: '每日有效产出趋势',
        className: 'is-output',
      },
      {
        title: 'Normalized Token',
        value: taskDays.reduce((sum, day) => sum + (tokenByDate.get(day.date)?.normalized ?? 0), 0),
        values: taskDays.map((day) => tokenByDate.get(day.date)?.normalized ?? 0),
        label: '每日 Normalized Token 趋势',
        className: 'is-token atl-contribution-chart',
      },
    ];
    const grid = element('div', 'atl-home-trends');
    for (const definition of definitions) {
      const chart = element('div', `atl-home-trend ${definition.className}`);
      const caption = element('div', 'atl-contribution-chart-caption');
      caption.append(element('span', 'atl-contribution-chart-title', definition.title));
      caption.append(element('strong', 'atl-contribution-chart-total', formatNumber(definition.value)));
      chart.append(caption, lineChart(definition.values, definition.label));
      grid.append(chart);
    }
    return grid;
  }

  private renderFocus(state: ContributionDashboardState): HTMLElement {
    const area = this.renderCommandSection(
      'CURRENT FOCUS · 系统候选',
      '当前最值得推进的三件事',
      'atl-home-focus',
    );
    const tasks = state.home.snapshot?.focusTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当前没有执行中或待执行任务'));
    } else {
      const grid = element('div', 'atl-home-focus-grid');
      for (const [index, task] of tasks.slice(0, 3).entries()) {
        const card = element('button', 'atl-home-focus-card');
        card.type = 'button';
        card.dataset.taskId = task.taskId;
        const top = element('span', 'atl-home-focus-top');
        top.append(element(
          'span',
          'atl-home-focus-number',
          String(index + 1).padStart(2, '0'),
        ));
        top.append(element(
          'span',
          `atl-home-task-status is-${task.status}`,
          STATUS_LABELS[task.status] ?? task.status,
        ));
        const title = element(
          'strong',
          'atl-home-focus-name',
          task.title.trim() === '' ? '未命名任务' : task.title,
        );
        const meta = element('span', 'atl-home-focus-meta');
        meta.append(
          element('span', undefined, task.projectName),
          element('span', undefined, `${task.artifactCount} 个产出`),
        );
        card.append(top, title, meta);
        card.addEventListener('click', () => {
          void this.dependencies.openTask(task.taskId);
        });
        grid.append(card);
      }
      area.body.append(grid);
    }
    return area.root;
  }

  private renderOverviewMetrics(state: ContributionDashboardState): HTMLElement {
    const counts = state.home.snapshot?.counts;
    const inboxTasks = state.home.snapshot?.inboxTasks ?? [];
    const highPriority = inboxTasks.filter((task) => (
      task.priority === 'urgent' || task.priority === 'high'
    )).length;
    const activeCount = counts === undefined
      ? null
      : counts.ready + counts.inProgress + counts.review;
    const health = [
      state.contribution.status === 'ready',
      state.home.status === 'ready',
      state.token.status === 'ready' || state.token.status === 'cached',
    ];
    const healthySources = health.filter(Boolean).length;
    const attentionSources = health.length - healthySources;
    const definitions = [
      {
        eyebrow: 'INPUT DEBT',
        title: '输入积压',
        icon: 'inbox',
        value: counts === undefined ? '--' : formatNumber(counts.inbox),
        tone: 'is-coral',
        detail: counts === undefined
          ? '正在读取收件箱'
          : `${formatNumber(highPriority)} 条高优先级 · ${formatNumber(counts.inbox)} 条等待判断`,
        action: '去处理输入',
        tab: 'input' as const,
      },
      {
        eyebrow: 'TASK FLOW',
        title: '任务流转',
        icon: 'workflow',
        value: activeCount === null ? '--' : formatNumber(activeCount),
        tone: 'is-green',
        detail: counts === undefined
          ? '正在读取任务状态'
          : `${formatNumber(counts.ready)} 待执行 · ${formatNumber(counts.inProgress)} 执行中 · ${formatNumber(counts.review)} 待验收`,
        action: '查看推进任务',
        tab: 'today' as const,
      },
      {
        eyebrow: 'SYSTEM STATUS',
        title: '系统状态',
        icon: 'activity',
        value: `${healthySources}/${health.length}`,
        tone: attentionSources === 0 ? 'is-green' : 'is-amber',
        detail: attentionSources === 0
          ? 'ATL、任务首页与 OpenToken 正常'
          : `${formatNumber(attentionSources)} 个数据源需要关注`,
        action: '查看运行状态',
        tab: 'review' as const,
      },
    ];
    const root = element('section', 'atl-contribution-section atl-home-metrics');
    const grid = element('div', 'atl-home-metric-grid');
    for (const definition of definitions) {
      const card = element('article', 'atl-home-metric-cell');
      const heading = element('div', 'atl-home-metric-heading');
      const copy = element('div');
      copy.append(
        element('p', 'atl-home-eyebrow', definition.eyebrow),
        element('h2', 'atl-home-section-title', definition.title),
      );
      const icon = element('span', 'atl-home-metric-icon');
      setIcon(icon, definition.icon);
      heading.append(copy, icon);
      card.append(
        heading,
        element('strong', `atl-home-metric-value ${definition.tone}`, definition.value),
        element('p', 'atl-home-metric-detail', definition.detail),
      );
      const action = element('button', 'atl-home-mini-action', `${definition.action} →`);
      action.type = 'button';
      action.addEventListener('click', () => {
        this.activeTab = definition.tab;
        this.rerender();
      });
      card.append(action);
      grid.append(card);
    }
    root.append(grid);
    return root;
  }

  private renderTaskFlow(state: ContributionDashboardState): HTMLElement {
    const area = section('任务流', 'atl-home-task-flow-section');
    const counts = state.home.snapshot?.counts;
    const values: Array<[string, number | null]> = [
      ['收件箱', counts?.inbox ?? null],
      ['待执行', counts?.ready ?? null],
      ['执行中', counts?.inProgress ?? null],
      ['待验收', counts?.review ?? null],
      ['已阻塞', counts?.blocked ?? null],
    ];
    const flow = element('div', 'atl-home-task-flow');
    for (const [label, value] of values) {
      const item = element('div', 'atl-home-task-flow-item');
      item.append(element('strong', undefined, value === null ? '--' : formatNumber(value)));
      item.append(element('span', undefined, label));
      flow.append(item);
    }
    area.body.append(flow);
    return area.root;
  }

  private renderNextAction(state: ContributionDashboardState): HTMLElement {
    const area = this.renderCommandSection(
      'NEXT ACTION',
      '现在最值得做什么',
      'atl-home-next-action',
    );
    const task = state.home.snapshot?.nextAction ?? null;
    if (task === null) {
      area.body.append(element('p', 'atl-contribution-empty', '先从收件箱确认一个任务'));
    } else {
      const card = element('div', 'atl-home-next-action-card');
      const status = element(
        'span',
        `atl-home-task-status is-${task.status}`,
        STATUS_LABELS[task.status] ?? task.status,
      );
      const copy = element('div', 'atl-home-next-action-copy');
      copy.append(
        element(
          'strong',
          'atl-home-next-action-title',
          task.title.trim() === '' ? '未命名任务' : task.title,
        ),
        element(
          'span',
          'atl-home-next-action-meta',
          `${task.projectName} · ${task.artifactCount} 个产出`,
        ),
      );
      const action = element('button', 'atl-home-primary-action');
      action.type = 'button';
      setIcon(action, 'arrow-up-right');
      action.append(element('span', undefined, '打开任务'));
      action.addEventListener('click', () => {
        void this.dependencies.openTask(task.taskId);
      });
      card.append(status, copy, action);
      area.body.append(card);
    }
    return area.root;
  }

  private renderOverviewLower(state: ContributionDashboardState): HTMLElement {
    const root = element('div', 'atl-home-overview-lower');
    root.append(this.renderInboxQueue(state), this.renderTodayProgress(state));
    return root;
  }

  private renderInboxQueue(state: ContributionDashboardState): HTMLElement {
    const area = this.renderCommandSection(
      'INPUT QUEUE',
      '等待你判断',
      'atl-home-queue-panel',
      '查看全部',
      () => {
        this.activeTab = 'input';
        this.rerender();
      },
    );
    const tasks = state.home.snapshot?.inboxTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '收件箱当前为空'));
    } else {
      const list = element('div', 'atl-home-queue-list');
      for (const task of tasks.slice(0, 3)) {
        const row = element('button', 'atl-home-queue-row');
        row.type = 'button';
        row.dataset.taskId = task.taskId;
        row.append(element(
          'span',
          `atl-home-priority is-${task.priority}`,
          PRIORITY_LABELS[task.priority],
        ));
        const copy = element('span', 'atl-home-queue-copy');
        copy.append(
          element(
            'strong',
            'atl-home-queue-title',
            task.title.trim() === '' ? '未命名任务' : task.title,
          ),
          element(
            'span',
            'atl-home-queue-meta',
            `${task.projectName} · ${formatCompactDate(task.updatedAt)}`,
          ),
        );
        row.append(copy, element('span', 'atl-home-row-action', '判断'));
        row.addEventListener('click', () => {
          void this.dependencies.openTask(task.taskId);
        });
        list.append(row);
      }
      area.body.append(list);
    }
    return area.root;
  }

  private renderTodayProgress(state: ContributionDashboardState): HTMLElement {
    const area = this.renderCommandSection(
      'CURRENT',
      '当前推进任务',
      'atl-home-progress-panel',
      '完整列表',
      () => {
        this.activeTab = 'today';
        this.rerender();
      },
    );
    const tasks = state.home.snapshot?.focusTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当前没有待推进任务'));
    } else {
      const list = element('div', 'atl-home-progress-list');
      for (const task of tasks.slice(0, 4)) {
        const row = element('button', 'atl-home-progress-row');
        row.type = 'button';
        row.dataset.taskId = task.taskId;
        row.append(element('span', `atl-home-progress-dot is-${task.status}`));
        const copy = element('span', 'atl-home-progress-copy');
        copy.append(
          element(
            'strong',
            'atl-home-progress-title',
            task.title.trim() === '' ? '未命名任务' : task.title,
          ),
          element('span', 'atl-home-progress-meta', task.projectName),
        );
        row.append(
          copy,
          element(
            'span',
            `atl-home-progress-state is-${task.status}`,
            STATUS_LABELS[task.status] ?? task.status,
          ),
        );
        row.addEventListener('click', () => {
          void this.dependencies.openTask(task.taskId);
        });
        list.append(row);
      }
      area.body.append(list);
    }
    return area.root;
  }

  private renderCommandSection(
    eyebrow: string,
    title: string,
    className: string,
    actionLabel?: string,
    onAction?: () => void,
  ): { root: HTMLElement; body: HTMLElement } {
    const root = element('section', `atl-contribution-section ${className}`);
    const heading = element('div', 'atl-home-section-head');
    const copy = element('div');
    copy.append(
      element('p', 'atl-home-eyebrow', eyebrow),
      element('h2', 'atl-home-section-title', title),
    );
    heading.append(copy);
    if (actionLabel !== undefined && onAction !== undefined) {
      const action = element('button', 'atl-home-section-link');
      action.type = 'button';
      action.append(element('span', undefined, actionLabel));
      const icon = element('span', 'atl-home-section-link-icon');
      setIcon(icon, 'arrow-right');
      action.append(icon);
      action.addEventListener('click', onAction);
      heading.append(action);
    }
    const body = element('div', 'atl-contribution-section-body');
    root.append(heading, body);
    return { root, body };
  }

  private renderToday(state: ContributionDashboardState): HTMLElement {
    const view = element('main', 'atl-home-view atl-home-view-today');
    const area = section('当前可以推进', 'atl-home-today-tasks');
    const tasks = state.home.snapshot?.focusTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当前没有待推进任务'));
    } else {
      area.body.append(this.renderTaskList(tasks));
    }
    view.append(area.root, this.renderTaskFlow(state));
    return view;
  }

  private renderInput(state: ContributionDashboardState): HTMLElement {
    const view = element('main', 'atl-home-view atl-home-view-input');
    const area = section('收件箱', 'atl-home-input-list');
    const tasks = state.home.snapshot?.inboxTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '收件箱当前为空'));
    } else {
      area.body.append(this.renderTaskList(tasks));
    }
    view.append(area.root);
    return view;
  }

  private renderReview(state: ContributionDashboardState): HTMLElement {
    const view = element('main', 'atl-home-view atl-home-view-review');
    view.append(this.renderProjects(state), this.renderOutputs(state));
    return view;
  }

  private renderTaskList(tasks: PersonalHomeTask[]): HTMLElement {
    const list = element('div', 'atl-home-task-list');
    for (const task of tasks) {
      const button = element('button', 'atl-home-task');
      button.type = 'button';
      button.dataset.taskId = task.taskId;
      const status = element(
        'span',
        `atl-home-task-status is-${task.status}`,
        STATUS_LABELS[task.status] ?? task.status,
      );
      const content = element('span', 'atl-home-task-content');
      content.append(element(
        'strong',
        'atl-home-task-title',
        task.title.trim() === '' ? '未命名任务' : task.title,
      ));
      content.append(element(
        'span',
        'atl-home-task-meta',
        `${task.projectName} · ${task.artifactCount} 个产出`,
      ));
      button.append(status, content);
      button.addEventListener('click', () => {
        void this.dependencies.openTask(task.taskId);
      });
      list.append(button);
    }
    return list;
  }

  private renderProjects(state: ContributionDashboardState): HTMLElement {
    const area = section(`${state.selectedDate} 主要做了什么`, 'atl-contribution-projects-section');
    const snapshot = state.contribution.snapshot;
    if (snapshot === null || snapshot.projectSummaries.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当天没有已完成任务'));
      return area.root;
    }
    const list = element('div', 'atl-contribution-project-list');
    for (const project of snapshot.projectSummaries) {
      const row = element('div', 'atl-contribution-project');
      const identity = element('div', 'atl-contribution-project-identity');
      identity.append(element('strong', 'atl-contribution-project-name', project.projectName));
      identity.append(element(
        'span',
        'atl-contribution-project-evidence',
        project.evidenceTitles.join(' · '),
      ));
      const metrics = element('div', 'atl-contribution-project-metrics');
      metrics.append(element('span', undefined, `${project.completed} 个完成`));
      metrics.append(element('span', undefined, `${project.artifactCount} 个产出`));
      row.append(identity, metrics);
      list.append(row);
    }
    area.body.append(list);
    return area.root;
  }

  private renderOutputs(state: ContributionDashboardState): HTMLElement {
    const area = section('可核对产出', 'atl-contribution-outputs-section');
    const outputs = state.contribution.snapshot?.outputs ?? [];
    if (outputs.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当天没有可核对产出'));
      this.appendTokenRecovery(area.body, state);
      return area.root;
    }
    const list = element('div', 'atl-contribution-output-list');
    for (const output of outputs) {
      const row = element('div', 'atl-contribution-output');
      const taskButton = element('button', 'atl-contribution-output-task');
      taskButton.type = 'button';
      taskButton.dataset.taskId = output.taskId;
      taskButton.append(element('strong', undefined, output.title));
      taskButton.append(element(
        'span',
        undefined,
        `${output.projectName} · ${formatTime(output.completedAt)} · ${output.artifactRef === null ? '人工完成' : '有 Agent 产出'}`,
      ));
      taskButton.addEventListener('click', () => {
        void this.dependencies.openTask(output.taskId);
      });
      row.append(taskButton);
      if (output.artifactRef !== null) {
        const artifact = element('button', 'clickable-icon atl-contribution-output-artifact');
        artifact.type = 'button';
        artifact.dataset.artifactRef = output.artifactRef;
        artifact.setAttribute('aria-label', `打开 ${output.title} 的 Agent 产出`);
        artifact.title = '打开 Agent 产出';
        setIcon(artifact, 'file-check-2');
        artifact.addEventListener('click', () => {
          void this.dependencies.openArtifact(output.artifactRef!, output.taskId);
        });
        row.append(artifact);
      }
      list.append(row);
    }
    area.body.append(list);
    this.appendTokenRecovery(area.body, state);
    return area.root;
  }

  private appendTokenRecovery(body: HTMLElement, state: ContributionDashboardState): void {
    if (state.token.status !== 'missing' && state.token.status !== 'error') return;
    const recovery = element('button', 'mod-muted atl-contribution-recovery', '查看数据源设置');
    recovery.type = 'button';
    recovery.addEventListener('click', () => {
      void this.dependencies.openSettings();
    });
    body.append(recovery);
  }
}
