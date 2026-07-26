/* @vitest-environment jsdom */

import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLeaf } from 'obsidian';

import type {
  ContributionDashboardState,
} from '../../../src/obsidian-plugin/contribution-dashboard-controller.js';
import {
  WorkContributionView,
  WORK_CONTRIBUTION_VIEW_TYPE,
} from '../../../src/obsidian-plugin/work-contribution-view.js';
import type { WeeklyFocusDocument } from '../../../src/services/weekly-focus.js';

function weeklyFocus(status: '草稿' | '已确认'): WeeklyFocusDocument {
  return {
    path: '05_Reviews/Weekly/2026-W30 周度重点.md',
    raw: 'weekly focus fixture',
    record: {
      type: '周度重点',
      week: '2026-W30',
      status,
      linkedGoals: [],
      linkedTasks: [],
      createdBy: 'ATL 思考教练',
      confirmedAt: status === '已确认' ? '2026-07-26T08:00:00.000Z' : null,
      reviewStatus: '待复盘',
      updatedAt: '2026-07-26T08:00:00.000Z',
      input: {
        conversationTopic: '本周如何让产品边界更清楚',
        selectedSources: ['目标', '项目', '任务'],
        currentQuestion: '什么结果能证明投入值得？',
        coachSummary: '需要先定义可观察结果。',
        focuses: [{
          problem: '产品边界反复变化',
          judgment: '先验证两个真实流程',
          outcome: '形成团队可复用的边界说明',
          evidence: '两个流程使用同一份说明',
          commitment: '周五前完成验证',
        }],
        noNewFocus: false,
        notDoing: ['不新增 Agent 名称'],
        background: { facts: [], assumptions: [], gaps: [], sources: [] },
        coachInsights: [],
        consideredDirections: [],
        keyAnswers: [],
        linkedGoals: [],
        linkedTasks: [],
        adjustmentNote: '',
      },
    },
  };
}

function state(overrides: Partial<ContributionDashboardState> = {}): ContributionDashboardState {
  return {
    range: '26w',
    selectedDate: '2026-07-20',
    contribution: {
      status: 'ready',
      errorCode: null,
      snapshot: {
        range: '1y',
        selectedDate: '2026-07-20',
        kpis: { completedToday: 2, completedThisWeek: 5, currentStreak: 3 },
        days: [
          { date: '2026-07-19', completed: 1, outputCount: 0, projectCount: 1, level: 1 },
          { date: '2026-07-20', completed: 2, outputCount: 1, projectCount: 1, level: 2 },
          { date: '2026-07-21', completed: 0, outputCount: 0, projectCount: 0, level: 0 },
        ],
        projectSummaries: [{
          projectId: 'atl',
          projectName: 'Agent Task Loop',
          completed: 2,
          artifactCount: 1,
          evidenceTitles: ['Build dashboard', 'Verify dashboard'],
        }],
        outputs: [{
          taskId: 'task-a',
          title: 'Build dashboard',
          projectName: 'Agent Task Loop',
          completedAt: '2026-07-20T09:00:00+08:00',
          artifactRef: 'Artifacts/task-a/attempt-001.md',
        }],
        coverage: {
          historicalCompletionDateUnavailable: 1,
          tasksMissingCompletionDate: [{ taskId: 'task-history', title: '历史完成任务' }],
        },
      },
    },
    home: {
      status: 'ready',
      errorCode: null,
      snapshot: {
        counts: { inbox: 1, ready: 1, inProgress: 1, review: 1, blocked: 0 },
        focusTasks: [{
          taskId: 'task-focus',
          title: '完成真实个人首页',
          status: 'in_progress',
          reviewState: 'confirmed',
          projectName: 'Agent Task Loop',
          priority: 'high',
          updatedAt: '2026-07-20T08:00:00+08:00',
          artifactCount: 0,
        }],
        inboxTasks: [{
          taskId: 'task-inbox',
          title: '判断首页输入',
          status: 'inbox',
          reviewState: 'ready_for_confirm',
          projectName: '未归类',
          priority: 'normal',
          updatedAt: '2026-07-20T07:00:00+08:00',
          artifactCount: 0,
        }],
        nextAction: {
          taskId: 'task-focus',
          title: '完成真实个人首页',
          status: 'in_progress',
          reviewState: 'confirmed',
          projectName: 'Agent Task Loop',
          priority: 'high',
          updatedAt: '2026-07-20T08:00:00+08:00',
          artifactCount: 0,
        },
      },
    },
    token: {
      status: 'ready',
      errorCode: null,
      snapshot: {
        version: '0.3.11',
        updatedAt: '2026-07-20T02:00:00.000Z',
        since: '2026-07-01',
        days: [{
          date: '2026-07-20',
          normalized: 180,
          input: 150,
          output: 30,
          cacheRead: 45,
          cacheWrite: 2,
          tools: ['claude-code', 'codex'],
        }],
      },
    },
    refreshing: false,
    ...overrides,
  };
}

function contributionDays(count: number) {
  const first = new Date('2025-07-22T12:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      completed: index % 4,
      outputCount: index % 3,
      projectCount: index % 4 === 0 ? 0 : 1,
      level: Math.min(index % 4, 4) as 0 | 1 | 2 | 3 | 4,
    };
  });
}

function setup(initial = state(), initialWeeklyFocus: WeeklyFocusDocument | null = null) {
  let current = initial;
  let listener: ((state: ContributionDashboardState) => void) | null = null;
  const controller = {
    getState: () => current,
    subscribe: vi.fn((callback: (value: ContributionDashboardState) => void) => {
      listener = callback;
      callback(current);
      return () => { listener = null; };
    }),
    initialize: vi.fn(async () => undefined),
    setRange: vi.fn(async () => undefined),
    setSelectedDate: vi.fn(async () => undefined),
    refreshAll: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const openTask = vi.fn(async () => undefined);
  const openArtifact = vi.fn(async () => undefined);
  const openCompletionDateBackfill = vi.fn(async () => undefined);
  const loadWeeklyFocus = vi.fn(async () => initialWeeklyFocus);
  const openWeeklyCoach = vi.fn();
  const openWeeklyFocus = vi.fn(async () => undefined);
  const view = new WorkContributionView(new WorkspaceLeaf(), {
    createController: () => controller as never,
    openTask,
    openArtifact,
    openCompletionDateBackfill,
    openSettings: vi.fn(),
    loadWeeklyFocus,
    openWeeklyCoach,
    openWeeklyFocus,
  });
  return {
    controller,
    openTask,
    openArtifact,
    openCompletionDateBackfill,
    loadWeeklyFocus,
    openWeeklyCoach,
    openWeeklyFocus,
    view,
    publish(next: ContributionDashboardState) {
      current = next;
      listener?.(current);
    },
  };
}

describe('WorkContributionView', () => {
  it('renders the approved command-center workspace shell around the home views', async () => {
    const { view } = setup();
    await view.onOpen();

    expect(view.contentEl.querySelector('.atl-home-app-shell')).not.toBeNull();
    expect(view.contentEl.querySelector('.atl-home-sidebar')).not.toBeNull();
    expect(view.contentEl.querySelector('.atl-home-main')).not.toBeNull();
    expect(view.contentEl.querySelector('.atl-home-sidebar-brand')?.textContent)
      .toContain('ClawVault');
    expect(view.contentEl.querySelectorAll('.atl-home-sidebar .atl-home-tab')).toHaveLength(4);
    expect(view.contentEl.querySelector('.atl-home-tab-count')?.textContent).toBe('1');
  });

  it('renders the confirmed personal home structure with Personal Pulse first', async () => {
    const { view } = setup();
    await view.onOpen();

    expect(view.getViewType()).toBe(WORK_CONTRIBUTION_VIEW_TYPE);
    expect(view.getDisplayText()).toBe('ClawVault 个人首页');
    expect(view.contentEl.querySelector('h1')?.textContent).toBe('ClawVault');
    expect(view.contentEl.querySelector('.atl-contribution-subtitle')?.textContent)
      .toBe('个人工作台');
    expect(view.contentEl.querySelectorAll('.atl-home-tab')).toHaveLength(4);
    expect(view.contentEl.querySelectorAll('.atl-contribution-range')).toHaveLength(3);
    expect(view.contentEl.textContent).toContain('26 周');
    expect(view.contentEl.querySelector('.atl-home-view-overview')?.firstElementChild?.classList
      .contains('atl-home-pulse')).toBe(true);
    expect(view.contentEl.querySelectorAll('.atl-pulse-mode')).toHaveLength(4);
    expect(view.contentEl.querySelectorAll('.atl-contribution-day')).toHaveLength(3);
    expect(view.contentEl.querySelectorAll('.atl-home-trend')).toHaveLength(3);
    expect(view.contentEl.textContent).toContain('当前最值得推进的三件事');
    expect(view.contentEl.querySelectorAll('.atl-home-focus-card')).toHaveLength(1);
    expect(view.contentEl.querySelectorAll('.atl-home-metric-cell')).toHaveLength(3);
    expect(view.contentEl.textContent).toContain('输入积压');
    expect(view.contentEl.textContent).toContain('任务流转');
    expect(view.contentEl.textContent).toContain('系统状态');
    expect(view.contentEl.textContent).toContain('现在最值得做什么');
    expect(view.contentEl.querySelector('.atl-home-overview-lower')).not.toBeNull();
    expect(view.contentEl.textContent).toContain('等待你判断');
    expect(view.contentEl.textContent).toContain('当前推进任务');
    expect(view.contentEl.textContent).toContain('完成真实个人首页');
    expect(view.contentEl.textContent).toContain('判断首页输入');
  });

  it('places AI first in the Personal Pulse mode switcher', async () => {
    const { view } = setup();
    await view.onOpen();

    const modes = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')];
    expect(modes.map((button) => button.textContent)).toEqual([
      'AI',
      '任务',
      '消费',
      '产出',
    ]);
    expect(modes.find((button) => button.textContent === 'AI')?.getAttribute('aria-pressed'))
      .toBe('true');
    expect(view.contentEl.querySelector('.atl-contribution-heatmap')?.getAttribute('aria-label'))
      .toBe('AI每日贡献图');
  });

  it('offers the weekly coach from the focus title bar when no session exists', async () => {
    const { openWeeklyCoach, view } = setup();
    await view.onOpen();

    const action = [...view.contentEl.querySelectorAll<HTMLButtonElement>(
      '.atl-home-focus .atl-home-section-link',
    )].find((button) => button.textContent?.includes('梳理本周重点'));
    expect(action).toBeDefined();
    fireEvent.click(action!);
    expect(openWeeklyCoach).toHaveBeenCalledOnce();
  });

  it('offers to continue a saved weekly thinking draft', async () => {
    const { view } = setup(state(), weeklyFocus('草稿'));
    await view.onOpen();

    expect(view.contentEl.querySelector('.atl-home-focus .atl-home-section-link')?.textContent)
      .toContain('继续本周思考');
    expect(view.contentEl.querySelector('.atl-home-focus')?.textContent)
      .toContain('CURRENT FOCUS · 系统候选');
  });

  it('replaces only focus cards with confirmed judgments and opens the weekly record', async () => {
    const confirmed = weeklyFocus('已确认');
    const { openTask, openWeeklyFocus, view } = setup(state(), confirmed);
    await view.onOpen();

    const focus = view.contentEl.querySelector('.atl-home-focus')!;
    expect(focus.textContent).toContain('CURRENT FOCUS · 用户确认');
    expect(focus.textContent).toContain('先验证两个真实流程');
    expect(focus.textContent).toContain('形成团队可复用的边界说明');
    expect(focus.textContent).not.toContain('完成真实个人首页');
    expect(focus.querySelector('.atl-home-section-link')?.textContent)
      .toContain('查看本周判断');
    expect(view.contentEl.textContent).toContain('输入积压');
    expect(view.contentEl.textContent).toContain('系统状态');

    fireEvent.click(focus.querySelector<HTMLButtonElement>('.atl-home-focus-card')!);
    expect(openWeeklyFocus).toHaveBeenCalledWith(confirmed.path);
    expect(openTask).not.toHaveBeenCalled();
  });

  it('keeps the heatmap at 26 weeks while range controls only slice trends', async () => {
    const base = state();
    const days = contributionDays(365);
    const { view } = setup(state({
      range: '7d',
      contribution: {
        ...base.contribution,
        snapshot: { ...base.contribution.snapshot!, days },
      },
    }));
    await view.onOpen();

    expect(view.contentEl.querySelector('.atl-home-pulse-title')?.textContent)
      .toBe('最近 26 周');
    expect(view.contentEl.querySelectorAll(
      '.atl-contribution-day, .atl-contribution-placeholder',
    )).toHaveLength(182);
    expect(view.contentEl.querySelector('.atl-contribution-heatmap')?.getAttribute('data-range'))
      .toBe('26w');
    expect(view.contentEl.querySelector('.atl-home-trends')?.getAttribute('data-range'))
      .toBe('7d');
    expect([...view.contentEl.querySelectorAll<HTMLElement>('.atl-home-trend')]
      .map((trend) => trend.dataset.pointCount)).toEqual(['7', '7', '7']);
    expect(view.contentEl.querySelector('.atl-home-pulse-heading .atl-contribution-ranges'))
      .toBeNull();
    expect(view.contentEl.querySelector('.atl-home-trends-heading .atl-contribution-ranges'))
      .not.toBeNull();
  });

  it('reveals the nearest dated value while hovering a trend chart', async () => {
    const { view } = setup();
    await view.onOpen();

    const plot = view.contentEl.querySelector<HTMLElement>(
      '.atl-home-trend.is-task .atl-contribution-chart-plot',
    )!;
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const tooltip = plot.querySelector<HTMLElement>('.atl-contribution-chart-tooltip')!;
    const marker = plot.querySelector<SVGCircleElement>('.atl-contribution-chart-marker')!;

    expect(tooltip.hidden).toBe(true);
    fireEvent.pointerMove(plot, { clientX: 150 });
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('2026-07-20 · 2 项');
    expect(marker.style.display).not.toBe('none');

    fireEvent.pointerLeave(plot);
    expect(tooltip.hidden).toBe(true);
    expect(marker.style.display).toBe('none');
  });

  it('formats large Token values with Chinese compact units in trend tooltips', async () => {
    const base = state();
    const { view } = setup(state({
      token: {
        ...base.token,
        snapshot: {
          ...base.token.snapshot!,
          days: [{
            ...base.token.snapshot!.days[0]!,
            normalized: 64_229_257,
          }],
        },
      },
    }));
    await view.onOpen();

    const plot = view.contentEl.querySelector<HTMLElement>(
      '.atl-home-trend.is-token .atl-contribution-chart-plot',
    )!;
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 300,
      top: 0,
      width: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerMove(plot, { clientX: 150 });
    expect(plot.querySelector('.atl-contribution-chart-tooltip')?.textContent)
      .toBe('2026-07-20 · 6422.93万 Token');
  });

  it('exposes exact trend values through keyboard focus and arrow keys', async () => {
    const { view } = setup();
    await view.onOpen();

    const plot = view.contentEl.querySelector<HTMLElement>(
      '.atl-home-trend.is-task .atl-contribution-chart-plot',
    )!;
    const tooltip = plot.querySelector<HTMLElement>('.atl-contribution-chart-tooltip')!;

    expect(plot.tabIndex).toBe(0);
    fireEvent.focus(plot);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('2026-07-21 · 0 项');

    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tooltip.textContent).toBe('2026-07-20 · 2 项');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(tooltip.textContent).toBe('2026-07-19 · 1 项');
    fireEvent.keyDown(plot, { key: 'End' });
    expect(tooltip.textContent).toBe('2026-07-21 · 0 项');

    fireEvent.blur(plot);
    expect(tooltip.hidden).toBe(true);
  });

  it('uses whole metric cards as the navigation controls', async () => {
    const { view } = setup();
    await view.onOpen();

    const metrics = [...view.contentEl.querySelectorAll<HTMLButtonElement>(
      '.atl-home-metric-cell',
    )];
    expect(metrics).toHaveLength(3);
    expect(metrics.every((metric) => metric.tagName === 'BUTTON')).toBe(true);
    expect(metrics.every((metric) => metric.querySelector('button') === null)).toBe(true);
    expect(metrics[0]?.querySelector('.atl-home-mini-action')?.textContent)
      .toBe('去处理输入 →');

    fireEvent.click(metrics[0]!);
    expect(view.contentEl.querySelector('.atl-home-view-input')).not.toBeNull();
  });

  it('presents the pulse summary as one streak hero with three real supporting metrics', async () => {
    const { openCompletionDateBackfill, view } = setup();
    await view.onOpen();

    const hero = view.contentEl.querySelector('.atl-home-pulse-hero');
    expect(hero?.querySelector('strong')?.textContent).toBe('3 天');
    expect(hero?.querySelector('span')?.textContent).toBe('当前连续推进');

    const details = [...view.contentEl.querySelectorAll('.atl-home-pulse-detail')];
    expect(details).toHaveLength(3);
    expect(details.map((detail) => detail.querySelector('span')?.textContent))
      .toEqual(['本周完成', '今日完成', '今日 Token']);
    expect(details.map((detail) => detail.querySelector('strong')?.textContent))
      .toEqual(['5 项', '2 项', '--']);
    const backfill = view.contentEl.querySelector<HTMLButtonElement>(
      '.atl-contribution-coverage-action',
    );
    expect(backfill?.textContent)
      .toBe('另有 1 个历史完成任务未记录完成日期 · 查看并补齐');
    fireEvent.click(backfill!);
    expect(openCompletionDateBackfill).toHaveBeenCalledWith([
      { taskId: 'task-history', title: '历史完成任务' },
    ]);
  });

  it('formats today Token and Token trend totals with the same Chinese units', async () => {
    const base = state();
    const { view } = setup(state({
      token: {
        ...base.token,
        snapshot: {
          ...base.token.snapshot!,
          days: [
            {
              ...base.token.snapshot!.days[0]!,
              normalized: 64_229_257,
            },
            {
              ...base.token.snapshot!.days[0]!,
              date: '2026-07-21',
              normalized: 716_000_000,
            },
          ],
        },
      },
    }));
    await view.onOpen();

    const details = [...view.contentEl.querySelectorAll('.atl-home-pulse-detail')];
    expect(details.find((detail) => detail.querySelector('span')?.textContent === '今日 Token')
      ?.querySelector('strong')?.textContent).toBe('7.16亿');
    expect(view.contentEl.querySelector(
      '.atl-home-trend.is-token .atl-contribution-chart-total',
    )?.textContent).toBe('7.8亿');
    expect(view.contentEl.querySelector(
      '.atl-home-trend.is-task .atl-contribution-chart-total',
    )?.textContent).toBe('3');
  });

  it('keeps overview previews compact while full tabs show every task', async () => {
    const base = state();
    const focusTasks = Array.from({ length: 4 }, (_, index) => ({
      ...base.home.snapshot!.focusTasks[0]!,
      taskId: `focus-${index}`,
      title: `推进任务 ${index + 1}`,
    }));
    const inboxTasks = Array.from({ length: 6 }, (_, index) => ({
      ...base.home.snapshot!.inboxTasks[0]!,
      taskId: `inbox-${index}`,
      title: `输入任务 ${index + 1}`,
    }));
    const { view } = setup(state({
      home: {
        status: 'ready',
        errorCode: null,
        snapshot: {
          ...base.home.snapshot!,
          focusTasks,
          inboxTasks,
          nextAction: focusTasks[0]!,
        },
      },
    }));
    await view.onOpen();

    expect(view.contentEl.querySelectorAll('.atl-home-focus-card')).toHaveLength(3);
    expect(view.contentEl.querySelectorAll('.atl-home-queue-row')).toHaveLength(3);

    const todayTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.querySelector('.atl-home-tab-label')?.textContent === '推进');
    fireEvent.click(todayTab!);
    expect(view.contentEl.querySelectorAll('.atl-home-today-tasks .atl-home-task')).toHaveLength(4);

    const inputTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.querySelector('.atl-home-tab-label')?.textContent === '输入');
    fireEvent.click(inputTab!);
    expect(view.contentEl.querySelectorAll('.atl-home-input-list .atl-home-task')).toHaveLength(6);
  });

  it('describes heatmap days using the selected contribution mode', async () => {
    const base = state();
    const { view } = setup(state({
      token: {
        ...base.token,
        snapshot: {
          ...base.token.snapshot!,
          days: [{
            ...base.token.snapshot!.days[0]!,
            normalized: 64_229_257,
          }],
        },
      },
    }));
    await view.onOpen();

    const outputsMode = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')]
      .find((button) => button.textContent === '产出');
    fireEvent.click(outputsMode!);
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('aria-label'))
      .toContain('1 个有效产出');
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('title'))
      .toBeNull();

    const aiMode = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')]
      .find((button) => button.textContent === 'AI');
    fireEvent.click(aiMode!);
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('aria-label'))
      .toContain('6422.93万 Normalized Token');
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('title'))
      .toBeNull();
  });

  it('switches between real task views and marks article consumption as pending', async () => {
    const { view } = setup();
    await view.onOpen();

    const inputTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.textContent?.includes('输入'));
    fireEvent.click(inputTab!);
    expect(view.contentEl.querySelector('.atl-home-view-input')).not.toBeNull();
    expect(view.contentEl.textContent).toContain('判断首页输入');

    const overviewTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.textContent?.includes('总览'));
    fireEvent.click(overviewTab!);
    const consumeMode = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')]
      .find((button) => button.textContent === '消费');
    fireEvent.click(consumeMode!);
    expect(view.contentEl.textContent).toContain('文章消费标记待接入');
    expect(view.contentEl.querySelector('.atl-home-trends')).toBeNull();
    expect(view.contentEl.textContent).not.toContain('Normalized Token');
  });

  it('keeps legacy tasks without a title visible and actionable', async () => {
    const base = state();
    const untitledTask = {
      ...base.home.snapshot!.focusTasks[0]!,
      taskId: 'task-untitled',
      title: '   ',
    };
    const { openTask, view } = setup(state({
      home: {
        status: 'ready',
        errorCode: null,
        snapshot: {
          ...base.home.snapshot!,
          focusTasks: [untitledTask],
          nextAction: untitledTask,
        },
      },
    }));
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('未命名任务');
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-task-id="task-untitled"]',
    )!);
    expect(openTask).toHaveBeenCalledWith('task-untitled');
  });

  it('places consecutive dates into Monday-based week columns', async () => {
    const { view } = setup();
    await view.onOpen();

    const sunday = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-date="2026-07-19"]',
    );
    const monday = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-date="2026-07-20"]',
    );
    const tuesday = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-date="2026-07-21"]',
    );

    expect(sunday?.style.gridRow).toBe('7');
    expect(sunday?.style.gridColumn).toBe('25');
    expect(monday?.style.gridRow).toBe('1');
    expect(monday?.style.gridColumn).toBe('26');
    expect(tuesday?.style.gridRow).toBe('2');
    expect(tuesday?.style.gridColumn).toBe('26');
  });

  it('fills partial edge weeks with non-interactive heatmap placeholders', async () => {
    const base = state();
    const days = contributionDays(182);
    const { view } = setup(state({
      contribution: {
        ...base.contribution,
        snapshot: { ...base.contribution.snapshot!, days },
      },
    }));
    await view.onOpen();

    const placeholders = [...view.contentEl.querySelectorAll<HTMLElement>(
      '.atl-contribution-placeholder',
    )];
    const slots = [...view.contentEl.querySelectorAll<HTMLElement>(
      '.atl-contribution-day, .atl-contribution-placeholder',
    )];
    expect(slots).toHaveLength(182);
    expect(view.contentEl.querySelectorAll('.atl-contribution-day')).toHaveLength(176);
    expect(placeholders).toHaveLength(6);
    expect(placeholders[0]?.tagName).toBe('SPAN');
    expect(placeholders[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(placeholders[0]?.style.gridRow).toBe('2');
    expect(placeholders[0]?.style.gridColumn).toBe('26');
    expect(placeholders.at(-1)?.style.gridRow).toBe('7');
    expect(placeholders.at(-1)?.style.gridColumn).toBe('26');
    expect(Math.max(...slots.map((slot) => Number(slot.style.gridColumn)))).toBe(26);
  });

  it('keeps the heatmap layout fixed while the trend range changes', async () => {
    const base = state();
    const { view } = setup(state({
      range: '7d',
      contribution: {
        ...base.contribution,
        snapshot: base.contribution.snapshot === null
          ? null
          : { ...base.contribution.snapshot, range: '1y' },
      },
    }));
    await view.onOpen();

    expect(view.contentEl.querySelector('.atl-contribution-heatmap')?.getAttribute('data-range'))
      .toBe('26w');
  });

  it('supports range, date, refresh, task, and artifact actions', async () => {
    const { controller, openTask, openArtifact, view } = setup();
    await view.onOpen();

    const sevenDays = [...view.contentEl.querySelectorAll<HTMLButtonElement>(
      '.atl-contribution-range',
    )].find((button) => button.textContent === '7 天');
    expect(sevenDays?.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sevenDays!);
    expect(controller.setRange).toHaveBeenCalledWith('7d');

    const day = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-date="2026-07-19"]',
    );
    expect(day?.getAttribute('aria-label')).toContain('Normalized Token');
    expect(day?.style.gridRow).toBe('7');
    fireEvent.click(day!);
    expect(controller.setSelectedDate).toHaveBeenCalledWith('2026-07-19');

    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[aria-label="刷新数据"]',
    )!);
    expect(controller.refreshAll).toHaveBeenCalledOnce();

    const reviewTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.querySelector('.atl-home-tab-label')?.textContent === '复盘');
    fireEvent.click(reviewTab!);
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-task-id="task-a"]',
    )!);
    expect(openTask).toHaveBeenCalledWith('task-a');
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-artifact-ref]',
    )!);
    expect(openArtifact).toHaveBeenCalledWith(
      'Artifacts/task-a/attempt-001.md',
      'task-a',
    );
  });

  it('keeps contribution visible when OpenToken is missing', async () => {
    const missing = state({
      token: { status: 'missing', snapshot: null, errorCode: 'missing' },
    });
    const { view } = setup(missing);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('今日完成');
    expect(view.contentEl.textContent).toContain('未检测到 OpenToken');
    const reviewTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.querySelector('.atl-home-tab-label')?.textContent === '复盘');
    fireEvent.click(reviewTab!);
    expect(view.contentEl.textContent).toContain('Build dashboard');
  });

  it('shows a clear source error when ATL contribution data cannot be read', async () => {
    const failed = state({
      contribution: { status: 'error', snapshot: null, errorCode: 'query_failed' },
    });
    const { view } = setup(failed);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('ATL 任务读取失败');
    expect(view.contentEl.textContent).not.toContain('ATL 任务读取中');
  });

  it('shows OpenToken recovery when the selected day has no outputs', async () => {
    const base = state();
    const missing = state({
      contribution: {
        ...base.contribution,
        snapshot: base.contribution.snapshot === null
          ? null
          : { ...base.contribution.snapshot, outputs: [] },
      },
      token: { status: 'missing', snapshot: null, errorCode: 'missing' },
    });
    const { view } = setup(missing);
    await view.onOpen();

    const reviewTab = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-home-tab')]
      .find((button) => button.querySelector('.atl-home-tab-label')?.textContent === '复盘');
    fireEvent.click(reviewTab!);
    expect(view.contentEl.textContent).toContain('当天没有可核对产出');
    expect(view.contentEl.textContent).toContain('查看数据源设置');
  });

  it('retains stable chart containers while refreshing and disposes cleanly', async () => {
    const fixture = setup();
    await fixture.view.onOpen();
    const firstCharts = fixture.view.contentEl.querySelectorAll('.atl-contribution-chart');

    fixture.publish(state({ refreshing: true }));

    expect(firstCharts).toHaveLength(2);
    expect(fixture.view.contentEl.querySelectorAll('.atl-contribution-chart')).toHaveLength(2);
    await fixture.view.onClose();
    expect(fixture.controller.dispose).toHaveBeenCalledOnce();
  });
});
