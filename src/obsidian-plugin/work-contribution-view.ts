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

const TAB_OPTIONS: Array<{ value: HomeTab; label: string }> = [
  { value: 'overview', label: '总览' },
  { value: 'today', label: '今日' },
  { value: 'input', label: '输入' },
  { value: 'review', label: '复盘' },
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
    const root = element('div', 'atl-contribution-shell');
    root.append(this.renderHeader(state));
    root.append(this.renderTabs());
    root.append(this.renderActiveView(state));
    this.contentEl.replaceChildren(root);
  }

  private rerender(): void {
    if (this.state !== null) this.render(this.state);
  }

  private renderHeader(state: ContributionDashboardState): HTMLElement {
    const header = element('header', 'atl-contribution-header');
    const identity = element('div', 'atl-contribution-identity');
    identity.append(element('h1', 'atl-contribution-title', 'ClawVault'));
    identity.append(element('p', 'atl-contribution-subtitle', '个人注意力与任务推进'));
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
    identity.append(sources);

    const refresh = element('button', 'clickable-icon atl-contribution-refresh');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', '刷新数据');
    refresh.title = '刷新数据';
    refresh.disabled = state.refreshing;
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => {
      void this.controller?.refreshAll();
    });
    header.append(identity, refresh);
    return header;
  }

  private renderTabs(): HTMLElement {
    const tabs = element('nav', 'atl-home-tabs');
    tabs.setAttribute('aria-label', '个人首页视图');
    for (const option of TAB_OPTIONS) {
      const button = element('button', 'atl-home-tab', option.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(this.activeTab === option.value));
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
    view.append(this.renderTaskFlow(state));
    view.append(this.renderNextAction(state));
    view.append(this.renderInboxPreview(state));
    view.append(this.renderProjects(state));
    view.append(this.renderOutputs(state));
    return view;
  }

  private renderPulse(state: ContributionDashboardState): HTMLElement {
    const pulse = element('section', 'atl-home-pulse');
    const heading = element('div', 'atl-home-pulse-heading');
    const title = element('div');
    title.append(element('p', 'atl-home-eyebrow', 'PERSONAL PULSE'));
    title.append(element('h2', 'atl-home-pulse-title', '最近的持续推进'));

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
    controls.append(ranges);
    heading.append(title, controls);

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
    pulse.append(heading, modes);

    if (this.pulseMode === 'consumption') {
      const pending = element('div', 'atl-home-consumption-pending');
      pending.append(element('strong', undefined, '文章消费标记待接入'));
      pending.append(element(
        'span',
        undefined,
        '首页暂不推测文章是否被消费，后续以你的重要度与个人判断为准。',
      ));
      pulse.append(pending);
    } else {
      pulse.append(this.renderHeatmap(state));
    }
    pulse.append(this.renderPulseSummary(state));
    pulse.append(this.renderTrends(state));
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
      ['连续推进', snapshot === null ? '--' : `${formatNumber(snapshot.kpis.currentStreak)} 天`],
      ['本周完成', snapshot === null ? '--' : `${formatNumber(snapshot.kpis.completedThisWeek)} 项`],
      ['今日完成', snapshot === null ? '--' : `${formatNumber(snapshot.kpis.completedToday)} 项`],
      ['今日 Token', tokenToday === undefined ? '--' : formatNumber(tokenToday.normalized)],
    ];
    const summary = element('div', 'atl-home-pulse-summary');
    for (const [label, value] of values) {
      const item = element('div', 'atl-home-pulse-stat');
      item.append(element('span', undefined, label));
      item.append(element('strong', undefined, value));
      summary.append(item);
    }
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
    const area = section('当前推进候选 Top 3', 'atl-home-focus');
    const tasks = state.home.snapshot?.focusTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '当前没有执行中或待执行任务'));
    } else {
      area.body.append(this.renderTaskList(tasks.slice(0, 3)));
    }
    return area.root;
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
    const area = section('建议下一项行动', 'atl-home-next-action');
    const task = state.home.snapshot?.nextAction ?? null;
    if (task === null) {
      area.body.append(element('p', 'atl-contribution-empty', '先从收件箱确认一个任务'));
    } else {
      area.body.append(this.renderTaskList([task]));
    }
    return area.root;
  }

  private renderInboxPreview(state: ContributionDashboardState): HTMLElement {
    const area = section('等待判断的输入', 'atl-home-inbox-preview');
    const tasks = state.home.snapshot?.inboxTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '收件箱当前为空'));
    } else {
      area.body.append(this.renderTaskList(tasks.slice(0, 3)));
    }
    return area.root;
  }

  private renderToday(state: ContributionDashboardState): HTMLElement {
    const view = element('main', 'atl-home-view atl-home-view-today');
    const area = section('今天可以推进', 'atl-home-today-tasks');
    const tasks = state.home.snapshot?.focusTasks ?? [];
    if (tasks.length === 0) {
      area.body.append(element('p', 'atl-contribution-empty', '今天还没有待推进任务'));
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
