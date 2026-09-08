import { describe, expect, it } from 'vitest';

import {
  deterministicFeedbackId,
  FEEDBACK_KINDS,
  FEEDBACK_STABILITY,
  feedbackSampleSchema,
} from '../../../src/domain/decision-feedback.js';

interface FeedbackFixture {
  feedback_id: string;
  trace_id: string;
  kind: string;
  stability: string;
  correction_summary: string | null;
  final_outcome: string | null;
  created_at: string;
  source_ref: string;
  idempotency_key?: string;
  policy_ref?: string;
}

function omit<T extends object>(source: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));
}

function makeSample(overrides: Partial<FeedbackFixture> = {}): FeedbackFixture {
  return {
    feedback_id: 'fb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    trace_id: 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'accepted',
    stability: 'single_exception',
    correction_summary: null,
    final_outcome: 'accepted_as_candidate',
    created_at: '2026-08-18T06:30:00.000Z',
    source_ref: 'synthetic-loop/run-001#receipt',
    idempotency_key: 'idem-key-0001',
    ...overrides,
  };
}

describe('feedback sample schema', () => {
  it('accepts three legal synthetic fixtures across kinds', () => {
    const accepted = makeSample();
    const corrected = makeSample({
      feedback_id: 'fb_01JT8W2Q7M9XK3V5B1ZH4D6C8E',
      kind: 'corrected',
      stability: 'pattern_candidate',
      correction_summary: 'Should stay in the inbox as information only.',
      final_outcome: 'moved_to_inbox',
      policy_ref: 'policy.input-routing.synthetic@v001',
    });
    const deferred = makeSample({
      feedback_id: 'fb_a1b2c3d4e5f6a7b8c9d0',
      trace_id: 'dt_a1b2c3d4e5f6a7b8c9d0',
      kind: 'deferred',
      stability: 'unknown',
      final_outcome: null,
    });

    for (const fixture of [accepted, corrected, deferred]) {
      const result = feedbackSampleSchema.safeParse(fixture);
      expect(result.success, JSON.stringify(fixture)).toBe(true);
    }
  });

  it('rejects a corrected sample without a correction summary', () => {
    const correctedWithoutSummary = makeSample({
      kind: 'corrected',
      correction_summary: null,
    });
    expect(feedbackSampleSchema.safeParse(correctedWithoutSummary).success).toBe(false);
  });

  it('accepts a corrected sample with a summary and rejects unknown fields (strict)', () => {
    const corrected = makeSample({
      kind: 'corrected',
      correction_summary: 'Reroute to inbox.',
    });
    expect(feedbackSampleSchema.safeParse(corrected).success).toBe(true);

    expect(feedbackSampleSchema.safeParse({ ...corrected, transcript: 'full CoT' }).success)
      .toBe(false);
  });

  it('rejects fixtures with missing required fields', () => {
    expect(feedbackSampleSchema.safeParse(omit(makeSample(), 'source_ref')).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(omit(makeSample(), 'final_outcome')).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(omit(makeSample(), 'correction_summary')).success)
      .toBe(false);
  });

  it('rejects illegal kind and stability enums', () => {
    expect(feedbackSampleSchema.safeParse(makeSample({ kind: 'ignored' })).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({ kind: 'unreviewed' })).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({ stability: 'flaky' })).success).toBe(false);
  });

  it('rejects malformed feedback ids, trace ids, policy refs and dates', () => {
    for (const feedbackId of [
      'fb_01ARZ3NDEKTSV4RRFFQ69G5FAVI', // 27 chars
      'fb_0IARZ3NDEKTSV4RRFFQ69G5FAV',  // I is not in the ULID alphabet
      'fb_A1B2C3D4E5F6A7B8C9D0',        // uppercase in the migration branch
      'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',  // trace prefix
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',     // missing prefix
    ]) {
      expect(feedbackSampleSchema.safeParse(makeSample({ feedback_id: feedbackId })).success, feedbackId)
        .toBe(false);
    }

    expect(feedbackSampleSchema.safeParse(makeSample({
      trace_id: 'trace-001',
    })).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({
      policy_ref: 'policy.input-routing.synthetic',
    })).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({ created_at: '2026-08-18' })).success)
      .toBe(false);
  });

  it('enforces the source_ref and idempotency_key bounds', () => {
    expect(feedbackSampleSchema.safeParse(makeSample({ source_ref: '' })).success).toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({ source_ref: 'r'.repeat(501) })).success)
      .toBe(false);
    expect(feedbackSampleSchema.safeParse(makeSample({ source_ref: 'r'.repeat(500) })).success)
      .toBe(true);

    for (const idempotencyKey of ['short7!', 'x'.repeat(7), 'x'.repeat(129)]) {
      expect(feedbackSampleSchema.safeParse(makeSample({ idempotency_key: idempotencyKey })).success,
        `len=${idempotencyKey.length}`).toBe(false);
    }
    expect(feedbackSampleSchema.safeParse(makeSample({ idempotency_key: 'x'.repeat(8) })).success)
      .toBe(true);
    expect(feedbackSampleSchema.safeParse(makeSample({ idempotency_key: 'x'.repeat(128) })).success)
      .toBe(true);
  });

  it('rejects an overlength correction summary', () => {
    const corrected = makeSample({
      kind: 'corrected',
      correction_summary: 'c'.repeat(1001),
    });
    expect(feedbackSampleSchema.safeParse(corrected).success).toBe(false);

    const atLimit = makeSample({
      kind: 'corrected',
      correction_summary: 'c'.repeat(1000),
    });
    expect(feedbackSampleSchema.safeParse(atLimit).success).toBe(true);
  });

  it('keeps the kind and stability catalogs frozen', () => {
    expect(FEEDBACK_KINDS).toEqual(['accepted', 'corrected', 'rejected', 'deferred']);
    expect(FEEDBACK_STABILITY).toEqual([
      'single_exception',
      'pattern_candidate',
      'confirmed_pattern',
      'unknown',
    ]);
  });
});

describe('deterministicFeedbackId', () => {
  const traceId = 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  it('matches the pinned sha256 projection', () => {
    expect(deterministicFeedbackId(traceId, 'idem-key-0001')).toBe('fb_cc250f4d4073a1cd2e9f');
    expect(deterministicFeedbackId(traceId, 'idem-key-0002')).toBe('fb_572eb604735f9062f3f7');
    expect(deterministicFeedbackId('dt_a1b2c3d4e5f6a7b8c9d0', 'idem-key-0001'))
      .toBe('fb_ecf7afcceca8964bc609');
  });

  it('is deterministic and separates traces and keys', () => {
    expect(deterministicFeedbackId(traceId, 'idem-key-0001'))
      .toBe(deterministicFeedbackId(traceId, 'idem-key-0001'));
    expect(deterministicFeedbackId(traceId, 'idem-key-0001'))
      .not.toBe(deterministicFeedbackId(traceId, 'idem-key-0002'));
    expect(deterministicFeedbackId(traceId, 'idem-key-0001'))
      .not.toBe(deterministicFeedbackId('dt_a1b2c3d4e5f6a7b8c9d0', 'idem-key-0001'));
  });

  it('produces ids the feedback schema accepts', () => {
    const feedbackId = deterministicFeedbackId(traceId, 'idem-key-0001');
    const sample = makeSample({ feedback_id: feedbackId });
    expect(feedbackSampleSchema.safeParse(sample).success).toBe(true);
  });
});
