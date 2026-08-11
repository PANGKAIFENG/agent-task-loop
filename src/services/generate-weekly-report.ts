import {
  weeklyReportVersionSchema,
  type WeeklyProjectSection,
  type WeeklyReportItem,
  type WeeklyReportVersion,
} from '../domain/weekly-report.js';
import {
  projectAcceptanceObjects,
  type AcceptanceObject,
} from '../domain/acceptance-object.js';
import type { ProgressRepository } from '../storage/markdown-progress-repository.js';
import type { WeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import { calendarDateInTimeZone } from '../domain/week-period.js';

export interface WeeklyReportServiceContext {
  progressRepository: ProgressRepository;
  weeklyRepository: WeeklyReportRepository;
  clock: () => Date;
  notifyAcceptance?: (object: AcceptanceObject) => Promise<unknown>;
}

export interface GenerateWeeklyReportInput {
  weekKey: string;
  week: { startDate: string; endDate: string };
}

function isInWeek(occurredAt: string, week: GenerateWeeklyReportInput['week']): boolean {
  const date = calendarDateInTimeZone(occurredAt, 'Asia/Shanghai');
  return date >= week.startDate && date <= week.endDate;
}

function reportItem(
  progress: Awaited<ReturnType<ProgressRepository['listCurrent']>>[number],
): WeeklyReportItem {
  return {
    progressRef: { progressId: progress.progressId, version: progress.version },
    topic: progress.topic,
    reportCategory: progress.reportCategory,
    contribution: progress.contribution,
    changes: progress.statements
      .filter((statement) => statement.kind === 'fact')
      .map((statement) => statement.text),
    conclusions: progress.evidence
      .filter((evidence) => evidence.kind === 'confirmed_decision')
      .map((evidence) => evidence.summary),
    artifacts: progress.evidence
      .filter((evidence) => evidence.kind === 'artifact')
      .map((evidence) => ({
        summary: evidence.summary,
        sourceRef: evidence.sourceRef,
      })),
    blockers: progress.evidence
      .filter((evidence) => evidence.kind === 'blocker')
      .map((evidence) => evidence.summary),
    pending: progress.statements
      .filter((statement) => statement.kind !== 'fact')
      .map((statement) => statement.text),
    sourceRefs: Array.from(new Set([
      ...progress.sources,
      ...progress.evidence.map((evidence) => evidence.sourceRef),
    ])),
  };
}

export async function generateWeeklyReport(
  context: WeeklyReportServiceContext,
  input: GenerateWeeklyReportInput,
): Promise<WeeklyReportVersion> {
  const weeklyId = `weekly-${input.weekKey}`;
  const existing = await context.weeklyRepository.listVersions(weeklyId);
  const currentProgress = (await context.progressRepository.listCurrent())
    .filter((progress) => isInWeek(progress.occurredAt, input.week));
  const eligible = currentProgress.filter((progress) => (
    progress.eligibility.status === 'eligible'
    && progress.primaryProjectId !== null
  ));
  const sectionMap = new Map<string, WeeklyProjectSection>();
  for (const progress of eligible) {
    const primaryProjectId = progress.primaryProjectId;
    if (primaryProjectId === null) continue;
    const section = sectionMap.get(primaryProjectId) ?? {
      primaryProjectId,
      items: [],
    };
    section.items.push(reportItem(progress));
    sectionMap.set(primaryProjectId, section);
  }
  const omissions = currentProgress
    .filter((progress) => progress.eligibility.status === 'needs_confirmation')
    .map((progress) => ({
      progressId: progress.progressId,
      version: progress.version,
      reasons: progress.eligibility.reasons,
    }));
  const excludedProgressIds = currentProgress
    .filter((progress) => progress.eligibility.status === 'ineligible')
    .map((progress) => progress.progressId);
  const latest = existing.at(-1);
  const report = weeklyReportVersionSchema.parse({
    schemaVersion: 1,
    weeklyId,
    version: (latest?.version ?? 0) + 1,
    weekKey: input.weekKey,
    week: input.week,
    acceptanceState: 'pending',
    publicationState: 'not_published',
    completeness: omissions.length === 0 ? 'complete' : 'partial_success',
    progressRefs: eligible.map((progress) => ({
      progressId: progress.progressId,
      version: progress.version,
    })),
    sections: Array.from(sectionMap.values()),
    omissions,
    excludedProgressIds,
    pendingCount: omissions.length + eligible.reduce((count, progress) => (
      count + progress.statements.filter((statement) => statement.kind !== 'fact').length
    ), 0),
    supersedesVersion: latest?.version ?? null,
    createdAt: context.clock().toISOString(),
  });
  const created = await context.weeklyRepository.create(report);
  const acceptance = projectAcceptanceObjects([], [{
    weeklyId: created.weeklyId,
    version: created.version,
    weekKey: created.weekKey,
    acceptanceState: created.acceptanceState,
    pendingCount: created.pendingCount,
    path: `09_Progress/Weekly/${created.weekKey}-v${created.version}.md`,
  }])[0];
  if (acceptance !== undefined && context.notifyAcceptance !== undefined) {
    try {
      await context.notifyAcceptance(acceptance);
    } catch {
      // A failed notification must not roll back the immutable weekly snapshot.
    }
  }
  return created;
}
