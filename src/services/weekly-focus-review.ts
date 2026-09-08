import {
  persistWeeklyFocusRecord,
  weeklyFocusTimestamp,
  type WeeklyFocusDocument,
  type WeeklyFocusEvidenceCoverage,
  type WeeklyFocusEvidenceAttribution,
  type WeeklyFocusGateway,
  type WeeklyFocusItemReview,
  type WeeklyFocusNextWeekAction,
  type WeeklyFocusReview,
  type WeeklyFocusTaskAttribution,
} from './weekly-focus.js';
import type { WeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import { canonicalWeeklyEvidenceSourceKeys } from './query-weekly-focus-review.js';

const MAX_TEXT_LENGTH = 4_000;
const REVIEW_OUTCOMES = new Set<WeeklyFocusItemReview['outcome']>([
  '已完成',
  '部分完成',
  '未完成',
  '已调整',
  '已取消',
]);
const NEXT_WEEK_ACTIONS = new Set<WeeklyFocusNextWeekAction>(['继续', '调整', '停止']);

export interface WeeklyFocusAttributionInput {
  document: WeeklyFocusDocument;
  taskAttributions: WeeklyFocusTaskAttribution[];
  ignoredLinkedTasks: string[];
  focusEvidenceCoverage?: WeeklyFocusEvidenceCoverage[];
  weeklyEvidenceAttributions?: WeeklyFocusEvidenceAttribution[];
  ignoredWeeklyEvidence?: string[];
}

export interface WeeklyFocusReviewInput extends WeeklyFocusAttributionInput {
  focusReviews: WeeklyFocusItemReview[];
  overallResult: string;
  valueJudgment: string;
  hypothesisOutcome: string;
  nextWeekAction: WeeklyFocusNextWeekAction;
}

function boundedText(value: string, field: string, allowEmpty = false): string {
  const normalized = value.trim();
  if (!allowEmpty && normalized === '') throw new Error(`${field}不能为空`);
  if (normalized.length > MAX_TEXT_LENGTH) throw new Error(`${field}内容过长`);
  return normalized;
}

function normalizeAttribution(input: WeeklyFocusAttributionInput): {
  taskAttributions: WeeklyFocusTaskAttribution[];
  ignoredLinkedTasks: string[];
  focusEvidenceCoverage: WeeklyFocusEvidenceCoverage[];
  weeklyEvidenceAttributions: WeeklyFocusEvidenceAttribution[];
  ignoredWeeklyEvidence: string[];
} {
  const focusCount = input.document.record.input.focuses.length;
  const linkedTasks = new Set(input.document.record.linkedTasks);
  const seenFocuses = new Set<number>();
  const seenTasks = new Set<string>();
  const taskAttributions = input.taskAttributions.map((item) => {
    if (
      !Number.isInteger(item.focusIndex)
      || item.focusIndex < 0
      || item.focusIndex >= focusCount
      || seenFocuses.has(item.focusIndex)
    ) {
      throw new Error('重点任务归属包含无效或重复重点');
    }
    seenFocuses.add(item.focusIndex);
    const taskIds = [...new Set(item.taskIds.map((taskId) => boundedText(
      taskId,
      '重点关联任务',
    )))];
    for (const taskId of taskIds) {
      if (!linkedTasks.has(taskId)) throw new Error('重点任务归属超出周级关联任务');
      if (seenTasks.has(taskId)) throw new Error('同一任务不能归属多个重点');
      seenTasks.add(taskId);
    }
    return { focusIndex: item.focusIndex, taskIds };
  }).sort((left, right) => left.focusIndex - right.focusIndex);
  const ignoredLinkedTasks = [...new Set(input.ignoredLinkedTasks.map((taskId) => (
    boundedText(taskId, '已忽略周级关联任务')
  )))];
  if (ignoredLinkedTasks.some((taskId) => !linkedTasks.has(taskId) || seenTasks.has(taskId))) {
    throw new Error('已忽略周级关联任务超出范围或已被归属');
  }
  const seenCoverage = new Set<number>();
  const focusEvidenceCoverage = (input.focusEvidenceCoverage
    ?? input.document.record.focusEvidenceCoverage
    ?? []).map((item) => {
    if (
      !Number.isInteger(item.focusIndex)
      || item.focusIndex < 0
      || item.focusIndex >= focusCount
      || seenCoverage.has(item.focusIndex)
      || (item.expectedOutcomeCovered !== undefined
        && typeof item.expectedOutcomeCovered !== 'boolean')
      || (item.expectedEvidenceCovered !== undefined
        && typeof item.expectedEvidenceCovered !== 'boolean')
      || (item.expectedOutcomeCovered === undefined
        && item.expectedEvidenceCovered === undefined)
    ) {
      throw new Error('重点证据覆盖包含无效或重复重点');
    }
    seenCoverage.add(item.focusIndex);
    return {
      focusIndex: item.focusIndex,
      ...(item.expectedOutcomeCovered === undefined
        ? {}
        : { expectedOutcomeCovered: item.expectedOutcomeCovered }),
      ...(item.expectedEvidenceCovered === undefined
        ? {}
        : { expectedEvidenceCovered: item.expectedEvidenceCovered }),
    };
  }).sort((left, right) => left.focusIndex - right.focusIndex);
  const seenEvidenceFocuses = new Set<number>();
  const seenEvidence = new Set<string>();
  const weeklyEvidenceAttributions = (input.weeklyEvidenceAttributions
    ?? input.document.record.weeklyEvidenceAttributions
    ?? []).map((item) => {
    if (
      !Number.isInteger(item.focusIndex)
      || item.focusIndex < 0
      || item.focusIndex >= focusCount
      || seenEvidenceFocuses.has(item.focusIndex)
    ) {
      throw new Error('周报证据归属包含无效或重复重点');
    }
    seenEvidenceFocuses.add(item.focusIndex);
    const sourceKeys = item.sourceKeys.map((sourceKey) => (
      boundedText(sourceKey, '周报证据键')
    ));
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new Error('周报证据键不能重复');
    }
    for (const sourceKey of sourceKeys) {
      if (seenEvidence.has(sourceKey)) throw new Error('同一周报证据不能归属多个重点');
      seenEvidence.add(sourceKey);
    }
    return { focusIndex: item.focusIndex, sourceKeys };
  }).sort((left, right) => left.focusIndex - right.focusIndex);
  const ignoredWeeklyEvidence = (input.ignoredWeeklyEvidence
    ?? input.document.record.ignoredWeeklyEvidence
    ?? []).map((sourceKey) => boundedText(sourceKey, '已忽略周报证据'));
  if (new Set(ignoredWeeklyEvidence).size !== ignoredWeeklyEvidence.length) {
    throw new Error('已忽略周报证据不能重复');
  }
  if (ignoredWeeklyEvidence.some((sourceKey) => seenEvidence.has(sourceKey))) {
    throw new Error('已忽略周报证据不能同时归属重点');
  }
  return {
    taskAttributions,
    ignoredLinkedTasks,
    focusEvidenceCoverage,
    weeklyEvidenceAttributions,
    ignoredWeeklyEvidence,
  };
}

async function assertCanonicalWeeklyEvidence(
  weeklyReports: Pick<WeeklyReportRepository, 'listCurrent'>,
  week: string,
  attribution: Pick<
  ReturnType<typeof normalizeAttribution>,
  'weeklyEvidenceAttributions' | 'ignoredWeeklyEvidence'
  >,
): Promise<void> {
  let canonicalKeys: ReadonlySet<string>;
  try {
    canonicalKeys = canonicalWeeklyEvidenceSourceKeys(
      await weeklyReports.listCurrent(),
      week,
    );
  } catch {
    throw new Error('当前周报读取失败，无法校验周报证据键');
  }
  const submittedKeys = [
    ...attribution.weeklyEvidenceAttributions.flatMap(({ sourceKeys }) => sourceKeys),
    ...attribution.ignoredWeeklyEvidence,
  ];
  if (submittedKeys.some((sourceKey) => !canonicalKeys.has(sourceKey))) {
    throw new Error('周报证据键不属于当前周报');
  }
}

function normalizeReview(input: WeeklyFocusReviewInput): WeeklyFocusReview {
  const focusCount = input.document.record.input.focuses.length;
  if (input.focusReviews.length !== focusCount) throw new Error('请逐项确认所有本周重点');
  const seen = new Set<number>();
  const focusReviews = input.focusReviews.map((item) => {
    if (
      !Number.isInteger(item.focusIndex)
      || item.focusIndex < 0
      || item.focusIndex >= focusCount
      || seen.has(item.focusIndex)
    ) {
      throw new Error('重点复盘包含无效或重复重点');
    }
    if (!REVIEW_OUTCOMES.has(item.outcome)) throw new Error('重点复盘结果无效');
    seen.add(item.focusIndex);
    return {
      focusIndex: item.focusIndex,
      outcome: item.outcome,
      actualResult: boundedText(item.actualResult, '重点实际结果'),
      evidenceGapNote: boundedText(item.evidenceGapNote, '证据不足说明', true),
    };
  }).sort((left, right) => left.focusIndex - right.focusIndex);
  if (!NEXT_WEEK_ACTIONS.has(input.nextWeekAction)) throw new Error('下周动作无效');
  return {
    focusReviews,
    overallResult: boundedText(input.overallResult, '本周总体结果'),
    valueJudgment: boundedText(input.valueJudgment, '价值判断'),
    hypothesisOutcome: boundedText(input.hypothesisOutcome, '被验证或推翻的假设'),
    nextWeekAction: input.nextWeekAction,
  };
}

export function saveWeeklyFocusAttribution(
  gateway: WeeklyFocusGateway,
  weeklyReports: Pick<WeeklyReportRepository, 'listCurrent'>,
  clock: () => Date,
  input: WeeklyFocusAttributionInput,
  timeZone = 'Asia/Shanghai',
): Promise<WeeklyFocusDocument> {
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error('无效的保存时间');
  const attribution = normalizeAttribution(input);
  return assertCanonicalWeeklyEvidence(
    weeklyReports,
    input.document.record.week,
    attribution,
  ).then(() => persistWeeklyFocusRecord(gateway, input.document, {
      ...input.document.record,
      ...attribution,
      updatedAt: weeklyFocusTimestamp(now, timeZone),
    }));
}

export function saveWeeklyFocusReview(
  gateway: WeeklyFocusGateway,
  weeklyReports: Pick<WeeklyReportRepository, 'listCurrent'>,
  clock: () => Date,
  input: WeeklyFocusReviewInput,
  timeZone = 'Asia/Shanghai',
): Promise<WeeklyFocusDocument> {
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error('无效的保存时间');
  const attribution = normalizeAttribution(input);
  const review = normalizeReview(input);
  const timestamp = weeklyFocusTimestamp(now, timeZone);
  return assertCanonicalWeeklyEvidence(
    weeklyReports,
    input.document.record.week,
    attribution,
  ).then(() => persistWeeklyFocusRecord(gateway, input.document, {
      ...input.document.record,
      ...attribution,
      review,
      reviewStatus: '已复盘',
      reviewedAt: timestamp,
      updatedAt: timestamp,
    }));
}
