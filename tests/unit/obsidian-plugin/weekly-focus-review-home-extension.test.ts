/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import type { WeeklyFocusDocument } from '../../../src/services/weekly-focus.js';
import {
  WeeklyFocusReviewHomeExtension,
} from '../../../src/obsidian-plugin/weekly-focus-review-home-extension.js';

function weeklyDocument(
  week: string,
  reviewStatus: '待复盘' | '已复盘',
): WeeklyFocusDocument {
  return {
    path: `05_Reviews/Weekly/${week} 周度重点.md`,
    raw: `synthetic ${week}`,
    record: {
      type: '周度重点',
      week,
      status: '已确认',
      linkedGoals: [],
      linkedTasks: [],
      createdBy: 'ATL 思考教练',
      confirmedAt: '2026-08-12T10:00:00+08:00',
      reviewStatus,
      review: null,
      reviewedAt: reviewStatus === '已复盘' ? '2026-08-16T20:00:00+08:00' : null,
      updatedAt: '2026-08-16T20:00:00+08:00',
      input: {
        conversationTopic: '合成周重点',
        selectedSources: ['任务'],
        currentQuestion: '本周结果如何？',
        coachSummary: '合成数据。',
        focuses: [{
          focus: `${week} 合成重点`,
          outcome: '形成结果',
          whyThisWeek: '本周承诺',
          evidence: '验收事实',
          deferredTaskQuestions: [],
        }],
        noNewFocus: false,
        notDoing: [],
        background: { facts: [], assumptions: [], gaps: [], sources: [] },
        coachInsights: [],
        consideredDirections: [],
        keyAnswers: [],
        linkedGoals: [],
        linkedTasks: [],
        adjustmentNote: '',
        unassignedDeferredTaskQuestions: [],
      },
    },
  };
}

describe('WeeklyFocusReviewHomeExtension', () => {
  it('keeps current empty, previous pending, and reviewed entries separate and compact', async () => {
    const root = document.createElement('div');
    const overview = document.createElement('main');
    overview.className = 'atl-home-view-overview';
    const focus = document.createElement('section');
    focus.className = 'atl-home-focus';
    overview.append(focus);
    root.append(overview);
    const openReview = vi.fn();
    const extension = new WeeklyFocusReviewHomeExtension(root, {
      loadIndex: vi.fn(async () => ({
        currentWeek: '2026-W34',
        current: null,
        previousPending: [weeklyDocument('2026-W33', '待复盘')],
        reviewed: [weeklyDocument('2026-W32', '已复盘')],
        readFailures: [],
      })),
      openReview,
    });

    extension.start();
    await vi.waitFor(() => expect(root.textContent).toContain('本周尚未确认重点'));

    expect(root.textContent).toContain('上一周待复盘');
    expect(root.textContent).toContain('2026-W33');
    expect(root.textContent).toContain('已复盘记录');
    expect(root.textContent).toContain('2026-W32');
    expect(root.querySelectorAll('.atl-weekly-focus-review-home')).toHaveLength(1);
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('select')).toBeNull();

    const pending = [...root.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('2026-W33'));
    expect(pending).toBeDefined();
    pending?.click();
    expect(openReview).toHaveBeenCalledWith('2026-W33');
    extension.stop();
  });

  it('reattaches after the personal home rerenders without duplicating the entry', async () => {
    const root = document.createElement('div');
    const firstOverview = document.createElement('main');
    firstOverview.className = 'atl-home-view-overview';
    root.append(firstOverview);
    const extension = new WeeklyFocusReviewHomeExtension(root, {
      loadIndex: vi.fn(async () => ({
        currentWeek: '2026-W34',
        current: weeklyDocument('2026-W34', '待复盘'),
        previousPending: [],
        reviewed: [],
        readFailures: [],
      })),
      openReview: vi.fn(),
    });
    extension.start();
    await vi.waitFor(() => expect(root.textContent).toContain('本周待复盘'));

    const secondOverview = document.createElement('main');
    secondOverview.className = 'atl-home-view-overview';
    root.replaceChildren(secondOverview);
    await vi.waitFor(() => expect(secondOverview.textContent).toContain('本周待复盘'));
    expect(root.querySelectorAll('.atl-weekly-focus-review-home')).toHaveLength(1);
    extension.stop();
  });

  it('distinguishes an explicit no-new-focus decision from a missing weekly record', async () => {
    const root = document.createElement('div');
    const overview = document.createElement('main');
    overview.className = 'atl-home-view-overview';
    root.append(overview);
    const noNewFocus = weeklyDocument('2026-W34', '待复盘');
    noNewFocus.record.input.focuses = [];
    noNewFocus.record.input.noNewFocus = true;
    const extension = new WeeklyFocusReviewHomeExtension(root, {
      loadIndex: vi.fn(async () => ({
        currentWeek: '2026-W34',
        current: noNewFocus,
        previousPending: [],
        reviewed: [],
        readFailures: [],
      })),
      openReview: vi.fn(),
    });

    extension.start();
    await vi.waitFor(() => expect(root.textContent).toContain('本周明确不新增重点'));
    expect(root.textContent).not.toContain('0 项已确认重点');
    extension.stop();
  });
});
