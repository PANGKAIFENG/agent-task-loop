import { z } from 'zod';

import { calendarDateInTimeZone } from './week-period.js';

export const PROGRESS_EVIDENCE_KINDS = [
  'attendance',
  'discussion',
  'plan',
  'reminder',
  'future_action',
  'task_state_change',
  'confirmed_decision',
  'artifact',
  'blocker',
] as const;

export const REPORTABLE_EVIDENCE_KINDS = [
  'task_state_change',
  'confirmed_decision',
  'artifact',
  'blocker',
] as const;

export type ProgressEvidenceKind = (typeof PROGRESS_EVIDENCE_KINDS)[number];
export type ReportableEvidenceKind = (typeof REPORTABLE_EVIDENCE_KINDS)[number];
export type ProgressStatementKind = 'fact' | 'inference' | 'pending';
export type ContributionAttribution = 'self' | 'team' | 'agent' | 'pending';
export type ProgressReportCategory =
  | 'product_requirement'
  | 'project_acceptance'
  | 'research_share'
  | 'agent_skill_harness'
  | 'routine_check';
export type ProgressLifecycleStatus =
  | 'draft'
  | 'needs_material'
  | 'eligible'
  | 'included';

export interface ProgressStatement {
  kind: ProgressStatementKind;
  text: string;
  sourceRefs: string[];
}

export interface ProgressEvidence {
  kind: ProgressEvidenceKind;
  summary: string;
  sourceRef: string;
}

export interface ProgressDraft {
  topic: string;
  reportCategory: ProgressReportCategory;
  primaryProjectId: string | null;
  occurredAt: string;
  sources: string[];
  statements: ProgressStatement[];
  evidence: ProgressEvidence[];
  selfEvidence: string[];
  agentEvidence: string[];
}

export interface ProgressWeek {
  startDate: string;
  endDate: string;
}

export interface ProgressEligibility {
  status: 'eligible' | 'ineligible' | 'needs_confirmation';
  matchedEvidence: ReportableEvidenceKind[];
  reasons: string[];
}

export interface ProgressVersion extends ProgressDraft {
  schemaVersion: 1;
  progressId: string;
  version: number;
  lifecycleStatus: ProgressLifecycleStatus;
  contribution: ContributionAttribution;
  eligibility: ProgressEligibility;
  supersedesVersion: number | null;
  createdAt: string;
}

const nonEmptyString = z.string().trim().min(1).max(20_000);
const progressStatementSchema = z.object({
  kind: z.enum(['fact', 'inference', 'pending']),
  text: nonEmptyString,
  sourceRefs: z.array(nonEmptyString),
}).strict();
const progressEvidenceSchema = z.object({
  kind: z.enum(PROGRESS_EVIDENCE_KINDS),
  summary: nonEmptyString,
  sourceRef: nonEmptyString,
}).strict();
const progressEligibilitySchema = z.object({
  status: z.enum(['eligible', 'ineligible', 'needs_confirmation']),
  matchedEvidence: z.array(z.enum(REPORTABLE_EVIDENCE_KINDS)),
  reasons: z.array(nonEmptyString),
}).strict();

export const progressVersionSchema: z.ZodType<ProgressVersion> = z.object({
  schemaVersion: z.literal(1),
  progressId: nonEmptyString,
  version: z.number().int().positive(),
  lifecycleStatus: z.enum(['draft', 'needs_material', 'eligible', 'included']),
  topic: nonEmptyString,
  reportCategory: z.enum([
    'product_requirement',
    'project_acceptance',
    'research_share',
    'agent_skill_harness',
    'routine_check',
  ]),
  primaryProjectId: nonEmptyString.nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
  sources: z.array(nonEmptyString),
  statements: z.array(progressStatementSchema),
  evidence: z.array(progressEvidenceSchema),
  selfEvidence: z.array(nonEmptyString),
  agentEvidence: z.array(nonEmptyString),
  contribution: z.enum(['self', 'team', 'agent', 'pending']),
  eligibility: progressEligibilitySchema,
  supersedesVersion: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

const REPORTABLE_EVIDENCE = new Set<ProgressEvidenceKind>(REPORTABLE_EVIDENCE_KINDS);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_CLAIM_PATTERN = /(?:\d|百分之|[一二三四五六七八九十百千万亿]+(?:项|个|类|条|份|人|次|天|周|月|年|元))/u;

function isWithinWeek(occurredAt: string, week: ProgressWeek): boolean {
  let date: string;
  try {
    date = calendarDateInTimeZone(occurredAt, 'Asia/Shanghai');
  } catch {
    return false;
  }
  if (
    !ISO_DATE_PATTERN.test(week.startDate)
    || !ISO_DATE_PATTERN.test(week.endDate)
  ) {
    return false;
  }
  return date >= week.startDate && date <= week.endDate;
}

function numericStatementHasTraceableSource(
  statement: ProgressStatement,
  sources: string[],
): boolean {
  if (!NUMERIC_CLAIM_PATTERN.test(statement.text)) {
    return true;
  }
  return statement.sourceRefs.some((sourceRef) => (
    sourceRef.trim() !== '' && sources.includes(sourceRef)
  ));
}

export function assessProgressEligibility(
  draft: ProgressDraft,
  week: ProgressWeek,
): ProgressEligibility {
  const reasons: string[] = [];
  const matchedEvidence = Array.from(new Set(
    draft.evidence
      .map((evidence) => evidence.kind)
      .filter((kind): kind is ReportableEvidenceKind => REPORTABLE_EVIDENCE.has(kind)),
  ));

  if (draft.primaryProjectId === null || draft.primaryProjectId.trim() === '') {
    reasons.push('缺少唯一主汇报归属');
  }
  if (draft.sources.length === 0 || draft.sources.every((source) => source.trim() === '')) {
    reasons.push('缺少可定位来源');
  }
  if (!isWithinWeek(draft.occurredAt, week)) {
    reasons.push('发生时间不在本周范围');
  }
  if (draft.statements.some((statement) => (
    !numericStatementHasTraceableSource(statement, draft.sources)
  ))) {
    reasons.push('数字缺少可定位来源');
  }

  if (reasons.length > 0) {
    return { status: 'needs_confirmation', matchedEvidence, reasons };
  }
  if (matchedEvidence.length === 0) {
    return {
      status: 'ineligible',
      matchedEvidence,
      reasons: ['只有参会、讨论或计划，没有真实变化证据'],
    };
  }
  return { status: 'eligible', matchedEvidence, reasons };
}

export function resolveContributionAttribution(
  draft: Pick<ProgressDraft, 'selfEvidence' | 'agentEvidence'>,
): ContributionAttribution {
  const hasSelfEvidence = draft.selfEvidence.some((evidence) => evidence.trim() !== '');
  const hasAgentRun = draft.agentEvidence.some((evidence) => evidence.startsWith('run:'));
  const hasAgentArtifact = draft.agentEvidence.some((evidence) => evidence.startsWith('artifact:'));
  const hasAgentEvidence = hasAgentRun && hasAgentArtifact;

  if (hasSelfEvidence && hasAgentEvidence) {
    return 'pending';
  }
  if (hasSelfEvidence) {
    return 'self';
  }
  if (hasAgentEvidence) {
    return 'agent';
  }
  return 'team';
}
