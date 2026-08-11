import { describe, expect, it } from 'vitest';

import type { MaterialGap } from '../../../src/domain/material-gap.js';
import type { MeetingMatchDecision } from '../../../src/domain/meeting-match-decision.js';
import type { ProgressVersion } from '../../../src/domain/progress.js';
import type { WeeklyReportVersion } from '../../../src/domain/weekly-report.js';
import type { WeeklyReviewDecision } from '../../../src/domain/weekly-review.js';
import type { Task } from '../../../src/domain/task.js';
import type { DingTalkMeetingSource } from '../../../src/obsidian-plugin/meeting-note.js';
import { queryWorkProgressHub } from '../../../src/services/query-work-progress-hub.js';
import type { QianwenSourceRuntimeState } from '../../../src/storage/qianwen-source-state-repository.js';

const EVENT_HASH = `sha256:${'a'.repeat(64)}`;

function sourceState(): QianwenSourceRuntimeState {
  return {
    schemaVersion: 2,
    lastAttemptedDate: '2026-08-11',
    lastScan: {
      connector: {
        status: 'connected',
        resultKind: 'success',
        scannedAt: '2026-08-11T14:00:00+08:00',
        range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      },
      recordings: [
        { id: 'recording-a', status: 'available', error: null },
        { id: 'recording-b', status: 'waiting', error: null },
      ],
    },
    lastSuccessfulScan: {
      connector: {
        status: 'connected',
        resultKind: 'success',
        scannedAt: '2026-08-11T14:00:00+08:00',
        range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      },
      recordings: [
        { id: 'recording-a', status: 'available', error: null },
        { id: 'recording-b', status: 'waiting', error: null },
      ],
    },
    recordings: {
      'recording-a': {
        currentVersion: 1,
        versions: [{
          id: 'recording-a',
          version: 1,
          fingerprint: 'f'.repeat(64),
          capturedAt: '2026-08-11T14:00:00+08:00',
          status: 'available',
          error: null,
          title: '团队目标设定讨论',
          createdAt: '2026-08-10T19:56:00+08:00',
          durationSeconds: 701,
          sourceUrl: 'https://qianwen.example/recording-a',
          transcriptComplete: true,
          transcript: '本周确认 OKR 衡量标准。',
          summary: '确认 OKR。',
        }],
      },
      'recording-b': {
        currentVersion: 1,
        versions: [{
          id: 'recording-b',
          version: 1,
          fingerprint: 'e'.repeat(64),
          capturedAt: '2026-08-11T14:00:00+08:00',
          status: 'waiting',
          error: null,
          title: '等待中的听记',
          createdAt: '2026-08-11T10:00:00+08:00',
          durationSeconds: 300,
          sourceUrl: 'https://qianwen.example/recording-b',
          transcriptComplete: false,
          transcript: '',
          summary: '',
        }],
      },
    },
  };
}

function calendar(): DingTalkMeetingSource {
  return {
    eventPath: `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`,
    eventKeyHash: EVENT_HASH,
    title: '钟炜彬 OKR',
    scheduled: '2026-08-10T19:00:00+08:00',
    meetingDate: '2026-08-10',
    durationMinutes: 60,
  };
}

function progress(): ProgressVersion {
  return {
    schemaVersion: 1,
    progressId: 'progress-a',
    version: 2,
    lifecycleStatus: 'eligible',
    topic: '精恭纺验收分类',
    reportCategory: 'project_acceptance',
    primaryProjectId: 'project-a',
    occurredAt: '2026-08-10T16:00:00+08:00',
    sources: ['08_Meetings/2026-08/meeting-a.md'],
    statements: [{
      kind: 'fact',
      text: '分类口径已确认。',
      sourceRefs: ['08_Meetings/2026-08/meeting-a.md'],
    }],
    evidence: [{
      kind: 'confirmed_decision',
      summary: '分类口径已确认。',
      sourceRef: '08_Meetings/2026-08/meeting-a.md',
    }],
    selfEvidence: [],
    agentEvidence: [],
    contribution: 'team',
    eligibility: { status: 'eligible', matchedEvidence: ['confirmed_decision'], reasons: [] },
    supersedesVersion: 1,
    createdAt: '2026-08-11T01:00:00.000Z',
  };
}

function materialGap(): MaterialGap {
  return {
    schemaVersion: 1,
    gapId: 'gap-a',
    progressId: 'progress-a',
    progressVersion: 2,
    missing: { kind: 'numeric', description: '四类事项准确数量', purpose: '周报' },
    searches: [],
    suggestedContact: null,
    status: 'needs_contact',
    resolvedSourceRef: null,
    messageDraft: null,
    createdAt: '2026-08-11T02:00:00.000Z',
  };
}

function weeklyReport(): WeeklyReportVersion {
  return {
    schemaVersion: 1,
    weeklyId: 'weekly-2026-W33',
    version: 2,
    weekKey: '2026-W33',
    week: { startDate: '2026-08-10', endDate: '2026-08-16' },
    acceptanceState: 'pending',
    publicationState: 'not_published',
    completeness: 'partial_success',
    progressRefs: [{ progressId: 'progress-a', version: 2 }],
    sections: [],
    omissions: [],
    excludedProgressIds: [],
    pendingCount: 1,
    supersedesVersion: 1,
    createdAt: '2026-08-11T03:00:00.000Z',
  };
}

function weeklyDecision(): WeeklyReviewDecision {
  return {
    schemaVersion: 1,
    eventId: 'review-a',
    weeklyId: 'weekly-2026-W33',
    version: 2,
    action: 'later',
    feedback: null,
    publicationState: 'not_published',
    decidedAt: '2026-08-11T04:00:00.000Z',
  };
}

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-artifact-a',
    title: 'Staywork 需求方案',
    body: '\nSynthetic review task.\n',
    status: 'review',
    reviewState: 'confirmed',
    projectId: 'project-staywork',
    taskType: 'research',
    objective: 'Produce a synthetic requirement artifact.',
    acceptanceCriteria: ['Scope is explicit.', 'Risks are listed.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-11',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:review-task',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 2,
    claim: null,
    artifactRefs: [
      'Artifacts/task-artifact-a/attempt-001.md',
      'Artifacts/task-artifact-a/attempt-002.md',
    ],
    reviewFeedback: null,
    readyAt: '2026-08-11T01:00:00.000Z',
    createdAt: '2026-08-11T01:00:00.000Z',
    updatedAt: '2026-08-11T02:00:00.000Z',
    ...overrides,
  };
}

describe('queryWorkProgressHub', () => {
  it('projects real source, match, progress, material, and weekly repositories without inventing data', async () => {
    const result = await queryWorkProgressHub({
      sourceRepository: { load: async () => sourceState(), save: async () => undefined },
      decisionRepository: {
        create: async (value: MeetingMatchDecision) => value,
        list: async () => [],
        listActive: async () => [],
      },
      progressRepository: {
        create: async (value: ProgressVersion) => value,
        listVersions: async () => [progress()],
        listCurrent: async () => [progress()],
      },
      materialGapRepository: {
        create: async (value: MaterialGap) => value,
        get: async () => materialGap(),
        list: async () => [materialGap()],
      },
      weeklyRepository: {
        create: async (value: WeeklyReportVersion) => value,
        listVersions: async () => [weeklyReport()],
        listCurrent: async () => [weeklyReport()],
      },
      weeklyDecisionRepository: {
        create: async (value: WeeklyReviewDecision) => value,
        listForWeekly: async () => [weeklyDecision()],
      },
      taskRepository: {
        list: async () => [reviewTask(), reviewTask({
          taskId: 'task-done',
          title: 'Already accepted',
          status: 'done',
          artifactRefs: ['Artifacts/task-done/attempt-001.md'],
        })],
      } as never,
      notificationLedger: {
        list: async () => [{
          schemaVersion: 1,
          idempotencyKey: 'artifact:task-artifact-a:2',
          objectType: 'artifact',
          objectId: 'task-artifact-a',
          version: 2,
          uuid: 'cc9169e9-5326-54f8-a190-419f55ae8004',
          status: 'sent',
          attemptedAt: '2026-08-11T14:00:00.000Z',
          errorCode: null,
          taskId: 'synthetic-task',
          messageId: null,
        }, {
          schemaVersion: 1,
          idempotencyKey: 'weekly:weekly-2026-W33:2',
          objectType: 'weekly',
          objectId: 'weekly-2026-W33',
          version: 2,
          uuid: '706f2f51-aae7-55eb-b81a-555abc785910',
          status: 'conflict',
          attemptedAt: '2026-08-11T14:01:00.000Z',
          errorCode: 'acceptance_location_conflict',
          taskId: null,
          messageId: null,
        }],
      },
      listCalendarSources: async () => [calendar()],
    });

    expect(result.source).toEqual({
      status: 'connected',
      scannedAt: '2026-08-11T14:00:00+08:00',
      lastSuccessfulScanAt: '2026-08-11T14:00:00+08:00',
      available: 1,
      waiting: 1,
      failed: 0,
    });
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({
      recordingId: 'recording-a',
      status: 'available',
      candidates: [{
        eventKeyHash: EVENT_HASH,
        title: '钟炜彬 OKR',
      }],
    });
    expect(result.matches[1]).toMatchObject({
      recordingId: 'recording-b',
      status: 'waiting',
      candidates: [],
    });
    expect(result.progress[0]).toMatchObject({
      progressId: 'progress-a',
      path: '09_Progress/Items/2026-08/progress-a-v2.md',
    });
    expect(result.materialGaps[0]).toMatchObject({
      gapId: 'gap-a',
      path: '09_Progress/Requests/2026-08/gap-a.md',
    });
    expect(result.weeklyReports[0]).toMatchObject({
      weeklyId: 'weekly-2026-W33',
      acceptanceState: 'later',
      path: '09_Progress/Weekly/2026-W33-v2.md',
    });
    expect(result.acceptanceObjects).toEqual([
      {
        objectType: 'artifact',
        objectId: 'task-artifact-a',
        version: 2,
        title: 'Staywork 需求方案',
        state: 'pending',
        pendingCount: 2,
        path: '10_Tasks/Artifacts/task-artifact-a/attempt-002.md',
        notification: {
          status: 'sent',
          attemptedAt: '2026-08-11T14:00:00.000Z',
          errorCode: null,
        },
      },
      {
        objectType: 'weekly',
        objectId: 'weekly-2026-W33',
        version: 2,
        title: '2026-W33 工作进展周报',
        state: 'later',
        pendingCount: 1,
        path: '09_Progress/Weekly/2026-W33-v2.md',
        notification: {
          status: 'conflict',
          attemptedAt: '2026-08-11T14:01:00.000Z',
          errorCode: 'acceptance_location_conflict',
        },
      },
    ]);
  });

  it('keeps a failed connector visible while preserving last successful data', async () => {
    const failed = sourceState();
    failed.lastScan = {
      connector: {
        status: 'login_required',
        resultKind: 'failed',
        scannedAt: '2026-08-11T15:00:00+08:00',
        range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      },
      recordings: [],
    };

    const result = await queryWorkProgressHub({
      sourceRepository: { load: async () => failed, save: async () => undefined },
      decisionRepository: { listActive: async () => [] } as never,
      progressRepository: { listCurrent: async () => [] } as never,
      materialGapRepository: { list: async () => [] } as never,
      weeklyRepository: { listCurrent: async () => [] } as never,
      weeklyDecisionRepository: { listForWeekly: async () => [] } as never,
      taskRepository: { list: async () => [] } as never,
      listCalendarSources: async () => [],
    });

    expect(result.source).toMatchObject({
      status: 'login_required',
      scannedAt: '2026-08-11T15:00:00+08:00',
      lastSuccessfulScanAt: '2026-08-11T14:00:00+08:00',
      available: 1,
      waiting: 1,
    });
    expect(result.matches).toHaveLength(2);
  });

  it('projects multiple editable progress drafts from an active meeting decision and meeting path', async () => {
    const state = sourceState();
    const recording = state.recordings['recording-a']!.versions[0]!;
    recording.summary = [
      '## 验收分类',
      '已讨论按四类整理验收事项。',
      '## 交付资料',
      '需求分类表仍待补齐。',
    ].join('\n');

    const result = await queryWorkProgressHub({
      sourceRepository: { load: async () => state, save: async () => undefined },
      decisionRepository: {
        listActive: async () => [{
          schemaVersion: 1,
          decisionId: 'decision-confirmed',
          action: 'confirmed',
          recordingId: 'recording-a',
          eventKeyHash: EVENT_HASH,
          supersedesDecisionId: null,
          decidedAt: '2026-08-11T05:00:00.000Z',
        }],
      } as never,
      progressRepository: { listCurrent: async () => [] } as never,
      materialGapRepository: { list: async () => [] } as never,
      weeklyRepository: { listCurrent: async () => [] } as never,
      weeklyDecisionRepository: { listForWeekly: async () => [] } as never,
      taskRepository: { list: async () => [] } as never,
      listCalendarSources: async () => [calendar()],
      findMeetingPath: async (recordingId) => (
        recordingId === 'recording-a'
          ? '08_Meetings/2026-08/meeting-a.md'
          : null
      ),
    });

    expect(result.matches.find(({ recordingId }) => recordingId === 'recording-a'))
      .toMatchObject({
        activeDecision: { action: 'confirmed', eventKeyHash: EVENT_HASH },
        progressDrafts: [{
          topic: '验收分类',
          occurredAt: '2026-08-10T19:00:00+08:00',
          sources: ['08_Meetings/2026-08/meeting-a.md'],
        }, {
          topic: '交付资料',
          occurredAt: '2026-08-10T19:00:00+08:00',
          sources: ['08_Meetings/2026-08/meeting-a.md'],
        }],
      });
  });

  it('does not expose a revoked meeting decision as the active match', async () => {
    const result = await queryWorkProgressHub({
      sourceRepository: { load: async () => sourceState(), save: async () => undefined },
      decisionRepository: {
        listActive: async () => [{
          schemaVersion: 1,
          decisionId: 'decision-revoked',
          action: 'revoked',
          recordingId: 'recording-a',
          eventKeyHash: EVENT_HASH,
          supersedesDecisionId: 'decision-confirmed',
          decidedAt: '2026-08-11T05:00:00.000Z',
        }],
      } as never,
      progressRepository: { listCurrent: async () => [] } as never,
      materialGapRepository: { list: async () => [] } as never,
      weeklyRepository: { listCurrent: async () => [] } as never,
      weeklyDecisionRepository: { listForWeekly: async () => [] } as never,
      taskRepository: { list: async () => [] } as never,
      listCalendarSources: async () => [],
    });

    expect(result.matches.find(({ recordingId }) => recordingId === 'recording-a'))
      .toMatchObject({ activeDecision: null });
  });
});
