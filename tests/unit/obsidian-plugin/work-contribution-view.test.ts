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
          { date: '2026-07-19', completed: 1, projectCount: 1, level: 1 },
          { date: '2026-07-20', completed: 2, projectCount: 1, level: 2 },
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
  it('renders the confirmed dashboard structure', async () => {
    const { view } = setup();
    await view.onOpen();

    expect(view.getViewType()).toBe(WORK_CONTRIBUTION_VIEW_TYPE);
    expect(view.getDisplayText()).toBe('个人工作贡献');
    expect(view.contentEl.querySelector('h1')?.textContent).toBe('个人工作贡献');
    expect(view.contentEl.querySelectorAll('.atl-contribution-kpi')).toHaveLength(4);
    expect(view.contentEl.querySelectorAll('.atl-contribution-range')).toHaveLength(3);
    expect(view.contentEl.querySelectorAll('.atl-contribution-day')).toHaveLength(2);
    expect(view.contentEl.querySelectorAll('.atl-contribution-chart')).toHaveLength(2);
    expect(view.contentEl.textContent).toContain('Agent Task Loop');
    expect(view.contentEl.textContent).toContain('Build dashboard');
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
    fireEvent.click(day!);
    expect(controller.setSelectedDate).toHaveBeenCalledWith('2026-07-19');

    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[aria-label="刷新数据"]',
    )!);
    expect(controller.refreshAll).toHaveBeenCalledOnce();

    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-task-id="task-a"]',
    )!);
    expect(openTask).toHaveBeenCalledWith('task-a');
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-artifact-ref]',
    )!);
    expect(openArtifact).toHaveBeenCalledWith('Artifacts/task-a/attempt-001.md');
  });

  it('keeps contribution visible when OpenToken is missing', async () => {
    const missing = state({
      token: { status: 'missing', snapshot: null, errorCode: 'missing' },
    });
    const { view } = setup(missing);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('今日完成');
    expect(view.contentEl.textContent).toContain('未检测到 OpenToken');
    expect(view.contentEl.textContent).toContain('Build dashboard');
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
