import { z } from 'zod';

import { DECISION_DIMENSIONS } from './decision-policy.js';
import type { FeedbackSample } from './decision-feedback.js';

export const TRACE_STATUSES = ['recorded', 'feedback_recorded', 'closed'] as const;

/** Feedback summary freshness (M7): fresh = summary matches samples, stale = summary lagging. */
export const FEEDBACK_SUMMARY_STATUS = ['fresh', 'stale'] as const;

export const USER_FEEDBACK = [
  'unreviewed',
  'accepted',
  'corrected',
  'rejected',
  'deferred',
] as const;

export type TraceStatus = (typeof TRACE_STATUSES)[number];
export type FeedbackSummaryStatus = (typeof FEEDBACK_SUMMARY_STATUS)[number];
export type UserFeedback = (typeof USER_FEEDBACK)[number];

const traceIdPattern = /^dt_([0-9A-HJKMNP-TV-Z]{26}|[0-9a-z]{20})$/u;
const policyRefPattern = /^policy\.[a-z0-9.-]+@v\d{3}$/u;

/** Native ULID trace id or the 20-char lowercase migration-derived form (D8). */
export const decisionTraceIdSchema = z.string().regex(traceIdPattern);

/** `policy.<id>@vNNN` reference format (D9). */
export const decisionPolicyRefSchema = z.string().regex(policyRefPattern);

const traceStatusHistoryEntrySchema = z.object({
  status: z.enum(TRACE_STATUSES),
  at: z.iso.datetime({ offset: true }),
  actor: z.string().trim().min(1).max(200),
}).strict();

export const decisionTraceSchema = z.object({
  trace_id: decisionTraceIdSchema,
  policy_ref: decisionPolicyRefSchema,
  dimension: z.enum(DECISION_DIMENSIONS),
  input_refs: z.array(z.string().trim().min(1)).min(1),
  decision: z.string().trim().min(1).max(500),
  reasoning_summary: z.string().trim().min(1).max(2000),
  evidence_refs: z.array(z.string().trim().min(1)).min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  user_feedback: z.enum(USER_FEEDBACK).default('unreviewed'),
  final_outcome: z.string().trim().min(1).default('pending'),
  status: z.enum(TRACE_STATUSES),
  feedback_summary_status: z.enum(FEEDBACK_SUMMARY_STATUS),
  feedback_count: z.number().int().min(0),
  latest_feedback_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  closed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  updated_at: z.iso.datetime({ offset: true }).nullable().optional(),
  status_history: z.array(traceStatusHistoryEntrySchema),
}).strict();

export type TraceStatusHistoryEntry = z.infer<typeof traceStatusHistoryEntrySchema>;
export type DecisionTrace = z.infer<typeof decisionTraceSchema>;

export interface DerivedFeedbackSummary {
  user_feedback: UserFeedback;
  final_outcome: string;
  feedback_count: number;
  latest_feedback_at: string | null;
}

function compareSamples(left: FeedbackSample, right: FeedbackSample): number {
  const timeDelta = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  if (left.feedback_id !== right.feedback_id) {
    return left.feedback_id < right.feedback_id ? -1 : 1;
  }
  return 0;
}

/**
 * Trace status is derived, never free-form (PRD I3): a non-empty close timestamp
 * wins, otherwise at least one persisted sample means `feedback_recorded`.
 */
export function deriveTraceStatus(
  samples: FeedbackSample[],
  closedAt?: string | null,
): TraceStatus {
  if (closedAt !== null && closedAt !== undefined && closedAt !== '') {
    return 'closed';
  }
  return samples.length >= 1 ? 'feedback_recorded' : 'recorded';
}

/**
 * The trace feedback summary is a pure projection of the sample set (PRD I1).
 * `previous` is part of the frozen call contract; every returned field is
 * derived from the samples alone so the rebuild stays idempotent.
 */
export function deriveFeedbackSummary(
  samples: FeedbackSample[],
  previous: DecisionTrace,
): DerivedFeedbackSummary {
  void previous;
  const latest = [...samples].sort(compareSamples).at(-1);
  if (latest === undefined) {
    return {
      user_feedback: 'unreviewed',
      final_outcome: 'pending',
      feedback_count: 0,
      latest_feedback_at: null,
    };
  }
  return {
    user_feedback: latest.kind,
    final_outcome: latest.final_outcome ?? 'pending',
    feedback_count: samples.length,
    latest_feedback_at: latest.created_at,
  };
}
