import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { ContributionRange } from '../services/query-contribution.js';
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

const RANGE_OPTIONS: Array<{ value: ContributionRange; label: string }> = [
  { value: '7d', label: '7 天' },
  { value: '12w', label: '12 周' },
  { value: '1y', label: '1 年' },
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

export class WorkContributionView extends ItemView {
  private readonly dependencies: WorkContributionViewDependencies;
  private controller: ContributionDashboardController | null = null;
  private unsubscribe: (() => void) | null = null;

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
    return '个人工作贡献';
  }

  getIcon(): string {
    return 'chart-no-axes-combined';
  }

  async onOpen(): Promise<void> {
    this.contentEl.classList.add('atl-contribution-view');
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

  refreshContribution(): Promise<void> {
    return this.controller?.refreshContribution() ?? Promise.resolve();
  }

  private render(state: ContributionDashboardState): void {
    const root = element('div', 'atl-contribution-shell');
    root.append(this.renderHeader(state));
    root.append(this.renderKpis(state));
    root.append(this.renderHeatmap(state));
    root.append(this.renderTrends(state));
    root.append(this.renderProjects(state));
    root.append(this.renderOutputs(state));
    this.contentEl.replaceChildren(root);
  }

  private renderHeader(state: ContributionDashboardState): HTMLElement {
    const header = element('header', 'atl-contribution-header');
    const identity = element('div', 'atl-contribution-identity');
    identity.append(element('h1', 'atl-contribution-title', '个人工作贡献'));
    identity.append(element(
      'p',
      'atl-contribution-subtitle',
      '像看 GitHub 一样，看见每天真正完成的工作。',
    ));
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
    const refresh = element('button', 'clickable-icon atl-contribution-refresh');
    refresh.type = 'button';
    refresh.setAttribute('aria-label', '刷新数据');
    refresh.title = '刷新数据';
    refresh.disabled = state.refreshing;
    setIcon(refresh, 'refresh-cw');
    refresh.addEventListener('click', () => {
      void this.controller?.refreshAll();
    });
    controls.append(ranges, refresh);
    header.append(identity, controls);
    return header;
  }

  private renderKpis(state: ContributionDashboardState): HTMLElement {
    const grid = element('section', 'atl-contribution-kpis');
    const snapshot = state.contribution.snapshot;
    const today = snapshot?.days.at(-1)?.date;
    const tokenToday = state.token.snapshot?.days.find((day) => day.date === today);
    const values = [
      ['今日完成', snapshot === null ? '--' : formatNumber(snapshot.kpis.completedToday), '个任务'],
      ['本周完成', snapshot === null ? '--' : formatNumber(snapshot.kpis.completedThisWeek), '周一至今'],
      ['连续完成', snapshot === null ? '--' : formatNumber(snapshot.kpis.currentStreak), '天'],
      [
        '今日 Normalized Token',
        tokenToday === undefined ? '--' : formatNumber(tokenToday.normalized),
        tokenStatusText(state),
      ],
    ];
    for (const [label, value, note] of values) {
      const card = element('div', 'atl-contribution-kpi');
      card.append(element('span', 'atl-contribution-kpi-label', label));
      card.append(element('strong', 'atl-contribution-kpi-value', value));
      card.append(element('span', 'atl-contribution-kpi-note', note));
      grid.append(card);
    }
    return grid;
  }

  private renderHeatmap(state: ContributionDashboardState): HTMLElement {
    const area = section('工作贡献', 'atl-contribution-heatmap-section');
    const snapshot = state.contribution.snapshot;
    if (snapshot === null) {
      area.body.append(element(
        'p',
        'atl-contribution-empty',
        state.contribution.status === 'error'
          ? '暂时无法读取完成记录，请稍后刷新。'
          : '正在读取完成记录…',
      ));
      return area.root;
    }
    const scroller = element('div', 'atl-contribution-heatmap-scroll');
    const grid = element('div', 'atl-contribution-heatmap');
    grid.setAttribute('aria-label', '每日任务完成贡献图');
    for (const day of snapshot.days) {
      const button = element('button', `atl-contribution-day atl-contribution-level-${day.level}`);
      button.type = 'button';
      button.dataset.date = day.date;
      button.setAttribute(
        'aria-label',
        `${day.date}，${day.completed} 个完成任务，${day.projectCount} 个项目`,
      );
      button.title = `${day.date} · ${day.completed} 个完成任务`;
      const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      button.style.gridRow = String(weekday === 0 ? 7 : weekday);
      if (state.selectedDate === day.date) {
        button.classList.add('is-selected');
        button.setAttribute('aria-current', 'date');
      }
      button.addEventListener('click', () => {
        void this.controller?.setSelectedDate(day.date);
      });
      grid.append(button);
    }
    scroller.append(grid);
    area.body.append(scroller);
    if (snapshot.coverage.historicalCompletionDateUnavailable > 0) {
      area.body.append(element(
        'p',
        'atl-contribution-coverage',
        `${snapshot.coverage.historicalCompletionDateUnavailable} 个历史完成任务缺少可核对日期，未计入贡献图。`,
      ));
    }
    return area.root;
  }

  private renderTrends(state: ContributionDashboardState): HTMLElement {
    const area = section('趋势', 'atl-contribution-trends-section');
    const taskDays = state.contribution.snapshot?.days ?? [];
    const tokenByDate = new Map(
      (state.token.snapshot?.days ?? []).map((day) => [day.date, day]),
    );
    const definitions = [
      {
        title: '每日完成任务',
        value: taskDays.reduce((sum, day) => sum + day.completed, 0),
        values: taskDays.map((day) => day.completed),
        label: '每日完成任务趋势',
        token: false,
      },
      {
        title: '每日 Normalized Token',
        value: taskDays.reduce((sum, day) => sum + (tokenByDate.get(day.date)?.normalized ?? 0), 0),
        values: taskDays.map((day) => tokenByDate.get(day.date)?.normalized ?? 0),
        label: '每日 Normalized Token 趋势',
        token: true,
      },
    ];
    const grid = element('div', 'atl-contribution-trends');
    for (const definition of definitions) {
      const chart = element(
        'div',
        `atl-contribution-chart ${definition.token ? 'is-token' : 'is-task'}`,
      );
      const caption = element('div', 'atl-contribution-chart-caption');
      caption.append(element('span', 'atl-contribution-chart-title', definition.title));
      caption.append(element('strong', 'atl-contribution-chart-total', formatNumber(definition.value)));
      chart.append(caption, lineChart(definition.values, definition.label));
      grid.append(chart);
    }
    area.body.append(grid);
    return area.root;
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
