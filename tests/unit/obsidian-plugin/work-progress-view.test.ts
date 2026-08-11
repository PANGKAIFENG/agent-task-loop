/* @vitest-environment jsdom */

import { fireEvent } from '@testing-library/react';
import { WorkspaceLeaf } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkProgressHubState,
} from '../../../src/obsidian-plugin/work-progress-hub-controller.js';
import {
  WORK_PROGRESS_VIEW_TYPE,
  WorkProgressView,
} from '../../../src/obsidian-plugin/work-progress-view.js';

function readyState(): WorkProgressHubState {
  return {
    status: 'ready',
    activeTab: 'matches',
    selectedCandidate: null,
    busyAction: null,
    errorCode: null,
    snapshot: {
      source: {
        status: 'connected',
        scannedAt: '2026-08-11T14:00:00+08:00',
        lastSuccessfulScanAt: '2026-08-11T14:00:00+08:00',
        available: 1,
        waiting: 1,
        failed: 0,
      },
      matches: [{
        recordingId: 'recording-a',
        title: '团队目标设定讨论',
        createdAt: '2026-08-10T19:56:00+08:00',
        status: 'available',
        activeDecision: null,
        candidates: [{
          eventKeyHash: `sha256:${'a'.repeat(64)}`,
          eventPath: `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`,
          title: '钟炜彬 OKR',
          scheduled: '2026-08-10T19:00:00+08:00',
          score: 0.85,
          support: ['日期一致', '主题词匹配：okr'],
          opposition: [],
          missing: ['参会人未核验'],
        }],
      }],
      progress: [{
        progressId: 'progress-a',
        version: 2,
        topic: '精恭纺验收分类',
        projectId: 'project-a',
        lifecycleStatus: 'eligible',
        path: '09_Progress/Items/2026-08/progress-a-v2.md',
      }],
      materialGaps: [{
        gapId: 'gap-a',
        title: '四类事项准确数量',
        status: 'needs_contact',
        path: '09_Progress/Requests/2026-08/gap-a.md',
      }],
      weeklyReports: [{
        weeklyId: 'weekly-2026-W33',
        version: 2,
        weekKey: '2026-W33',
        acceptanceState: 'pending',
        publicationState: 'not_published',
        completeness: 'partial_success',
        pendingCount: 1,
        path: '09_Progress/Weekly/2026-W33-v2.md',
      }],
      acceptanceObjects: [{
        objectType: 'weekly',
        objectId: 'weekly-2026-W33',
        version: 2,
        title: '2026-W33 工作进展周报',
        state: 'pending',
        pendingCount: 1,
        path: '09_Progress/Weekly/2026-W33-v2.md',
        notification: null,
      }],
    },
  };
}

function setup(initial = readyState()) {
  let state = initial;
  let listener: ((value: WorkProgressHubState) => void) | null = null;
  const controller = {
    subscribe: vi.fn((callback: (value: WorkProgressHubState) => void) => {
      listener = callback;
      callback(state);
      return () => { listener = null; };
    }),
    initialize: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    setActiveTab: vi.fn((activeTab: WorkProgressHubState['activeTab']) => {
      state = { ...state, activeTab };
      listener?.(state);
    }),
    selectCandidate: vi.fn((recordingId: string, eventKeyHash: string) => {
      state = { ...state, selectedCandidate: { recordingId, eventKeyHash } };
      listener?.(state);
    }),
    confirmSelectedMatch: vi.fn(async () => undefined),
    markSelectedRecordingWithoutCalendar: vi.fn(async () => undefined),
    revokeDecision: vi.fn(async () => undefined),
    acceptWeeklyReport: vi.fn(async () => undefined),
    rejectWeeklyReport: vi.fn(async () => undefined),
    deferWeeklyReport: vi.fn(async () => undefined),
    generateCurrentWeeklyReport: vi.fn(async () => undefined),
    retrySource: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const openPath = vi.fn(async () => undefined);
  const requestWeeklyFeedback = vi.fn(async () => '压缩背景，补充输出。');
  const view = new WorkProgressView(new WorkspaceLeaf(), {
    createController: () => controller as never,
    openPath,
    requestWeeklyFeedback,
  });
  return { controller, openPath, requestWeeklyFeedback, view };
}

describe('WorkProgressView', () => {
  it('renders four real-data tabs and never preselects a meeting candidate', async () => {
    const { view } = setup();
    await view.onOpen();

    expect(view.getViewType()).toBe(WORK_PROGRESS_VIEW_TYPE);
    expect(view.getDisplayText()).toBe('工作沉淀');
    expect(view.contentEl.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(view.contentEl.textContent).toContain('待匹配听记');
    expect(view.contentEl.textContent).toContain('工作进展');
    expect(view.contentEl.textContent).toContain('待补材料');
    expect(view.contentEl.textContent).toContain('待验收');
    expect(view.contentEl.textContent).toContain('千问已连接');
    expect(view.contentEl.textContent).toContain('主题词匹配：okr');
    expect(view.contentEl.querySelector<HTMLInputElement>(
      'input[type="radio"]',
    )?.checked).toBe(false);
  });

  it('offers a manual current-week generation action in the header', async () => {
    const { controller, view } = setup();
    await view.onOpen();

    const generate = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="generate-weekly"]',
    );
    expect(generate?.textContent).toContain('生成本周周报');
    fireEvent.click(generate!);

    expect(controller.generateCurrentWeeklyReport).toHaveBeenCalledOnce();
  });

  it('requires candidate selection in the view and routes match actions through the controller', async () => {
    const { controller, view } = setup();
    await view.onOpen();

    const confirm = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-match"]',
    );
    expect(confirm?.disabled).toBe(true);
    fireEvent.click(view.contentEl.querySelector<HTMLInputElement>('input[type="radio"]')!);

    expect(controller.selectCandidate).toHaveBeenCalledWith(
      'recording-a',
      `sha256:${'a'.repeat(64)}`,
    );
    expect(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-match"]',
    )?.disabled).toBe(false);
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="confirm-match"]',
    )!);
    expect(controller.confirmSelectedMatch).toHaveBeenCalledOnce();
  });

  it('opens persisted objects and keeps weekly review actions independent', async () => {
    const { controller, openPath, requestWeeklyFeedback, view } = setup();
    await view.onOpen();

    fireEvent.click([...view.contentEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('工作进展'))!);
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>('[data-open-path]')!);
    expect(openPath).toHaveBeenCalledWith('09_Progress/Items/2026-08/progress-a-v2.md');

    fireEvent.click([...view.contentEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.includes('待验收'))!);
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="accept-weekly"]',
    )!);
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="reject-weekly"]',
    )!);
    await Promise.resolve();
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="defer-weekly"]',
    )!);

    expect(controller.acceptWeeklyReport).toHaveBeenCalledWith('weekly-2026-W33', 2);
    expect(requestWeeklyFeedback).toHaveBeenCalledOnce();
    expect(controller.rejectWeeklyReport).toHaveBeenCalledWith(
      'weekly-2026-W33',
      2,
      '压缩背景，补充输出。',
    );
    expect(controller.deferWeeklyReport).toHaveBeenCalledWith('weekly-2026-W33', 2);
  });

  it('shows durable DingTalk delivery, failure, conflict, and unconfigured states', async () => {
    const state = readyState();
    const base = state.snapshot!.acceptanceObjects[0]!;
    state.activeTab = 'weekly';
    state.snapshot!.acceptanceObjects = [
      { ...base, objectId: 'weekly-unconfigured', title: '未配置对象', notification: null },
      {
        ...base,
        objectId: 'weekly-sent',
        title: '已发送对象',
        notification: {
          status: 'sent',
          attemptedAt: '2026-08-11T14:00:00.000Z',
          errorCode: null,
        },
      },
      {
        ...base,
        objectId: 'weekly-failed',
        title: '失败对象',
        notification: {
          status: 'failed',
          attemptedAt: '2026-08-11T14:01:00.000Z',
          errorCode: 'dingtalk_delivery_failed',
        },
      },
      {
        ...base,
        objectId: 'weekly-conflict',
        title: '冲突对象',
        notification: {
          status: 'conflict',
          attemptedAt: '2026-08-11T14:02:00.000Z',
          errorCode: 'acceptance_location_conflict',
        },
      },
    ];

    const { view } = setup(state);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('钉钉通知：未配置');
    expect(view.contentEl.textContent).toContain('钉钉通知：已发送');
    expect(view.contentEl.textContent).toContain('钉钉通知：发送失败（dingtalk_delivery_failed）');
    expect(view.contentEl.textContent).toContain('钉钉通知：定位冲突');
  });

  it('keeps source failure visible and offers a service-backed retry', async () => {
    const failed = readyState();
    failed.snapshot!.source.status = 'login_required';
    const { controller, view } = setup(failed);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain('千问需要登录');
    fireEvent.click(view.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="retry-source"]',
    )!);
    expect(controller.retrySource).toHaveBeenCalledOnce();
  });
});
