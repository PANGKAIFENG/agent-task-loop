import {
  weeklyReportVersionSchema,
  type WeeklyProjectSection,
  type WeeklyReportVersion,
} from '../domain/weekly-report.js';
import {
  weeklyReviewDecisionSchema,
  type WeeklyReviewDecision,
} from '../domain/weekly-review.js';
import type { WeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import type { WeeklyReviewDecisionRepository } from '../storage/weekly-review-decision-repository.js';

export interface WeeklyReviewServiceContext {
  weeklyRepository: WeeklyReportRepository;
  decisionRepository: WeeklyReviewDecisionRepository;
  clock: () => Date;
  id: () => string;
}

export class WeeklyReviewConflictError extends Error {
  readonly code = 'weekly_review_conflict';

  constructor() {
    super('Weekly review is based on a stale or missing version');
    this.name = 'WeeklyReviewConflictError';
  }
}

async function requireVersion(
  context: WeeklyReviewServiceContext,
  weeklyId: string,
  version: number,
): Promise<WeeklyReportVersion> {
  const reports = await context.weeklyRepository.listVersions(weeklyId);
  const report = reports.find((candidate) => candidate.version === version);
  if (report === undefined) throw new WeeklyReviewConflictError();
  return report;
}

async function recordDecision(
  context: WeeklyReviewServiceContext,
  input: {
    weeklyId: string;
    version: number;
    action: WeeklyReviewDecision['action'];
    feedback: string | null;
  },
): Promise<WeeklyReviewDecision> {
  const decision = weeklyReviewDecisionSchema.parse({
    schemaVersion: 1,
    eventId: context.id(),
    weeklyId: input.weeklyId,
    version: input.version,
    action: input.action,
    feedback: input.feedback,
    publicationState: 'not_published',
    decidedAt: context.clock().toISOString(),
  });
  return context.decisionRepository.create(decision);
}

export async function rejectWeeklyReport(
  context: WeeklyReviewServiceContext,
  input: {
    weeklyId: string;
    expectedVersion: number;
    feedback: string;
    revisedSections: WeeklyProjectSection[];
  },
): Promise<WeeklyReportVersion> {
  const reports = await context.weeklyRepository.listVersions(input.weeklyId);
  const latest = reports.at(-1);
  if (latest === undefined || latest.version !== input.expectedVersion) {
    throw new WeeklyReviewConflictError();
  }
  await recordDecision(context, {
    weeklyId: input.weeklyId,
    version: latest.version,
    action: 'rejected',
    feedback: input.feedback,
  });
  const next = weeklyReportVersionSchema.parse({
    ...latest,
    version: latest.version + 1,
    sections: input.revisedSections,
    acceptanceState: 'pending',
    publicationState: 'not_published',
    supersedesVersion: latest.version,
    createdAt: context.clock().toISOString(),
  });
  return context.weeklyRepository.create(next);
}

export async function rejectWeeklyReportWithFeedback(
  context: WeeklyReviewServiceContext,
  input: {
    weeklyId: string;
    expectedVersion: number;
    feedback: string;
  },
): Promise<WeeklyReportVersion> {
  const reports = await context.weeklyRepository.listVersions(input.weeklyId);
  const latest = reports.at(-1);
  if (latest === undefined || latest.version !== input.expectedVersion) {
    throw new WeeklyReviewConflictError();
  }
  return rejectWeeklyReport(context, {
    ...input,
    revisedSections: latest.sections,
  });
}

export async function acceptWeeklyReport(
  context: WeeklyReviewServiceContext,
  input: { weeklyId: string; version: number },
): Promise<WeeklyReviewDecision> {
  await requireVersion(context, input.weeklyId, input.version);
  return recordDecision(context, {
    ...input,
    action: 'accepted',
    feedback: null,
  });
}

export async function deferWeeklyReport(
  context: WeeklyReviewServiceContext,
  input: { weeklyId: string; version: number },
): Promise<WeeklyReviewDecision> {
  await requireVersion(context, input.weeklyId, input.version);
  return recordDecision(context, {
    ...input,
    action: 'later',
    feedback: null,
  });
}
