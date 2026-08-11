import { describe, expect, it, vi } from 'vitest';

import {
  WorkProgressHubController,
  type WorkProgressHubSnapshot,
} from '../../../src/obsidian-plugin/work-progress-hub-controller.js';

function snapshot(): WorkProgressHubSnapshot {
  return {
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
      progressDrafts: [],
      candidates: [{
        eventKeyHash: `sha256:${'a'.repeat(64)}`,
        eventPath: `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`,
        title: '钟炜彬 OKR',
        scheduled: '2026-08-10T19:00:00+08:00',
        score: 0.85,
        support: ['日期一致', '主题词匹配：OKR'],
        opposition: ['存在接近候选'],
        missing: ['参会人未核验'],
      }, {
        eventKeyHash: `sha256:${'b'.repeat(64)}`,
        eventPath: `TaskNotes/DingTalk/sha256-${'b'.repeat(64)}.md`,
        title: '团队目标回顾',
        scheduled: '2026-08-10T19:30:00+08:00',
        score: 0.81,
        support: ['日期一致'],
        opposition: ['主题不完全一致'],
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
      status: 'needs_material',
      path: '09_Progress/Requests/2026-08/gap-a.md',
    }],
    weeklyReports: [{
      weeklyId: 'weekly-2026-W33',
      version: 1,
      weekKey: '2026-W33',
      acceptanceState: 'pending',
      publicationState: 'not_published',
      completeness: 'partial_success',
      pendingCount: 1,
      path: '09_Progress/Weekly/2026-W33-v1.md',
    }],
    acceptanceObjects: [{
      objectType: 'weekly',
      objectId: 'weekly-2026-W33',
      version: 1,
      title: '2026-W33 工作进展周报',
      state: 'pending',
      pendingCount: 1,
      path: '09_Progress/Weekly/2026-W33-v1.md',
      notification: null,
    }],
  };
}

function setup() {
  const loadSnapshot = vi.fn(async () => snapshot());
  const confirmMatch = vi.fn(async () => ({
    decisionId: 'decision-a',
    meetingPath: '08_Meetings/2026-08/meeting-a.md',
  }));
  const markNoCalendar = vi.fn(async () => undefined);
  const revokeMatch = vi.fn(async () => undefined);
  const acceptWeekly = vi.fn(async () => undefined);
  const rejectWeekly = vi.fn(async () => undefined);
  const deferWeekly = vi.fn(async () => undefined);
  const generateWeekly = vi.fn(async () => undefined);
  const syncSource = vi.fn(async () => undefined);
  const createProgress = vi.fn(async () => undefined);
  const createMaterialGap = vi.fn(async () => undefined);
  const controller = new WorkProgressHubController({
    loadSnapshot,
    confirmMatch,
    markNoCalendar,
    revokeMatch,
    acceptWeekly,
    rejectWeekly,
    deferWeekly,
    generateWeekly,
    syncSource,
    createProgress,
    createMaterialGap,
  });
  return {
    controller,
    loadSnapshot,
    confirmMatch,
    markNoCalendar,
    revokeMatch,
    acceptWeekly,
    rejectWeekly,
    deferWeekly,
    generateWeekly,
    syncSource,
    createProgress,
    createMaterialGap,
  };
}

describe('WorkProgressHubController', () => {
  it('keeps source health separate from individual transcript states', async () => {
    const { controller } = setup();

    await controller.initialize();

    expect(controller.getState()).toMatchObject({
      status: 'ready',
      snapshot: {
        source: { status: 'connected', available: 1, waiting: 1, failed: 0 },
        matches: [{ status: 'available' }],
      },
    });
  });

  it('retries the source through its service and reloads the real snapshot', async () => {
    const { controller, loadSnapshot, syncSource } = setup();
    await controller.initialize();

    await controller.retrySource();

    expect(syncSource).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not preselect a close candidate and requires an explicit selection to confirm', async () => {
    const { controller, confirmMatch } = setup();
    await controller.initialize();

    expect(controller.getState().selectedCandidate).toBeNull();
    await expect(controller.confirmSelectedMatch()).rejects.toMatchObject({
      code: 'meeting_candidate_required',
    });
    expect(confirmMatch).not.toHaveBeenCalled();

    controller.selectCandidate('recording-a', `sha256:${'b'.repeat(64)}`);
    await controller.confirmSelectedMatch();

    expect(confirmMatch).toHaveBeenCalledWith({
      recordingId: 'recording-a',
      eventKeyHash: `sha256:${'b'.repeat(64)}`,
    });
    expect(controller.getState().selectedCandidate).toBeNull();
  });

  it('routes no-calendar and revoke actions through their services', async () => {
    const { controller, markNoCalendar, revokeMatch } = setup();
    await controller.initialize();

    await controller.markSelectedRecordingWithoutCalendar('recording-a');
    await controller.revokeDecision('decision-a');

    expect(markNoCalendar).toHaveBeenCalledWith({ recordingId: 'recording-a' });
    expect(revokeMatch).toHaveBeenCalledWith({ decisionId: 'decision-a' });
  });

  it('keeps accept, reject, and later as independent weekly actions', async () => {
    const {
      controller,
      acceptWeekly,
      rejectWeekly,
      deferWeekly,
    } = setup();
    await controller.initialize();

    await controller.acceptWeeklyReport('weekly-2026-W33', 1);
    await controller.rejectWeeklyReport('weekly-2026-W33', 1, '压缩背景，补充输出。');
    await controller.deferWeeklyReport('weekly-2026-W33', 1);

    expect(acceptWeekly).toHaveBeenCalledWith({
      weeklyId: 'weekly-2026-W33',
      version: 1,
    });
    expect(rejectWeekly).toHaveBeenCalledWith({
      weeklyId: 'weekly-2026-W33',
      expectedVersion: 1,
      feedback: '压缩背景，补充输出。',
    });
    expect(deferWeekly).toHaveBeenCalledWith({
      weeklyId: 'weekly-2026-W33',
      version: 1,
    });
  });

  it('generates the current weekly snapshot and reloads the hub', async () => {
    const { controller, generateWeekly, loadSnapshot } = setup();
    await controller.initialize();

    await controller.generateCurrentWeeklyReport();

    expect(generateWeekly).toHaveBeenCalledOnce();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it('creates a structured progress version and reloads the hub', async () => {
    const { controller, createProgress, loadSnapshot } = setup();
    await controller.initialize();
    const draft = {
      topic: '精恭纺验收分类',
      reportCategory: 'project_acceptance' as const,
      primaryProjectId: 'project-a',
      occurredAt: '2026-08-11T10:00:00+08:00',
      sources: ['08_Meetings/2026-08/meeting-a.md'],
      statements: [{
        kind: 'fact' as const,
        text: '已确认四类验收事项。',
        sourceRefs: ['08_Meetings/2026-08/meeting-a.md'],
      }],
      evidence: [{
        kind: 'confirmed_decision' as const,
        summary: '会议形成四类划分结论',
        sourceRef: '08_Meetings/2026-08/meeting-a.md',
      }],
      selfEvidence: [],
      agentEvidence: [],
    };

    await controller.createProgressVersion(draft);

    expect(createProgress).toHaveBeenCalledWith(draft);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it('creates a material gap for an explicit progress version and reloads the hub', async () => {
    const { controller, createMaterialGap, loadSnapshot } = setup();
    await controller.initialize();
    const input = {
      progressId: 'progress-a',
      progressVersion: 2,
      missing: {
        kind: 'numeric' as const,
        description: '四类事项的准确数量',
        purpose: '精恭纺验收周报',
      },
      searches: [],
      suggestedContact: null,
    };

    await controller.registerMaterialGap(input);

    expect(createMaterialGap).toHaveBeenCalledWith(input);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    const { controller, loadSnapshot } = setup();

    const first = controller.refresh();
    const second = controller.refresh();
    await Promise.all([first, second]);

    expect(loadSnapshot).toHaveBeenCalledOnce();
  });
});
