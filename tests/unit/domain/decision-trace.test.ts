import { describe, expect, it } from 'vitest';

import type { FeedbackSample } from '../../../src/domain/decision-feedback.js';
import { FEEDBACK_KINDS } from '../../../src/domain/decision-feedback.js';
import {
  decisionTraceSchema,
  deriveFeedbackSummary,
  deriveTraceStatus,
} from '../../../src/domain/decision-trace.js';

interface TraceFixture {
  trace_id: string;
  policy_ref: string;
  dimension: string;
  input_refs: string[];
  decision: string;
  reasoning_summary: string;
  evidence_refs: string[];
  confidence: string;
  user_feedback?: string;
  final_outcome?: string;
  status: string;
  feedback_summary_status: string;
  feedback_count: number;
  latest_feedback_at: string | null;
  created_at: string;
  closed_at?: string | null;
  updated_at?: string | null;
  status_history: { status: string; at: string; actor: string }[];
}

function omit<T extends object>(source: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));
}

function makeTrace(overrides: Partial<TraceFixture> = {}): TraceFixture {
  return {
    trace_id: 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    policy_ref: 'policy.input-routing.synthetic@v001',
    dimension: 'input-routing',
    input_refs: ['wechat/synthetic-message-001'],
    decision: 'candidate',
    reasoning_summary: 'Message contains an explicit commitment; routed to candidate under the observing policy.',
    evidence_refs: ['synthetic/wechat-message-001'],
    confidence: 'high',
    status: 'recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 0,
    latest_feedback_at: null,
    created_at: '2026-08-18T06:00:00.000Z',
    status_history: [
      { status: 'recorded', at: '2026-08-18T06:00:00.000Z', actor: 'synthetic-loop' },
    ],
    ...overrides,
  };
}

function makeSample(overrides: Partial<FeedbackSample> = {}): FeedbackSample {
  return {
    feedback_id: 'fb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    trace_id: 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'accepted',
    stability: 'single_exception',
    correction_summary: null,
    final_outcome: 'accepted',
    created_at: '2026-08-18T06:30:00.000Z',
    source_ref: 'synthetic-loop/run-001#receipt',
    ...overrides,
  };
}

describe('decision trace schema', () => {
  it('accepts a ULID trace id and a migration-derived trace id', () => {
    expect(decisionTraceSchema.safeParse(makeTrace()).success).toBe(true);

    const migrated = makeTrace({
      trace_id: 'dt_a1b2c3d4e5f6a7b8c9d0',
      policy_ref: 'policy.attention-priority.synthetic@v012',
      dimension: 'attention-priority',
    });
    expect(decisionTraceSchema.safeParse(migrated).success).toBe(true);
  });

  it('accepts offset datetimes and applies the M8 defaults', () => {
    const parsed = decisionTraceSchema.parse(makeTrace({
      created_at: '2026-08-18T14:00:00.000+08:00',
    }));
    expect(parsed.user_feedback).toBe('unreviewed');
    expect(parsed.final_outcome).toBe('pending');
  });

  it('accepts explicit feedback summary fields and optional timestamps', () => {
    const parsed = decisionTraceSchema.parse(makeTrace({
      status: 'feedback_recorded',
      feedback_summary_status: 'stale',
      feedback_count: 2,
      latest_feedback_at: '2026-08-18T07:00:00.000Z',
      updated_at: '2026-08-18T07:00:00.000Z',
      closed_at: null,
      user_feedback: 'corrected',
      final_outcome: 'corrected',
    }));
    expect(parsed.status).toBe('feedback_recorded');
    expect(parsed.feedback_summary_status).toBe('stale');
    expect(parsed.closed_at).toBeNull();
  });

  it('rejects fixtures with missing required fields', () => {
    expect(decisionTraceSchema.safeParse(omit(makeTrace(), 'status')).success).toBe(false);
    expect(decisionTraceSchema.safeParse(omit(makeTrace(), 'feedback_count')).success).toBe(false);
    expect(decisionTraceSchema.safeParse(omit(makeTrace(), 'latest_feedback_at')).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse(omit(makeTrace(), 'status_history')).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(decisionTraceSchema.safeParse({ ...makeTrace(), transcript: 'full CoT' }).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse({
      ...makeTrace(),
      status_history: [{ status: 'recorded', at: '2026-08-18T06:00:00.000Z' }],
    }).success).toBe(false);
  });

  it('rejects illegal enums', () => {
    expect(decisionTraceSchema.safeParse(makeTrace({ status: 'new' })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ confidence: 'certain' })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ user_feedback: 'none' })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ feedback_summary_status: 'unknown' })).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ dimension: 'misc' })).success).toBe(false);
  });

  it('rejects malformed trace ids and policy refs', () => {
    for (const traceId of [
      'dt_01ARZ3NDEKTSV4RRFFQ69G5FAVI', // 27 chars
      'dt_01ARZ3NDEKTSV4RRFFQ69G5FA',   // 25 chars
      'dt_0IARZ3NDEKTSV4RRFFQ69G5FAV',  // I is not in the ULID alphabet
      'dt_A1B2C3D4E5F6A7B8C9D0',        // uppercase in the migration branch
      'fb_01ARZ3NDEKTSV4RRFFQ69G5FAV',  // feedback prefix
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',     // missing prefix
    ]) {
      expect(decisionTraceSchema.safeParse(makeTrace({ trace_id: traceId })).success, traceId)
        .toBe(false);
    }

    for (const policyRef of [
      'policy.input-routing.synthetic',  // missing @version
      'policy.input-routing.synthetic@v01',
      'policy.input-routing.synthetic@1',
      'input-routing@v001',
      'policy.Input-Routing.synthetic@v001',
    ]) {
      expect(decisionTraceSchema.safeParse(makeTrace({ policy_ref: policyRef })).success, policyRef)
        .toBe(false);
    }
  });

  it('rejects empty reference arrays, overlength fields and bad dates', () => {
    expect(decisionTraceSchema.safeParse(makeTrace({ input_refs: [] })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ evidence_refs: [] })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ decision: 'd'.repeat(501) })).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ reasoning_summary: 'r'.repeat(2001) })).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ created_at: '2026-08-18' })).success)
      .toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({
      closed_at: '2026-08-18T07:00:00',
    })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ feedback_count: -1 })).success).toBe(false);
    expect(decisionTraceSchema.safeParse(makeTrace({ feedback_count: 1.5 })).success).toBe(false);
  });
});

describe('deriveTraceStatus', () => {
  const sample = makeSample();

  it('returns recorded without samples and without a close timestamp', () => {
    expect(deriveTraceStatus([])).toBe('recorded');
    expect(deriveTraceStatus([], null)).toBe('recorded');
    expect(deriveTraceStatus([], undefined)).toBe('recorded');
  });

  it('returns feedback_recorded once at least one sample exists', () => {
    expect(deriveTraceStatus([sample])).toBe('feedback_recorded');
    expect(deriveTraceStatus([sample, makeSample({ kind: 'rejected' })])).toBe('feedback_recorded');
  });

  it('returns closed only for a non-empty close timestamp, which wins over samples', () => {
    expect(deriveTraceStatus([], '2026-08-19T06:00:00.000Z')).toBe('closed');
    expect(deriveTraceStatus([sample], '2026-08-19T06:00:00.000Z')).toBe('closed');
    expect(deriveTraceStatus([sample], '')).toBe('feedback_recorded');
  });

  it('maps every feedback kind to feedback_recorded and never closes implicitly', () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(deriveTraceStatus([makeSample({ kind })]), kind).toBe('feedback_recorded');
    }
  });
});

describe('deriveFeedbackSummary', () => {
  const trace = decisionTraceSchema.parse(makeTrace());

  it('derives the unreviewed defaults without samples', () => {
    expect(deriveFeedbackSummary([], trace)).toEqual({
      user_feedback: 'unreviewed',
      final_outcome: 'pending',
      feedback_count: 0,
      latest_feedback_at: null,
    });
  });

  it('projects the latest sample kind, outcome, count and timestamp', () => {
    const accepted = makeSample({
      created_at: '2026-08-18T06:30:00.000Z',
      final_outcome: 'accepted_as_candidate',
    });
    const corrected = makeSample({
      feedback_id: 'fb_01JT8W2Q7M9XK3V5B1ZH4D6C8E',
      kind: 'corrected',
      correction_summary: 'Should stay in the inbox as information only.',
      final_outcome: 'moved_to_inbox',
      created_at: '2026-08-18T07:30:00.000Z',
    });

    expect(deriveFeedbackSummary([accepted, corrected], trace)).toEqual({
      user_feedback: 'corrected',
      final_outcome: 'moved_to_inbox',
      feedback_count: 2,
      latest_feedback_at: '2026-08-18T07:30:00.000Z',
    });
  });

  it('is deterministic for unordered input and equal instants with different offsets', () => {
    const first = makeSample({
      feedback_id: 'fb_aaaaaaaaaaaaaaaaaaaa',
      kind: 'accepted',
      final_outcome: 'accepted_as_candidate',
      // Equal instants: 02:00Z == 10:00+08:00
      created_at: '2026-08-18T02:00:00.000Z',
    });
    const second = makeSample({
      feedback_id: 'fb_bbbbbbbbbbbbbbbbbbbb',
      kind: 'rejected',
      final_outcome: 'dismissed',
      created_at: '2026-08-18T10:00:00.000+08:00',
    });

    const forward = deriveFeedbackSummary([first, second], trace);
    const backward = deriveFeedbackSummary([second, first], trace);
    expect(forward).toEqual(backward);
    // Tie on the same instant resolves to the greater feedback id.
    expect(forward.user_feedback).toBe('rejected');
    expect(forward.feedback_count).toBe(2);
    expect(forward.latest_feedback_at).toBe('2026-08-18T10:00:00.000+08:00');
  });

  it('falls back to pending for a null sample outcome and keeps deferred feedback open', () => {
    const deferred = makeSample({
      kind: 'deferred',
      final_outcome: null,
      created_at: '2026-08-18T08:00:00.000Z',
    });

    expect(deriveFeedbackSummary([deferred], trace)).toEqual({
      user_feedback: 'deferred',
      final_outcome: 'pending',
      feedback_count: 1,
      latest_feedback_at: '2026-08-18T08:00:00.000Z',
    });
    expect(deriveTraceStatus([deferred])).toBe('feedback_recorded');
  });

  it('maps every feedback kind onto the user_feedback summary', () => {
    for (const kind of FEEDBACK_KINDS) {
      const summary = deriveFeedbackSummary([makeSample({
        kind,
        correction_summary: kind === 'corrected' ? 'synthetic correction' : null,
        final_outcome: null,
      })], trace);
      expect(summary.user_feedback, kind).toBe(kind);
      expect(summary.final_outcome, kind).toBe('pending');
    }
  });

  it('does not mutate the input sample array', () => {
    const samples = [
      makeSample({ kind: 'accepted', created_at: '2026-08-18T07:30:00.000Z' }),
      makeSample({ kind: 'corrected', correction_summary: 'later correction', created_at: '2026-08-18T06:30:00.000Z' }),
    ];
    const snapshot = samples.map((sample) => ({ ...sample }));

    deriveFeedbackSummary(samples, trace);

    expect(samples).toEqual(snapshot);
  });
});
