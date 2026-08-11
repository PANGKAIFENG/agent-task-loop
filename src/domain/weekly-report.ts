import { z } from 'zod';

import type {
  ContributionAttribution,
  ProgressReportCategory,
} from './progress.js';

export interface WeeklyProgressRef {
  progressId: string;
  version: number;
}

export interface WeeklyReportItem {
  progressRef: WeeklyProgressRef;
  topic: string;
  reportCategory: ProgressReportCategory;
  contribution: ContributionAttribution;
  changes: string[];
  conclusions: string[];
  artifacts: Array<{ summary: string; sourceRef: string }>;
  blockers: string[];
  pending: string[];
  sourceRefs: string[];
}

export interface WeeklyProjectSection {
  primaryProjectId: string;
  items: WeeklyReportItem[];
}

export interface WeeklyReportVersion {
  schemaVersion: 1;
  weeklyId: string;
  version: number;
  weekKey: string;
  week: { startDate: string; endDate: string };
  acceptanceState: 'pending' | 'accepted' | 'rejected' | 'later';
  publicationState: 'not_published' | 'published';
  completeness: 'complete' | 'partial_success';
  progressRefs: WeeklyProgressRef[];
  sections: WeeklyProjectSection[];
  omissions: Array<WeeklyProgressRef & { reasons: string[] }>;
  excludedProgressIds: string[];
  pendingCount: number;
  supersedesVersion: number | null;
  createdAt: string;
}

const nonEmptyString = z.string().trim().min(1).max(20_000);
const progressRefSchema = z.object({
  progressId: nonEmptyString,
  version: z.number().int().positive(),
}).strict();
const weeklyItemSchema = z.object({
  progressRef: progressRefSchema,
  topic: nonEmptyString,
  reportCategory: z.enum([
    'product_requirement',
    'project_acceptance',
    'research_share',
    'agent_skill_harness',
    'routine_check',
  ]),
  contribution: z.enum(['self', 'team', 'agent', 'pending']),
  changes: z.array(nonEmptyString),
  conclusions: z.array(nonEmptyString),
  artifacts: z.array(z.object({
    summary: nonEmptyString,
    sourceRef: nonEmptyString,
  }).strict()),
  blockers: z.array(nonEmptyString),
  pending: z.array(nonEmptyString),
  sourceRefs: z.array(nonEmptyString).min(1),
}).strict();

export const weeklyReportVersionSchema: z.ZodType<WeeklyReportVersion> = z.object({
  schemaVersion: z.literal(1),
  weeklyId: nonEmptyString,
  version: z.number().int().positive(),
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
  week: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
  acceptanceState: z.enum(['pending', 'accepted', 'rejected', 'later']),
  publicationState: z.enum(['not_published', 'published']),
  completeness: z.enum(['complete', 'partial_success']),
  progressRefs: z.array(progressRefSchema),
  sections: z.array(z.object({
    primaryProjectId: nonEmptyString,
    items: z.array(weeklyItemSchema).min(1),
  }).strict()),
  omissions: z.array(progressRefSchema.extend({
    reasons: z.array(nonEmptyString).min(1),
  }).strict()),
  excludedProgressIds: z.array(nonEmptyString),
  pendingCount: z.number().int().nonnegative(),
  supersedesVersion: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();
