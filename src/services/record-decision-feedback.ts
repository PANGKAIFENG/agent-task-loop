import { ulid } from 'ulid';
import { z } from 'zod';

import {
  deterministicFeedbackId,
  FEEDBACK_KINDS,
  FEEDBACK_STABILITY,
  type FeedbackSample,
} from '../domain/decision-feedback.js';
import { decisionTraceIdSchema, deriveFeedbackSummary } from '../domain/decision-trace.js';
import {
  DecisionFeedbackInvalidError,
} from '../storage/markdown-decision-feedback-repository.js';
import {
  DecisionTraceInvalidError,
  DecisionTraceNotFoundError,
  withDecisionTraceLock,
} from '../storage/markdown-decision-trace-repository.js';
import type { DecisionServiceContext } from './service-context.js';

/**
 * Legacy harness trace references (`trace-*`, run-v0.2-synthetic-loop.mjs).
 * They are read-only bystanders (PRD acceptance 8): feedback is only recorded
 * against native `dt_*` traces — for a migrated legacy trace, its native copy.
 */
const LEGACY_TRACE_ID_PATTERN = /^trace-/u;

const recordFeedbackInputSchema = z.object({
  trace_id: z.string().trim().min(1).max(200),
  kind: z.enum(FEEDBACK_KINDS),
  source_ref: z.string().trim().min(1).max(500),
  idempotency_key: z.string().min(8).max(128).optional(),
  correction_summary: z.string().trim().min(1).max(1000).optional(),
  final_outcome: z.string().trim().min(1).max(500).optional(),
  stability: z.enum(FEEDBACK_STABILITY).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'corrected' && value.correction_summary === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'kind=corrected requires a correction_summary',
    });
  }
});

export class DecisionTraceReadonlyError extends Error {
  readonly code = 'decision_trace_readonly';

  constructor() {
    super('Decision trace is read-only; record feedback against its native trace instead');
    this.name = 'DecisionTraceReadonlyError';
  }
}

export class DecisionFeedbackTraceClosedError extends Error {
  readonly code = 'decision_feedback_trace_closed';

  constructor() {
    super('Decision trace is closed; reopen it before recording feedback');
    this.name = 'DecisionFeedbackTraceClosedError';
  }
}

export interface RecordFeedbackOptions {
  /**
   * Fault-injection point between sample persistence (step 5) and the summary
   * rebuild (steps 6-8), used to test interruption recovery. A throwing hook
   * simulates a crash after the sample hit disk but before the summary caught
   * up; the persisted sample stays untouched and a replay converges.
   */
  testHook?: (stage: 'afterSampleWrite') => Promise<void> | void;
}

export interface RecordFeedbackResult {
  sample: FeedbackSample;
  created: boolean;
}

/**
 * Feedback orchestration (PRD I1 double-write consistency, M3 replay):
 * inside the per-trace lease lock the sample is persisted first (source of
 * truth), then the trace summary is rebuilt as a deterministic projection of
 * the sample set. Replays of the same idempotency key rebuild the summary
 * inside the lock before returning, so an interrupted double write converges
 * on the very next call with sample bytes unchanged. The lock is itself a
 * vault write: the caller's explicit `ctx.writeAuthorization` rides through
 * the same write gate the repositories already passed, so an authorized
 * non-temporary vault behaves like a temporary one.
 */
export async function recordDecisionFeedback(
  ctx: DecisionServiceContext,
  input: unknown,
  options: RecordFeedbackOptions = {},
): Promise<RecordFeedbackResult> {
  const parsed = recordFeedbackInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DecisionFeedbackInvalidError();
  }
  const traceId = parsed.data.trace_id;
  if (LEGACY_TRACE_ID_PATTERN.test(traceId)) {
    throw new DecisionTraceReadonlyError();
  }
  if (!decisionTraceIdSchema.safeParse(traceId).success) {
    throw new DecisionTraceInvalidError();
  }
  return withDecisionTraceLock(ctx.vaultRoot, traceId, async () => {
    const trace = await ctx.traces.get(traceId);
    if (trace === null) {
      throw new DecisionTraceNotFoundError();
    }
    if (trace.status === 'closed') {
      throw new DecisionFeedbackTraceClosedError();
    }
    const feedbackId = parsed.data.idempotency_key !== undefined
      ? deterministicFeedbackId(traceId, parsed.data.idempotency_key)
      : `fb_${ulid()}`;
    const { sample, created } = await ctx.feedback.createOrGet({
      feedback_id: feedbackId,
      trace_id: traceId,
      kind: parsed.data.kind,
      stability: parsed.data.stability ?? 'unknown',
      correction_summary: parsed.data.correction_summary ?? null,
      final_outcome: parsed.data.final_outcome ?? null,
      created_at: ctx.clock().toISOString(),
      source_ref: parsed.data.source_ref,
      ...(parsed.data.idempotency_key === undefined
        ? {}
        : { idempotency_key: parsed.data.idempotency_key }),
      policy_ref: trace.policy_ref,
    });
    await options.testHook?.('afterSampleWrite');
    const samples = await ctx.feedback.listByTrace(traceId);
    await ctx.traces.updateFeedbackSummary(traceId, deriveFeedbackSummary(samples, trace));
    return { sample, created };
  }, {
    ...(ctx.writeAuthorization === undefined
      ? {}
      : { writeAuthorization: ctx.writeAuthorization }),
  });
}
