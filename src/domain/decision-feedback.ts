import { createHash } from 'node:crypto';

import { z } from 'zod';

import { decisionPolicyRefSchema, decisionTraceIdSchema } from './decision-trace.js';

export const FEEDBACK_KINDS = ['accepted', 'corrected', 'rejected', 'deferred'] as const;

export const FEEDBACK_STABILITY = [
  'single_exception',
  'pattern_candidate',
  'confirmed_pattern',
  'unknown',
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackStability = (typeof FEEDBACK_STABILITY)[number];

const feedbackIdPattern = /^fb_([0-9A-HJKMNP-TV-Z]{26}|[0-9a-z]{20})$/u;
export const feedbackIdSchema = z.string().regex(feedbackIdPattern);

export const feedbackSampleSchema = z.object({
  feedback_id: feedbackIdSchema,
  trace_id: decisionTraceIdSchema,
  kind: z.enum(FEEDBACK_KINDS),
  stability: z.enum(FEEDBACK_STABILITY),
  correction_summary: z.string().trim().min(1).max(1000).nullable(),
  final_outcome: z.string().trim().min(1).max(500).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  source_ref: z.string().trim().min(1).max(500),
  idempotency_key: z.string().min(8).max(128).optional(),
  policy_ref: decisionPolicyRefSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'corrected' && value.correction_summary === null) {
    context.addIssue({
      code: 'custom',
      message: 'kind=corrected requires a non-null correction_summary',
    });
  }
});

export type FeedbackSample = z.infer<typeof feedbackSampleSchema>;

/**
 * Deterministic idempotent feedback id (D3): same trace + key always maps to
 * the same `fb_<sha20>` id, which makes create-only persistence idempotent.
 */
export function deterministicFeedbackId(traceId: string, idempotencyKey: string): string {
  return `fb_${createHash('sha256').update(`${traceId}:${idempotencyKey}`).digest('hex').slice(0, 20)}`;
}
