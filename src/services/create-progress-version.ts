import {
  assessProgressEligibility,
  progressVersionSchema,
  resolveContributionAttribution,
  type ProgressDraft,
  type ProgressVersion,
  type ProgressWeek,
} from '../domain/progress.js';
import type { ProgressRepository } from '../storage/markdown-progress-repository.js';

export interface ProgressServiceContext {
  repository: ProgressRepository;
  clock: () => Date;
  id: () => string;
}

export interface CreateProgressVersionInput {
  draft: ProgressDraft;
  week: ProgressWeek;
}

export interface ReviseProgressVersionInput extends CreateProgressVersionInput {
  progressId: string;
  expectedVersion: number;
}

export class ProgressRevisionConflictError extends Error {
  readonly code = 'progress_revision_conflict';

  constructor() {
    super('Progress revision is based on a stale version');
    this.name = 'ProgressRevisionConflictError';
  }
}

function buildProgressVersion(input: {
  draft: ProgressDraft;
  week: ProgressWeek;
  progressId: string;
  version: number;
  supersedesVersion: number | null;
  createdAt: string;
}): ProgressVersion {
  const eligibility = assessProgressEligibility(input.draft, input.week);
  const lifecycleStatus = eligibility.status === 'eligible'
    ? 'eligible'
    : eligibility.status === 'needs_confirmation'
      ? 'needs_material'
      : 'draft';
  return progressVersionSchema.parse({
    ...input.draft,
    schemaVersion: 1,
    progressId: input.progressId,
    version: input.version,
    lifecycleStatus,
    contribution: resolveContributionAttribution(input.draft),
    eligibility,
    supersedesVersion: input.supersedesVersion,
    createdAt: input.createdAt,
  });
}

export async function createProgressVersion(
  context: ProgressServiceContext,
  input: CreateProgressVersionInput,
): Promise<ProgressVersion> {
  const progress = buildProgressVersion({
    draft: input.draft,
    week: input.week,
    progressId: context.id(),
    version: 1,
    supersedesVersion: null,
    createdAt: context.clock().toISOString(),
  });
  return context.repository.create(progress);
}

export async function reviseProgressVersion(
  context: ProgressServiceContext,
  input: ReviseProgressVersionInput,
): Promise<ProgressVersion> {
  const versions = await context.repository.listVersions(input.progressId);
  const latest = versions.at(-1);
  if (latest === undefined || latest.version !== input.expectedVersion) {
    throw new ProgressRevisionConflictError();
  }
  const progress = buildProgressVersion({
    draft: input.draft,
    week: input.week,
    progressId: input.progressId,
    version: latest.version + 1,
    supersedesVersion: latest.version,
    createdAt: context.clock().toISOString(),
  });
  return context.repository.create(progress);
}
