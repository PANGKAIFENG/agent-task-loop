import type { DingTalkMeetingSource } from '../obsidian-plugin/meeting-note.js';
import {
  buildQianwenMeetingPreview,
  type QianwenMatchCandidate,
  type QianwenRecording,
} from '../obsidian-plugin/qianwen-meeting-sync.js';
import type {
  WorkProgressHubSnapshot,
  WorkProgressMatchCandidate,
  WorkProgressMatchItem,
} from '../obsidian-plugin/work-progress-hub-controller.js';
import type {
  MaterialGapRepository,
} from '../storage/markdown-material-gap-repository.js';
import type {
  ProgressRepository,
} from '../storage/markdown-progress-repository.js';
import type {
  WeeklyReportRepository,
} from '../storage/markdown-weekly-report-repository.js';
import type {
  MeetingMatchDecisionRepository,
} from '../storage/meeting-match-decision-repository.js';
import type {
  QianwenPersistedRecordingVersion,
  QianwenSourceStateRepository,
} from '../storage/qianwen-source-state-repository.js';
import type {
  WeeklyReviewDecisionRepository,
} from '../storage/weekly-review-decision-repository.js';
import { projectAcceptanceObjects } from '../domain/acceptance-object.js';
import type { TaskRepository } from '../storage/contracts.js';
import type { AcceptanceNotificationLedger } from './notify-acceptance.js';
import { prepareMeetingProgressDrafts } from './prepare-meeting-progress-drafts.js';

export interface QueryWorkProgressHubContext {
  sourceRepository: QianwenSourceStateRepository;
  decisionRepository: MeetingMatchDecisionRepository;
  progressRepository: ProgressRepository;
  materialGapRepository: MaterialGapRepository;
  weeklyRepository: WeeklyReportRepository;
  weeklyDecisionRepository: WeeklyReviewDecisionRepository;
  taskRepository: Pick<TaskRepository, 'list'>;
  notificationLedger?: Pick<AcceptanceNotificationLedger, 'list'>;
  listCalendarSources(): Promise<DingTalkMeetingSource[]>;
  findMeetingPath?(recordingId: string): Promise<string | null>;
}

function currentRecording(
  recording: Awaited<ReturnType<QianwenSourceStateRepository['load']>>['recordings'][string],
): QianwenPersistedRecordingVersion | null {
  return recording.versions.find((version) => version.version === recording.currentVersion) ?? null;
}

function matchableRecording(
  version: QianwenPersistedRecordingVersion,
): QianwenRecording | null {
  if (
    version.title === null
    || version.createdAt === null
    || version.durationSeconds === null
    || version.sourceUrl === null
  ) return null;
  return {
    id: version.id,
    title: version.title,
    createdAt: version.createdAt,
    durationSeconds: version.durationSeconds,
    sourceUrl: version.sourceUrl,
    transcript: version.transcript,
    summary: version.summary,
    transcriptComplete: version.transcriptComplete,
  };
}

function hasEvidence(candidate: QianwenMatchCandidate, prefix: string): boolean {
  return candidate.evidence.some((item) => item.startsWith(prefix));
}

function candidateProjection(
  source: DingTalkMeetingSource,
  candidate: QianwenMatchCandidate,
  closeCandidate: boolean,
): WorkProgressMatchCandidate {
  const opposition: string[] = [];
  if (closeCandidate) opposition.push('存在接近候选');
  if (
    !hasEvidence(candidate, '听记创建时间位于日程时间窗内')
    && !hasEvidence(candidate, '听记在日程结束后 24 小时内创建')
  ) opposition.push('听记创建时间不在日程窗口附近');
  if (
    !hasEvidence(candidate, '主题词匹配')
    && !hasEvidence(candidate, '标题或主题完整包含')
  ) opposition.push('主题未匹配');

  const missing: string[] = [];
  if (!hasEvidence(candidate, '共同参会人')) missing.push('参会人未核验');
  if (!hasEvidence(candidate, '明确项目实体')) missing.push('项目实体未核验');
  if (!candidate.recording.transcriptComplete) missing.push('听记原文未完成');

  return {
    eventKeyHash: source.eventKeyHash,
    eventPath: source.eventPath,
    title: source.title,
    scheduled: source.scheduled,
    score: candidate.score,
    support: candidate.evidence,
    opposition,
    missing,
  };
}

function candidatesForRecording(
  recording: QianwenRecording,
  calendarSources: readonly DingTalkMeetingSource[],
): WorkProgressMatchCandidate[] {
  const scored = calendarSources.flatMap((source) => {
    const candidate = buildQianwenMeetingPreview(source, [recording]).candidates[0];
    return candidate === undefined || candidate.score < 0.55
      ? []
      : [{ source, candidate }];
  }).sort((left, right) => (
    right.candidate.score - left.candidate.score
    || left.source.scheduled.localeCompare(right.source.scheduled)
    || left.source.eventPath.localeCompare(right.source.eventPath)
  ));
  return scored.map(({ source, candidate }, index) => candidateProjection(
    source,
    candidate,
    scored.some((other, otherIndex) => (
      otherIndex !== index
      && Math.abs(other.candidate.score - candidate.score) <= 0.08
    )),
  ));
}

export async function queryWorkProgressHub(
  context: QueryWorkProgressHubContext,
): Promise<WorkProgressHubSnapshot> {
  const [
    sourceState,
    activeDecisions,
    calendarSources,
    progress,
    materialGaps,
    reports,
    tasks,
    notificationRecords,
  ] =
    await Promise.all([
      context.sourceRepository.load(),
      context.decisionRepository.listActive(),
      context.listCalendarSources(),
      context.progressRepository.listCurrent(),
      context.materialGapRepository.list(),
      context.weeklyRepository.listCurrent(),
      context.taskRepository.list(),
      context.notificationLedger?.list() ?? Promise.resolve([]),
    ]);

  const latestScan = sourceState.lastScan;
  const successfulScan = sourceState.lastSuccessfulScan;
  const visibleRecordings = Object.values(sourceState.recordings)
    .map(currentRecording)
    .filter((recording): recording is QianwenPersistedRecordingVersion => recording !== null)
    .sort((left, right) => (
      (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
      || left.id.localeCompare(right.id)
    ));
  const activeByRecording = new Map<
    string,
    NonNullable<WorkProgressMatchItem['activeDecision']>
  >();
  for (const decision of activeDecisions) {
    if (decision.action === 'revoked') continue;
    activeByRecording.set(decision.recordingId, {
      decisionId: decision.decisionId,
      action: decision.action,
      eventKeyHash: decision.eventKeyHash,
    });
  }
  const sourceRecordings = successfulScan?.recordings ?? [];
  const matches = await Promise.all(visibleRecordings.map(async (version) => {
    const activeDecision = activeByRecording.get(version.id);
    const recording = matchableRecording(version);
    let progressDrafts: WorkProgressMatchItem['progressDrafts'] = [];
    if (
      activeDecision !== undefined
      && recording !== null
      && context.findMeetingPath !== undefined
    ) {
      const meetingPath = await context.findMeetingPath(version.id);
      if (meetingPath !== null) {
        const calendar = activeDecision.action === 'confirmed'
          ? calendarSources.find(({ eventKeyHash }) => (
            eventKeyHash === activeDecision.eventKeyHash
          ))
          : undefined;
        progressDrafts = prepareMeetingProgressDrafts({
          meetingTitle: calendar?.title ?? recording.title,
          occurredAt: calendar?.scheduled ?? recording.createdAt,
          sourceRef: meetingPath,
          summary: recording.summary.trim() === '' ? recording.transcript : recording.summary,
        });
      }
    }
    return {
      recordingId: version.id,
      title: version.title ?? version.id,
      createdAt: version.createdAt,
      status: version.status,
      activeDecision: activeDecision === undefined ? null : {
        decisionId: activeDecision.decisionId,
        action: activeDecision.action,
        eventKeyHash: activeDecision.eventKeyHash,
      },
      progressDrafts,
      candidates: recording === null
        ? []
        : candidatesForRecording(recording, calendarSources),
    };
  }));

  const weeklyReports = await Promise.all(reports.map(async (report) => {
    const decisions = (await context.weeklyDecisionRepository.listForWeekly(report.weeklyId))
      .filter((decision) => decision.version === report.version)
      .sort((left, right) => (
        left.decidedAt.localeCompare(right.decidedAt)
        || left.eventId.localeCompare(right.eventId)
      ));
    const latestDecision = decisions.at(-1);
    return {
      weeklyId: report.weeklyId,
      version: report.version,
      weekKey: report.weekKey,
      acceptanceState: latestDecision?.action ?? report.acceptanceState,
      publicationState: report.publicationState,
      completeness: report.completeness,
      pendingCount: report.pendingCount,
      path: `09_Progress/Weekly/${report.weekKey}-v${report.version}.md`,
    };
  }));

  const notifications = new Map(notificationRecords.map((record) => [
    record.idempotencyKey,
    {
      status: record.status,
      attemptedAt: record.attemptedAt,
      errorCode: record.errorCode,
    },
  ]));
  const acceptanceObjects = projectAcceptanceObjects(tasks, weeklyReports).map((object) => ({
    ...object,
    notification: notifications.get(
      `${object.objectType}:${object.objectId}:${object.version}`,
    ) ?? null,
  }));

  return {
    source: {
      status: latestScan?.connector.status ?? 'never_scanned',
      scannedAt: latestScan?.connector.scannedAt ?? null,
      lastSuccessfulScanAt: successfulScan?.connector.scannedAt ?? null,
      available: sourceRecordings.filter((recording) => recording.status === 'available').length,
      waiting: sourceRecordings.filter((recording) => recording.status === 'waiting').length,
      failed: sourceRecordings.filter((recording) => recording.status === 'failed').length,
    },
    matches,
    progress: progress.map((item) => ({
      progressId: item.progressId,
      version: item.version,
      topic: item.topic,
      projectId: item.primaryProjectId,
      lifecycleStatus: item.lifecycleStatus,
      path: `09_Progress/Items/${item.occurredAt.slice(0, 7)}/${item.progressId}-v${item.version}.md`,
    })),
    materialGaps: materialGaps.map((gap) => ({
      gapId: gap.gapId,
      title: gap.missing.description,
      status: gap.status,
      path: `09_Progress/Requests/${gap.createdAt.slice(0, 7)}/${gap.gapId}.md`,
    })),
    weeklyReports,
    acceptanceObjects,
  };
}
