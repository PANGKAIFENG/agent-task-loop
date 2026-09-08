/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { WorkspaceLeaf } from 'obsidian';

import type { ContributionDashboardController } from '../../../src/obsidian-plugin/contribution-dashboard-controller.js';
import {
  WeeklyFocusReviewContributionView,
} from '../../../src/obsidian-plugin/weekly-focus-review-contribution-view.js';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WeeklyFocusReviewContributionView', () => {
  it('mounts and refreshes the T7 home extension while preserving the base view lifecycle', async () => {
    const dispose = vi.fn();
    const controller = {
      subscribe: vi.fn(() => vi.fn()),
      initialize: vi.fn(async () => undefined),
      dispose,
      refreshContribution: vi.fn(async () => undefined),
    } as unknown as ContributionDashboardController;
    const loadIndex = vi.fn(async () => ({
      currentWeek: '2026-W34',
      current: null,
      previousPending: [],
      reviewed: [],
      readFailures: [],
    }));
    const view = new WeeklyFocusReviewContributionView(
      new WorkspaceLeaf(),
      {
        createController: () => controller,
        openTask: vi.fn(),
        openArtifact: vi.fn(),
        openCompletionDateBackfill: vi.fn(),
        openSettings: vi.fn(),
        loadWeeklyFocus: vi.fn(async () => null),
        loadWeeklyCoachDraft: vi.fn(async () => null),
        openWeeklyCoach: vi.fn(),
        openWeeklyFocus: vi.fn(),
      },
      {
        loadIndex,
        openReview: vi.fn(),
      },
    );
    const overview = document.createElement('div');
    overview.className = 'atl-home-view-overview';
    view.contentEl.append(overview);

    await view.onOpen();
    await settle();

    expect(view).toBeInstanceOf(WeeklyFocusReviewContributionView);
    expect(loadIndex).toHaveBeenCalledTimes(1);
    expect(view.contentEl.querySelector('.atl-weekly-focus-review-home')).not.toBeNull();

    await view.refreshWeeklyFocusReview();
    expect(loadIndex).toHaveBeenCalledTimes(2);

    await view.onClose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(view.contentEl.querySelector('.atl-weekly-focus-review-home')).toBeNull();
  });
});
