import type { Task } from '../domain/task.js';
import type { WeeklyReportVersion } from '../domain/weekly-report.js';
import type {
  ArtifactRepository,
  AuditEvent,
  AuditLog,
  TaskRepository,
} from '../storage/contracts.js';
import type { WeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import { isTaskCompletionEvent } from './query-contribution.js';
import {
  currentIsoWeek,
  loadWeeklyFocus,
  type WeeklyFocusDocument,
  type WeeklyFocusGateway,
  type WeeklyFocusItemReview,
} from './weekly-focus.js';

export interface WeeklyFocusArtifactFactInput {
  taskId: string;
  ref: string;
  status: 'available' | 'missing' | 'invalid' | 'read_failed';
  summary: string | null;
  checks?: { met: number; partial: number; notMet: number };
}

export interface WeeklyFocusReadFailure {
  source: 'task' | 'artifact' | 'weekly_report';
  reference: string;
  code: string;
}

export type WeeklyFocusGapCode =
  | 'no_linked_task'
  | 'task_source_missing'
  | 'task_stale'
  | 'task_not_done'
  | 'task_reopened'
  | 'task_blocked'
  | 'artifact_missing'
  | 'artifact_invalid'
  | 'artifact_returned'
  | 'acceptance_missing'
  | 'acceptance_incomplete'
  | 'expected_outcome_uncovered'
  | 'expected_evidence_uncovered'
  | 'source_conflict'
  | 'partial_read_failure';

export interface WeeklyFocusGap {
  code: WeeklyFocusGapCode;
  message: string;
  action: string;
}

export interface WeeklyFocusProgressProjectionInput {
  document: WeeklyFocusDocument;
  tasks: Task[];
  auditEvents: AuditEvent[];
  artifacts: WeeklyFocusArtifactFactInput[];
  weeklyReport: WeeklyReportVersion | null;
  readFailures: WeeklyFocusReadFailure[];
}

interface WeeklyFocusTaskFact {
  layer: 'fact';
  taskId: string;
  title: string;
  status: string;
  updatedAt: string;
  sourceDate: string | null;
  sourceRef: string | null;
  sourceKey: string;
  blocker: string | null;
}

interface WeeklyFocusCompletionFact {
  layer: 'fact';
  taskId: string;
  completedAt: string;
  source: string;
}

interface WeeklyFocusArtifactFact extends WeeklyFocusArtifactFactInput {
  layer: 'fact';
}

interface WeeklyFocusAcceptanceFact {
  layer: 'fact';
  taskId: string;
  status: 'accepted' | 'incomplete' | 'returned' | 'missing' | 'conflicting';
  detail: string;
}

export interface WeeklyFocusProgressItem {
  focusIndex: number;
  focus: string;
  expectedOutcome: string;
  expectedEvidence: string;
  facts: {
    tasks: WeeklyFocusTaskFact[];
    completions: WeeklyFocusCompletionFact[];
    artifacts: WeeklyFocusArtifactFact[];
    acceptances: WeeklyFocusAcceptanceFact[];
  };
  gaps: WeeklyFocusGap[];
  suggestion: {
    layer: 'suggestion';
    status: 'evidence_supported' | 'partial_evidence' | 'no_evidence' | 'conflicting_evidence';
    label: '证据支持完成' | '部分证据' | '无关联证据' | '证据冲突';
    reasons: string[];
  };
  userJudgment: (WeeklyFocusItemReview & { layer: 'user_judgment' }) | null;
}

export interface WeeklyFocusProgressProjection {
  week: string;
  reviewStatus: '待复盘' | '已复盘';
  reviewedAt: string | null;
  focuses: WeeklyFocusProgressItem[];
  unassignedTasks: string[];
  weeklyEvidence: WeeklyFocusWeeklyEvidence[];
  unassignedEvidence: WeeklyFocusWeeklyEvidence[];
  reportDataCompleteness: {
    label: '周报数据完整性';
    value: '完整' | '部分成功';
    detail: string;
  } | null;
  readFailures: WeeklyFocusReadFailure[];
}

export interface WeeklyFocusWeeklyEvidence {
  sourceKey: string;
  topic: string;
  sourceRefs: string[];
  sourceUpdatedAt: string;
  assignment:
    | { kind: 'unassigned' }
    | { kind: 'ignored' }
    | { kind: 'focus'; focusIndex: number };
  action: '关联到重点或明确忽略';
}

export function weeklyEvidenceSourceKey(
  item: WeeklyReportVersion['sections'][number]['items'][number],
): string {
  return `weekly-report:${item.progressRef.progressId}:v${item.progressRef.version}`;
}

export function currentWeeklyReportForWeek(
  reports: readonly WeeklyReportVersion[],
  week: string,
): WeeklyReportVersion | null {
  return reports.find(({ weekKey }) => weekKey === week) ?? null;
}

export function canonicalWeeklyEvidenceSourceKeys(
  reports: readonly WeeklyReportVersion[],
  week: string,
): ReadonlySet<string> {
  const report = currentWeeklyReportForWeek(reports, week);
  return new Set(
    report?.sections.flatMap(({ items }) => items.map(weeklyEvidenceSourceKey)) ?? [],
  );
}

export interface WeeklyFocusProgressQueryInput {
  gateway: Pick<WeeklyFocusGateway, 'read'>;
  week: string;
  tasks: Pick<TaskRepository, 'list'>;
  audit: Pick<AuditLog, 'listForTask'>;
  artifacts: Pick<ArtifactRepository, 'readSummary'>;
  weeklyReports: Pick<WeeklyReportRepository, 'listCurrent'>;
}

export interface WeeklyFocusProgressQueryResult {
  document: WeeklyFocusDocument;
  projection: WeeklyFocusProgressProjection;
}

const gap = (
  code: WeeklyFocusGapCode,
  message: string,
  action: string,
): WeeklyFocusGap => ({ code, message, action });

function isoWeekStart(week: string): number {
  const match = /^(\d{4})-W(\d{2})$/u.exec(week);
  if (match === null) return Number.NaN;
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const firstMonday = new Date(januaryFourth);
  firstMonday.setUTCDate(januaryFourth.getUTCDate() - weekday + 1);
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (weekNumber - 1) * 7);
  return firstMonday.getTime();
}

function completionForTask(
  taskId: string,
  auditEvents: readonly AuditEvent[],
  afterExclusive: number | null,
): WeeklyFocusCompletionFact | null {
  const completion = auditEvents
    .filter((event) => event.taskId === taskId && isTaskCompletionEvent(event))
    .filter((event) => Number.isFinite(Date.parse(event.at)))
    .filter((event) => afterExclusive === null || Date.parse(event.at) > afterExclusive)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  return completion === undefined ? null : {
    layer: 'fact',
    taskId,
    completedAt: completion.at,
    source: completion.event,
  };
}

function latestReviewDecision(
  taskId: string,
  auditEvents: readonly AuditEvent[],
  afterExclusive: number | null,
): AuditEvent | null {
  return auditEvents
    .filter((event) => event.taskId === taskId && event.event === 'task.reviewed')
    .filter((event) => Number.isFinite(Date.parse(event.at)))
    .filter((event) => afterExclusive === null || Date.parse(event.at) > afterExclusive)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null;
}

function latestReopenAt(taskId: string, auditEvents: readonly AuditEvent[]): number | null {
  const timestamps = auditEvents
    .filter((event) => event.taskId === taskId && event.event === 'task.reopened')
    .map((event) => Date.parse(event.at))
    .filter(Number.isFinite);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

function acceptanceForTask(input: {
  task: Task;
  artifacts: WeeklyFocusArtifactFact[];
  completion: WeeklyFocusCompletionFact | null;
  latestReview: AuditEvent | null;
}): WeeklyFocusAcceptanceFact {
  const returned = input.latestReview?.details?.decision === 'request_changes';
  const approved = input.latestReview?.details?.decision === 'approve';
  const aggregate = input.artifacts.reduce((counts, artifact) => ({
    met: counts.met + (artifact.checks?.met ?? 0),
    partial: counts.partial + (artifact.checks?.partial ?? 0),
    notMet: counts.notMet + (artifact.checks?.notMet ?? 0),
  }), { met: 0, partial: 0, notMet: 0 });
  if (returned && input.task.status === 'done') {
    return {
      layer: 'fact',
      taskId: input.task.taskId,
      status: 'conflicting',
      detail: '任务状态为完成，但最新验收事实是退回。',
    };
  }
  if (returned || aggregate.notMet > 0) {
    return {
      layer: 'fact',
      taskId: input.task.taskId,
      status: 'returned',
      detail: input.task.reviewFeedback ?? 'Artifact 存在未通过验收项。',
    };
  }
  if (aggregate.partial > 0) {
    return {
      layer: 'fact',
      taskId: input.task.taskId,
      status: 'incomplete',
      detail: 'Artifact 验收项仅部分通过。',
    };
  }
  if (
    approved
    && input.task.status === 'done'
    && input.completion !== null
    && input.artifacts.length > 0
    && aggregate.met > 0
  ) {
    return {
      layer: 'fact',
      taskId: input.task.taskId,
      status: 'accepted',
      detail: '存在完成事实、Artifact 和通过验收。',
    };
  }
  return {
    layer: 'fact',
    taskId: input.task.taskId,
    status: 'missing',
    detail: '未找到明确的通过验收事实。',
  };
}

function uniqueGaps(gaps: WeeklyFocusGap[]): WeeklyFocusGap[] {
  const seen = new Set<string>();
  return gaps.filter((item) => {
    const key = `${item.code}\u0000${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectWeeklyFocusProgress(
  input: WeeklyFocusProgressProjectionInput,
): WeeklyFocusProgressProjection {
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const artifactsByTask = new Map<string, WeeklyFocusArtifactFact[]>();
  input.artifacts.forEach((artifact) => {
    const facts = artifactsByTask.get(artifact.taskId) ?? [];
    facts.push({ ...artifact, layer: 'fact' });
    artifactsByTask.set(artifact.taskId, facts);
  });
  const attributedTaskIds = new Set(
    (input.document.record.taskAttributions ?? []).flatMap(({ taskIds }) => taskIds),
  );
  const ignored = new Set(input.document.record.ignoredLinkedTasks ?? []);
  const attributionByFocus = new Map(
    (input.document.record.taskAttributions ?? []).map((item) => [item.focusIndex, item.taskIds]),
  );
  const reviewsByFocus = new Map(
    (input.document.record.review?.focusReviews ?? []).map((item) => [item.focusIndex, item]),
  );
  const coverageByFocus = new Map(
    (input.document.record.focusEvidenceCoverage ?? []).map((item) => [item.focusIndex, item]),
  );
  const weekStart = isoWeekStart(input.document.record.week);
  const focuses = input.document.record.input.focuses.map((
    focus,
    focusIndex,
  ): WeeklyFocusProgressItem => {
    const taskIds = attributionByFocus.get(focusIndex) ?? [];
    const gaps: WeeklyFocusGap[] = [];
    const taskFacts: WeeklyFocusTaskFact[] = [];
    const completionFacts: WeeklyFocusCompletionFact[] = [];
    const artifactFacts: WeeklyFocusArtifactFact[] = [];
    const acceptanceFacts: WeeklyFocusAcceptanceFact[] = [];
    if (taskIds.length === 0) {
      gaps.push(gap(
        'no_linked_task',
        '该重点没有直接关联任务或结果证据。',
        '关联任务或说明本周调整原因',
      ));
    }
    for (const taskId of taskIds) {
      const task = tasksById.get(taskId);
      if (task === undefined) {
        gaps.push(gap(
          'task_source_missing',
          `找不到关联任务 ${taskId} 的来源记录。`,
          '修复任务来源或重新关联',
        ));
        continue;
      }
      taskFacts.push({
        layer: 'fact',
        taskId,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        sourceDate: task.sourceDate,
        sourceRef: task.sourceNote,
        sourceKey: task.sourceKey,
        blocker: task.status === 'blocked' ? task.reviewFeedback : null,
      });
      if (Date.parse(task.updatedAt) < weekStart) {
        gaps.push(gap(
          'task_stale',
          `任务 ${task.title} 的状态早于本周，可能已过期。`,
          '更新任务状态或确认仍然有效',
        ));
      }
      if (task.status === 'blocked') {
        gaps.push(gap(
          'task_blocked',
          `任务 ${task.title} 当前被阻塞。`,
          '处理阻塞或说明本周调整原因',
        ));
      }
      const reopenedAt = latestReopenAt(taskId, input.auditEvents);
      const completion = completionForTask(taskId, input.auditEvents, reopenedAt);
      if (completion !== null) completionFacts.push(completion);
      if (reopenedAt !== null && (task.status !== 'done' || completion === null)) {
        gaps.push(gap(
          'task_reopened',
          `任务 ${task.title} 已重新打开，历史完成与验收不再支撑当前完成。`,
          '重新完成任务并重新验收',
        ));
      } else if (task.status !== 'done') {
        gaps.push(gap(
          'task_not_done',
          `任务 ${task.title} 当前状态为 ${task.status}，尚不满足完成语义。`,
          '完成任务或说明当前实际结果',
        ));
      }
      const artifacts = artifactsByTask.get(taskId) ?? [];
      artifactFacts.push(...artifacts);
      if (task.status === 'done' && task.artifactRefs.length === 0) {
        gaps.push(gap(
          'artifact_missing',
          `任务 ${task.title} 标记完成但没有 Artifact。`,
          '添加成果链接',
        ));
      }
      if (artifacts.some(({ status }) => status === 'missing' || status === 'invalid')) {
        gaps.push(gap(
          'artifact_invalid',
          `任务 ${task.title} 的 Artifact 无法读取或引用无效。`,
          '修复成果链接',
        ));
      }
      const acceptance = acceptanceForTask({
        task,
        artifacts,
        completion,
        latestReview: latestReviewDecision(taskId, input.auditEvents, reopenedAt),
      });
      acceptanceFacts.push(acceptance);
      if (acceptance.status === 'missing') {
        gaps.push(gap(
          'acceptance_missing',
          `任务 ${task.title} 没有明确的通过验收事实。`,
          '完成验收',
        ));
      }
      if (acceptance.status === 'incomplete') {
        gaps.push(gap(
          'acceptance_incomplete',
          `任务 ${task.title} 的 Artifact 验收项未全部通过。`,
          '补齐未通过的验收项',
        ));
        gaps.push(gap(
          'acceptance_missing',
          `任务 ${task.title} 尚未形成最终通过验收。`,
          '完成验收',
        ));
      }
      if (acceptance.status === 'returned') {
        gaps.push(gap(
          'artifact_returned',
          `任务 ${task.title} 的 Artifact 已被退回或存在未通过项。`,
          '按退回意见修订后重新验收',
        ));
      }
      if (acceptance.status === 'conflicting') {
        gaps.push(gap(
          'source_conflict',
          `任务 ${task.title} 的完成状态与验收事实冲突。`,
          '核对冲突来源并确认实际结果',
        ));
      }
    }
    if (input.readFailures.some(({ reference }) => taskIds.includes(reference))) {
      gaps.push(gap(
        'partial_read_failure',
        '部分任务或 Artifact 读取失败，当前事实可能不完整。',
        '重试读取并保留当前人工判断',
      ));
    }
    const coverage = coverageByFocus.get(focusIndex);
    if (coverage?.expectedOutcomeCovered !== true) {
      gaps.push(gap(
        'expected_outcome_uncovered',
        coverage?.expectedOutcomeCovered === undefined
          ? '尚未确认当前事实是否覆盖该重点的预期结果。'
          : '当前事实未覆盖该重点的预期结果。',
        '核对事实并确认是否覆盖预期结果',
      ));
    }
    if (coverage?.expectedEvidenceCovered !== true) {
      gaps.push(gap(
        'expected_evidence_uncovered',
        coverage?.expectedEvidenceCovered === undefined
          ? '尚未确认当前事实是否覆盖该重点的完成证据。'
          : '当前事实未覆盖该重点的完成证据。',
        '核对事实并确认是否覆盖完成证据',
      ));
    }
    const normalizedGaps = uniqueGaps(gaps);
    const conflicting = normalizedGaps.some(({ code }) => code === 'source_conflict');
    const evidenceSupported = taskIds.length > 0
      && normalizedGaps.length === 0
      && taskIds.every((taskId) => tasksById.get(taskId)?.status === 'done')
      && taskIds.every((taskId) => completionFacts.some((fact) => fact.taskId === taskId))
      && taskIds.every((taskId) => acceptanceFacts.some((fact) => (
        fact.taskId === taskId && fact.status === 'accepted'
      )));
    const status: WeeklyFocusProgressItem['suggestion']['status'] = conflicting
      ? 'conflicting_evidence'
      : taskIds.length === 0
        ? 'no_evidence'
        : evidenceSupported
          ? 'evidence_supported'
          : 'partial_evidence';
    const label = {
      conflicting_evidence: '证据冲突',
      no_evidence: '无关联证据',
      evidence_supported: '证据支持完成',
      partial_evidence: '部分证据',
    }[status] as WeeklyFocusProgressItem['suggestion']['label'];
    const userReview = reviewsByFocus.get(focusIndex);
    return {
      focusIndex,
      focus: focus.focus,
      expectedOutcome: focus.outcome,
      expectedEvidence: focus.evidence,
      facts: {
        tasks: taskFacts,
        completions: completionFacts,
        artifacts: artifactFacts,
        acceptances: acceptanceFacts,
      },
      gaps: normalizedGaps,
      suggestion: {
        layer: 'suggestion' as const,
        status,
        label,
        reasons: normalizedGaps.length === 0
          ? ['直接关联任务具有完成事实、Artifact 和通过验收。']
          : normalizedGaps.map(({ message }) => message),
      },
      userJudgment: userReview === undefined
        ? null
        : { ...userReview, layer: 'user_judgment' as const },
    };
  });
  const weeklyItems = input.weeklyReport?.sections.flatMap(({ items }) => items) ?? [];
  const evidenceFocusByKey = new Map(
    (input.document.record.weeklyEvidenceAttributions ?? []).flatMap(({ focusIndex, sourceKeys }) => (
      sourceKeys.map((sourceKey) => [sourceKey, focusIndex] as const)
    )),
  );
  const ignoredEvidence = new Set(input.document.record.ignoredWeeklyEvidence ?? []);
  const weeklyEvidence: WeeklyFocusWeeklyEvidence[] = weeklyItems.map((item) => {
    const sourceKey = weeklyEvidenceSourceKey(item);
    const focusIndex = evidenceFocusByKey.get(sourceKey);
    return {
      sourceKey,
      topic: item.topic,
      sourceRefs: item.sourceRefs,
      sourceUpdatedAt: input.weeklyReport?.createdAt ?? '',
      assignment: focusIndex !== undefined
        ? { kind: 'focus', focusIndex }
        : ignoredEvidence.has(sourceKey)
          ? { kind: 'ignored' }
          : { kind: 'unassigned' },
      action: '关联到重点或明确忽略',
    };
  });
  const reportDataCompleteness = input.weeklyReport === null ? null : {
    label: '周报数据完整性' as const,
    value: input.weeklyReport.completeness === 'complete'
      ? '完整' as const
      : '部分成功' as const,
    detail: `${input.weeklyReport.omissions.length} 项聚合遗漏，${input.weeklyReport.pendingCount} 项待补齐`,
  };
  return {
    week: input.document.record.week,
    reviewStatus: input.document.record.reviewStatus,
    reviewedAt: input.document.record.reviewedAt ?? null,
    focuses,
    unassignedTasks: input.document.record.linkedTasks.filter((taskId) => (
      !attributedTaskIds.has(taskId) && !ignored.has(taskId)
    )),
    weeklyEvidence,
    unassignedEvidence: weeklyEvidence.filter(({ assignment }) => (
      assignment.kind === 'unassigned'
    )),
    reportDataCompleteness,
    readFailures: input.readFailures,
  };
}

function artifactFailureStatus(error: unknown): WeeklyFocusArtifactFactInput['status'] {
  if (typeof error !== 'object' || error === null) return 'read_failed';
  const code = (error as { code?: unknown }).code;
  if (code === 'artifact_not_found') return 'missing';
  if (code === 'invalid_artifact_reference') return 'invalid';
  return 'read_failed';
}

export async function queryWeeklyFocusProgress(
  input: WeeklyFocusProgressQueryInput,
): Promise<WeeklyFocusProgressQueryResult | null> {
  const document = await loadWeeklyFocus(input.gateway, input.week);
  if (document === null) return null;
  const readFailures: WeeklyFocusReadFailure[] = [];

  let tasks: Task[];
  try {
    tasks = await input.tasks.list();
  } catch {
    tasks = [];
    document.record.linkedTasks.forEach((taskId) => readFailures.push({
      source: 'task',
      reference: taskId,
      code: 'read_failed',
    }));
  }
  const linkedTasks = tasks.filter(({ taskId }) => document.record.linkedTasks.includes(taskId));

  const auditResults = await Promise.allSettled(
    linkedTasks.map(({ taskId }) => input.audit.listForTask(taskId)),
  );
  const auditEvents = auditResults.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const task = linkedTasks[index];
    if (task !== undefined) {
      readFailures.push({ source: 'task', reference: task.taskId, code: 'audit_read_failed' });
    }
    return [];
  });

  const artifactEntries = linkedTasks.flatMap((task) => (
    task.artifactRefs.map((ref) => ({ taskId: task.taskId, ref }))
  ));
  const artifactResults = await Promise.allSettled(
    artifactEntries.map(({ ref }) => input.artifacts.readSummary(ref)),
  );
  const artifacts = artifactResults.map((result, index): WeeklyFocusArtifactFactInput => {
    const entry = artifactEntries[index];
    if (entry === undefined) throw new Error('Artifact query result mismatch');
    if (result.status === 'fulfilled') {
      return {
        taskId: entry.taskId,
        ref: entry.ref,
        status: 'available',
        summary: result.value.summary,
        ...(result.value.checks === undefined ? {} : { checks: result.value.checks }),
      };
    }
    const status = artifactFailureStatus(result.reason);
    readFailures.push({
      source: 'artifact',
      reference: entry.taskId,
      code: status === 'read_failed' ? 'read_failed' : status,
    });
    return {
      taskId: entry.taskId,
      ref: entry.ref,
      status,
      summary: null,
    };
  });

  let weeklyReport: WeeklyReportVersion | null = null;
  try {
    weeklyReport = currentWeeklyReportForWeek(
      await input.weeklyReports.listCurrent(),
      input.week,
    );
  } catch {
    readFailures.push({
      source: 'weekly_report',
      reference: input.week,
      code: 'read_failed',
    });
  }

  return {
    document,
    projection: projectWeeklyFocusProgress({
      document,
      tasks: linkedTasks,
      auditEvents,
      artifacts,
      weeklyReport,
      readFailures,
    }),
  };
}

export interface WeeklyFocusIndexGateway extends Pick<WeeklyFocusGateway, 'read'> {
  listPaths(): Promise<string[]>;
}

export interface WeeklyFocusReviewIndex {
  currentWeek: string;
  current: WeeklyFocusDocument | null;
  previousPending: WeeklyFocusDocument[];
  reviewed: WeeklyFocusDocument[];
  readFailures: Array<{ path: string; code: 'weekly_focus_read_failed' }>;
}

export async function queryWeeklyFocusReviewIndex(input: {
  gateway: WeeklyFocusIndexGateway;
  clock: () => Date;
  timeZone?: string;
}): Promise<WeeklyFocusReviewIndex> {
  const currentWeek = currentIsoWeek(input.clock(), input.timeZone ?? 'Asia/Shanghai');
  const paths = await input.gateway.listPaths();
  const weeks = [...new Set(paths.flatMap((path) => {
    const match = /^05_Reviews\/Weekly\/(\d{4}-W\d{2}) 周度重点\.md$/u.exec(path);
    return match?.[1] === undefined ? [] : [match[1]];
  }))].sort().reverse();
  const documents: WeeklyFocusDocument[] = [];
  const readFailures: WeeklyFocusReviewIndex['readFailures'] = [];
  for (const week of weeks) {
    try {
      const document = await loadWeeklyFocus(input.gateway, week);
      if (document !== null && document.record.status !== '草稿') documents.push(document);
    } catch {
      readFailures.push({
        path: `05_Reviews/Weekly/${week} 周度重点.md`,
        code: 'weekly_focus_read_failed',
      });
    }
  }
  return {
    currentWeek,
    current: documents.find(({ record }) => record.week === currentWeek) ?? null,
    previousPending: documents.filter(({ record }) => (
      record.week < currentWeek && record.reviewStatus === '待复盘'
    )),
    reviewed: documents.filter(({ record }) => record.reviewStatus === '已复盘'),
    readFailures,
  };
}
