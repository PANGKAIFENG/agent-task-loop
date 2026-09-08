import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../../../src/storage/frontmatter.js';
import { checkDecisionConsistency } from '../../../src/services/check-decision-consistency.js';
import { recordDecisionFeedback } from '../../../src/services/record-decision-feedback.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import { deterministicFeedbackId } from '../../../src/domain/decision-feedback.js';

const POLICY_REF = 'policy.input-routing.synthetic@v001';
const TRACE_A = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const TRACE_B = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5';
const ORPHAN_TRACE = `dt_${'01J'}${'Y'.repeat(23)}`;

const policy: DecisionPolicy = {
  policy_id: 'policy.input-routing.synthetic',
  version: 'v001',
  status: 'observing',
  dimension: 'input-routing',
  decision_question: 'How are inbound inputs routed?',
  inputs: [{ name: 'source', source: 'inbox' }],
  sources: ['synthetic_input'],
  rules: [{ statement: 'Route by declared source', priority: 1 }],
  exceptions: [],
  outputs: ['A routed task'],
  rationale: 'Synthetic baseline for routing decisions',
  examples: [],
  counterexamples: [],
  metrics: ['trace_coverage'],
  next_review_at: '2026-08-24',
  created_at: '2026-08-01T00:00:00.000Z',
  status_history: [],
};

function traceInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: TRACE_A,
    policy_ref: POLICY_REF,
    dimension: 'input-routing',
    input_refs: ['inbox://item-1'],
    decision: 'Route inbox item to the triage queue',
    reasoning_summary: 'Source declared inbox; policy v001 maps inbox sources to triage.',
    evidence_refs: ['receipt://verify-v0.2-loop'],
    confidence: 'high',
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  root: string;
  now: Date;
  ctx: ReturnType<typeof createDecisionServiceContext>;
  tracePath(traceId: string): string;
  samplePath(sampleId: string, createdAt: string): string;
}

const harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'atl-decision-consistency-'));
  const now = new Date('2026-08-18T12:00:00.000Z');
  const ctx = createDecisionServiceContext(root, { clock: () => now });
  const harness: Harness = {
    root,
    now,
    ctx,
    tracePath(traceId: string): string {
      return join(root, '07_System/Logs/Decision_Traces/2026/08', `${traceId}.md`);
    },
    samplePath(sampleId: string, createdAt: string): string {
      return join(
        root,
        '07_System/Logs/Decision_Feedback',
        createdAt.slice(0, 4),
        createdAt.slice(5, 7),
        `${sampleId}.md`,
      );
    },
  };
  harnesses.push(harness);
  await ctx.policies.create(policy);
  return harness;
}

async function seedTrace(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await harness.ctx.traces.create(traceInput(overrides), {
    policyResolver: (ref) => harness.ctx.policies.get(ref as `${string}@${string}`),
  });
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => rm(harness.root, { recursive: true, force: true })));
});

describe('checkDecisionConsistency', () => {
  it('reports an empty vault as clean', async () => {
    const harness = await createHarness();

    const report = await checkDecisionConsistency(harness.ctx);

    expect(report).toEqual({ checked_traces: 0, issues: [] });
  });

  it('reports healthy traces and freshly recorded feedback as clean', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await seedTrace(harness, { trace_id: TRACE_B, created_at: '2026-08-18T10:30:00.000Z' });
    await recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'accepted',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    });

    const report = await checkDecisionConsistency(harness.ctx);

    expect(report.checked_traces).toBe(2);
    expect(report.issues).toEqual([]);
  });

  it('detects a stale summary after an interrupted double write and repairs it', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await expect(recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'accepted',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    }, {
      testHook: () => {
        throw new Error('simulated interruption after sample write');
      },
    })).rejects.toThrow('simulated interruption');

    const [sample] = await harness.ctx.feedback.listByTrace(TRACE_A);
    const sampleId = sample?.feedback_id ?? '';
    const sampleCreatedAt = sample?.created_at ?? '2026-08-18T12:00:00.000Z';
    expect(sampleId).not.toBe('');
    const sampleFile = harness.samplePath(sampleId, sampleCreatedAt);
    const bytesBefore = await readFile(sampleFile, 'utf8');

    const detected = await checkDecisionConsistency(harness.ctx);
    expect(detected.checked_traces).toBe(1);
    expect(detected.issues).toEqual([{
      trace_id: TRACE_A,
      issue: 'feedback_summary_stale',
      action: 'reported',
      detail: expect.stringContaining('feedback_count=0'),
    }]);

    const repaired = await checkDecisionConsistency(harness.ctx, { repair: true });
    expect(repaired.issues).toEqual([{
      trace_id: TRACE_A,
      issue: 'feedback_summary_stale',
      action: 'rebuilt',
      detail: expect.any(String),
    }]);

    // Samples are the source of truth and are never rewritten by repair.
    expect(await readFile(sampleFile, 'utf8')).toBe(bytesBefore);

    const recheck = await checkDecisionConsistency(harness.ctx);
    expect(recheck.issues).toEqual([]);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(1);
    expect(trace?.user_feedback).toBe('accepted');
    expect(trace?.status).toBe('feedback_recorded');
    expect(trace?.feedback_summary_status).toBe('fresh');
  });

  it('detects and rebuilds a wrong-kind summary projection', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'accepted',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    });

    // Simulate drift: a summary projection that disagrees with the samples.
    await harness.ctx.traces.updateFeedbackSummary(TRACE_A, {
      user_feedback: 'rejected',
      final_outcome: 'pending',
      feedback_count: 1,
      latest_feedback_at: null,
    });

    const detected = await checkDecisionConsistency(harness.ctx);
    expect(detected.issues).toHaveLength(1);
    expect(detected.issues[0]).toMatchObject({
      trace_id: TRACE_A,
      issue: 'feedback_summary_mismatch',
      action: 'reported',
    });

    await checkDecisionConsistency(harness.ctx, { repair: true });
    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.user_feedback).toBe('accepted');
    expect(trace?.latest_feedback_at).not.toBeNull();
    expect((await checkDecisionConsistency(harness.ctx)).issues).toEqual([]);
  });

  it('rebuilds a summary whose projection lags on non-count fields', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'deferred',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    });

    // Simulate drift: the count matches but latest_feedback_at was lost.
    await harness.ctx.traces.updateFeedbackSummary(TRACE_A, {
      user_feedback: 'deferred',
      final_outcome: 'pending',
      feedback_count: 1,
      latest_feedback_at: null,
    });
    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.latest_feedback_at).toBeNull();

    const repaired = await checkDecisionConsistency(harness.ctx, { repair: true });
    expect(repaired.issues.map((issue) => issue.trace_id)).toEqual([TRACE_A]);
    const after = await harness.ctx.traces.get(TRACE_A);
    expect(after?.latest_feedback_at).not.toBeNull();
    expect((await checkDecisionConsistency(harness.ctx)).issues).toEqual([]);
  });

  it('treats an explicitly stale flag as repairable', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'accepted',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    });

    // Simulate an externally flagged stale summary.
    const traceFile = harness.tracePath(TRACE_A);
    const document = parseTaskDocument(await readFile(traceFile, 'utf8'));
    document.data.feedback_summary_status = 'stale';
    await writeFile(traceFile, serializeTaskDocument(document.data, document.body), 'utf8');

    const detected = await checkDecisionConsistency(harness.ctx);
    expect(detected.issues[0]).toMatchObject({
      trace_id: TRACE_A,
      issue: 'feedback_summary_stale',
      action: 'reported',
    });

    await checkDecisionConsistency(harness.ctx, { repair: true });
    const after = await harness.ctx.traces.get(TRACE_A);
    expect(after?.feedback_summary_status).toBe('fresh');
    expect((await checkDecisionConsistency(harness.ctx)).issues).toEqual([]);
  });

  it('reports a summary ahead of its samples as a non-repairable violation', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await harness.ctx.traces.updateFeedbackSummary(TRACE_A, {
      user_feedback: 'accepted',
      final_outcome: 'accepted-as-is',
      feedback_count: 1,
      latest_feedback_at: '2026-08-18T11:00:00.000Z',
    });

    const report = await checkDecisionConsistency(harness.ctx, { repair: true });
    expect(report.issues).toEqual([{
      trace_id: TRACE_A,
      issue: 'decision_consistency_violation',
      action: 'reported',
      detail: expect.stringContaining('ahead'),
    }]);

    // Repair must not mask the missing sample by zeroing the summary.
    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(1);
  });

  it('reports orphan samples pointing at a missing trace', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    const orphanId = deterministicFeedbackId(ORPHAN_TRACE, 'paw002-orphan-0001');
    await harness.ctx.feedback.createOrGet({
      feedback_id: orphanId,
      trace_id: ORPHAN_TRACE,
      kind: 'accepted',
      stability: 'unknown',
      correction_summary: null,
      final_outcome: null,
      created_at: '2026-08-18T11:00:00.000Z',
      source_ref: 'chat://user-review-9',
      idempotency_key: 'paw002-orphan-0001',
      policy_ref: POLICY_REF,
    });

    const report = await checkDecisionConsistency(harness.ctx, { repair: true });
    expect(report.checked_traces).toBe(1);
    expect(report.issues).toEqual([{
      trace_id: ORPHAN_TRACE,
      issue: 'decision_consistency_violation',
      action: 'reported',
      detail: expect.stringContaining(orphanId),
    }]);

    // Repair never deletes or rewrites the orphan sample.
    const sampleFile = harness.samplePath(orphanId, '2026-08-18T11:00:00.000Z');
    expect((await readFile(sampleFile, 'utf8')).length).toBeGreaterThan(0);
  });

  it('ignores legacy trace documents as read-only bystanders', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    const legacyPath = join(
      harness.root,
      '07_System/Logs/Decision_Traces/2026/08/trace-paw002-input-routing-001.md',
    );
    await mkdir(join(harness.root, '07_System/Logs/Decision_Traces/2026/08'), { recursive: true });
    await writeFile(legacyPath, [
      '---',
      'type: decision_trace',
      'trace_id: trace-paw002-input-routing-001',
      `policy_ref: ${POLICY_REF}`,
      'dimension: input-routing',
      'input_refs:',
      '  - synthetic_input',
      'decision: Route synthetic input',
      'reasoning_summary: Legacy harness wrote this trace directly.',
      'evidence_refs:',
      '  - receipt://verify-v0.2-loop',
      'confidence: high',
      'user_feedback: none',
      'final_outcome: pending',
      'created_at: 2026-08-17T09:00:00.000Z',
      '---',
      '',
      '# trace-paw002-input-routing-001',
      '',
    ].join('\n'), 'utf8');

    const report = await checkDecisionConsistency(harness.ctx);

    expect(report.checked_traces).toBe(1);
    expect(report.issues).toEqual([]);
    expect(await readFile(legacyPath, 'utf8')).toContain('trace-paw002-input-routing-001');
  });

  it('keeps a closed trace closed while repairing its summary', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await recordDecisionFeedback(harness.ctx, {
      trace_id: TRACE_A,
      kind: 'accepted',
      source_ref: 'chat://user-review-1',
      idempotency_key: 'paw002-review-0001',
    });
    await harness.ctx.traces.close(TRACE_A, 'reviewer');

    // Simulate drift on the closed trace: summary lost its latest feedback.
    await harness.ctx.traces.updateFeedbackSummary(TRACE_A, {
      user_feedback: 'unreviewed',
      final_outcome: 'pending',
      feedback_count: 0,
      latest_feedback_at: null,
    });

    const repaired = await checkDecisionConsistency(harness.ctx, { repair: true });
    expect(repaired.issues[0]).toMatchObject({ trace_id: TRACE_A, action: 'rebuilt' });

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.status).toBe('closed');
    expect(trace?.closed_at).not.toBeNull();
    expect(trace?.feedback_count).toBe(1);
  });
});
