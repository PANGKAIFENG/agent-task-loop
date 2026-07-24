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

function state(overrides: Partial<ContributionDashboardState> = {}): ContributionDashboardState {
  return {
    range: '12w',
    selectedDate: '2026-07-20',
    contribution: {
      status: 'ready',
      errorCode: null,
      snapshot: {
        range: '12w',
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
        coverage: { historicalCompletionDateUnavailable: 1 },
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

function setup(initial = state()) {
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
  const view = new WorkContributionView(new WorkspaceLeaf(), {
    createController: () => controller as never,
    openTask,
    openArtifact,
    openSettings: vi.fn(),
  });
  return {
    controller,
    openTask,
    openArtifact,
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

  it('presents the pulse summary as one streak hero with three real supporting metrics', async () => {
    const { view } = setup();
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
    const { view } = setup();
    await view.onOpen();

    const outputsMode = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')]
      .find((button) => button.textContent === '产出');
    fireEvent.click(outputsMode!);
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('aria-label'))
      .toContain('1 个有效产出');
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('title'))
      .toContain('1 个有效产出');

    const aiMode = [...view.contentEl.querySelectorAll<HTMLButtonElement>('.atl-pulse-mode')]
      .find((button) => button.textContent === 'AI');
    fireEvent.click(aiMode!);
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('aria-label'))
      .toContain('180 Normalized Token');
    expect(view.contentEl.querySelector('[data-date="2026-07-20"]')?.getAttribute('title'))
      .toContain('180 Normalized Token');
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
    expect(sunday?.style.gridColumn).toBe('1');
    expect(monday?.style.gridRow).toBe('1');
    expect(monday?.style.gridColumn).toBe('2');
    expect(tuesday?.style.gridRow).toBe('2');
    expect(tuesday?.style.gridColumn).toBe('2');
  });

  it('keeps the heatmap layout tied to the loaded snapshot while a new range is loading', async () => {
    const base = state();
    const { view } = setup(state({
      range: '7d',
      contribution: {
        ...base.contribution,
        snapshot: base.contribution.snapshot === null
          ? null
          : { ...base.contribution.snapshot, range: '26w' },
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
    expect(day?.getAttribute('aria-label')).toContain('1 个完成任务');
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
