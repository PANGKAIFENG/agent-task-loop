import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import { checkDecisionConsistency } from '../../../src/services/check-decision-consistency.js';
import { recordDecisionFeedback } from '../../../src/services/record-decision-feedback.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const POLICY_REF = 'policy.input-routing.synthetic@v001';
const OTHER_POLICY_REF = 'policy.agent-admission.synthetic@v001';
const TRACE_A = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const TRACE_B = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5';
const MISSING_TRACE = `dt_${'01J'}${'Z'.repeat(23)}`;

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

const otherPolicy: DecisionPolicy = {
  ...policy,
  policy_id: 'policy.agent-admission.synthetic',
  dimension: 'agent-admission',
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

function feedbackInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: TRACE_A,
    kind: 'accepted',
    source_ref: 'chat://user-review-1',
    idempotency_key: 'paw002-review-0001',
    ...overrides,
  };
}

interface Harness {
  root: string;
  now: Date;
  ctx: ReturnType<typeof createDecisionServiceContext>;
  feedbackFiles(): Promise<string[]>;
}

const harnesses: Harness[] = [];
const realRoots: string[] = [];

async function listFeedbackFiles(root: string): Promise<string[]> {
  const feedbackRoot = join(root, '07_System/Logs/Decision_Feedback');
  const entries = await readdir(feedbackRoot, { recursive: true, withFileTypes: false })
    .catch(() => [] as string[]);
  return entries.filter((entry) => typeof entry === 'string' && entry.endsWith('.md')).sort();
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'atl-record-feedback-'));
  const now = new Date('2026-08-18T12:00:00.000Z');
  const ctx = createDecisionServiceContext(root, { clock: () => now });
  const harness: Harness = {
    root,
    now,
    ctx,
    feedbackFiles: () => listFeedbackFiles(root),
  };
  harnesses.push(harness);
  await ctx.policies.create(policy);
  await ctx.policies.create(otherPolicy);
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
  await Promise.all(realRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recordDecisionFeedback happy path', () => {
  it('persists the sample and rebuilds the trace summary in one locked flow', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    const result = await recordDecisionFeedback(harness.ctx, feedbackInput({
      kind: 'corrected',
      correction_summary: 'Route to triage only after source confirmation',
      final_outcome: 'task-rerouted',
    }));

    expect(result.created).toBe(true);
    expect(result.sample.trace_id).toBe(TRACE_A);
    expect(result.sample.policy_ref).toBe(POLICY_REF);
    expect(result.sample.stability).toBe('unknown');
    expect(result.sample.correction_summary).toBe('Route to triage only after source confirmation');
    expect((await harness.feedbackFiles()).length).toBe(1);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.status).toBe('feedback_recorded');
    expect(trace?.feedback_summary_status).toBe('fresh');
    expect(trace?.feedback_count).toBe(1);
    expect(trace?.user_feedback).toBe('corrected');
    expect(trace?.final_outcome).toBe('task-rerouted');
    expect(trace?.latest_feedback_at).toBe(result.sample.created_at);
  });

  it('leaves a fresh trace recorded until the first sample lands', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.status).toBe('recorded');
    expect(trace?.user_feedback).toBe('unreviewed');
    expect(trace?.final_outcome).toBe('pending');
    expect(await harness.feedbackFiles()).toEqual([]);
  });
});

describe('recordDecisionFeedback idempotent replay (D3/M3)', () => {
  it('returns the original sample, keeps its bytes and re-freshens the summary', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    const first = await recordDecisionFeedback(harness.ctx, feedbackInput());
    const samplePath = join(
      harness.root,
      '07_System/Logs/Decision_Feedback/2026/08',
      `${first.sample.feedback_id}.md`,
    );
    const bytesBefore = await readFile(samplePath, 'utf8');

    harness.now.setTime(Date.parse('2026-08-18T13:00:00.000Z'));
    const replay = await recordDecisionFeedback(harness.ctx, feedbackInput());

    expect(replay.created).toBe(false);
    expect(replay.sample).toEqual(first.sample);
    expect(await readFile(samplePath, 'utf8')).toBe(bytesBefore);
    expect((await harness.feedbackFiles()).length).toBe(1);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_summary_status).toBe('fresh');
    expect(trace?.feedback_count).toBe(1);

    const report = await checkDecisionConsistency(harness.ctx);
    expect(report.issues).toEqual([]);
  });

  it('creates one new sample per submission when no idempotency key is given', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    const first = await recordDecisionFeedback(harness.ctx, feedbackInput({ idempotency_key: undefined }));
    harness.now.setTime(Date.parse('2026-08-18T12:05:00.000Z'));
    const second = await recordDecisionFeedback(harness.ctx, feedbackInput({
      idempotency_key: undefined,
      kind: 'corrected',
      correction_summary: 'Second submission is a distinct event',
    }));

    expect(first.sample.feedback_id).not.toBe(second.sample.feedback_id);
    expect((await harness.feedbackFiles()).length).toBe(2);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(2);
    expect(trace?.status).toBe('feedback_recorded');
    expect(trace?.user_feedback).toBe('corrected');
    expect(trace?.latest_feedback_at).toBe(second.sample.created_at);
  });

  it('recovers an interrupted double write by replaying the same key', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await expect(recordDecisionFeedback(harness.ctx, feedbackInput(), {
      testHook: () => {
        throw new Error('simulated interruption after sample write');
      },
    })).rejects.toThrow('simulated interruption');

    // The sample is the persisted source of truth; the summary is stale.
    expect((await harness.feedbackFiles()).length).toBe(1);
    let trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(0);
    expect(trace?.status).toBe('recorded');

    const samplePath = join(
      harness.root,
      '07_System/Logs/Decision_Feedback/2026/08',
      `${(await harness.ctx.feedback.listByTrace(TRACE_A))[0]?.feedback_id}.md`,
    );
    const bytesBefore = await readFile(samplePath, 'utf8');

    const replay = await recordDecisionFeedback(harness.ctx, feedbackInput());

    expect(replay.created).toBe(false);
    expect(await readFile(samplePath, 'utf8')).toBe(bytesBefore);
    expect((await harness.feedbackFiles()).length).toBe(1);
    trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_summary_status).toBe('fresh');
    expect(trace?.feedback_count).toBe(1);
    expect(trace?.status).toBe('feedback_recorded');

    const report = await checkDecisionConsistency(harness.ctx);
    expect(report.issues).toEqual([]);
  });
});

describe('recordDecisionFeedback kind × status mapping', () => {
  it.each(['accepted', 'corrected', 'rejected', 'deferred'] as const)(
    'maps kind=%s onto the trace summary',
    async (kind) => {
      const harness = await createHarness();
      await seedTrace(harness);

      await recordDecisionFeedback(harness.ctx, feedbackInput({
        kind,
        ...(kind === 'corrected' ? { correction_summary: 'Triage confirmed late' } : {}),
      }));

      const trace = await harness.ctx.traces.get(TRACE_A);
      expect(trace?.user_feedback).toBe(kind);
      expect(trace?.status).toBe('feedback_recorded');
    },
  );

  it('keeps the trace open on deferred feedback', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await recordDecisionFeedback(harness.ctx, feedbackInput({ kind: 'deferred' }));

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.status).toBe('feedback_recorded');
    expect(trace?.closed_at ?? null).toBeNull();
  });

  it('stays feedback_recorded across multiple samples', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await recordDecisionFeedback(harness.ctx, feedbackInput({ idempotency_key: 'paw002-first-0001' }));
    harness.now.setTime(Date.parse('2026-08-18T12:05:00.000Z'));
    await recordDecisionFeedback(harness.ctx, feedbackInput({
      idempotency_key: 'paw002-second-0002',
      kind: 'rejected',
    }));

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.status).toBe('feedback_recorded');
    expect(trace?.feedback_count).toBe(2);
    expect(trace?.user_feedback).toBe('rejected');
  });
});

describe('recordDecisionFeedback rejections', () => {
  it('rejects feedback on a closed trace until it is explicitly reopened', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await harness.ctx.traces.close(TRACE_A, 'reviewer');

    await expect(recordDecisionFeedback(harness.ctx, feedbackInput()))
      .rejects.toMatchObject({ code: 'decision_feedback_trace_closed' });

    await harness.ctx.traces.reopen(TRACE_A, 'reviewer');
    const result = await recordDecisionFeedback(harness.ctx, feedbackInput());
    expect(result.created).toBe(true);
    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(1);
    expect(trace?.status).toBe('feedback_recorded');
  });

  it('rejects legacy trace references as read-only', async () => {
    const harness = await createHarness();
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

    await expect(recordDecisionFeedback(harness.ctx, feedbackInput({
      trace_id: 'trace-paw002-input-routing-001',
    }))).rejects.toMatchObject({ code: 'decision_trace_readonly' });
    expect((await harness.feedbackFiles()).length).toBe(0);
  });

  it('rejects unknown native traces with decision_trace_not_found', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await expect(recordDecisionFeedback(harness.ctx, feedbackInput({ trace_id: MISSING_TRACE })))
      .rejects.toMatchObject({ code: 'decision_trace_not_found' });
  });

  it('rejects malformed trace references with decision_trace_invalid', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    await expect(recordDecisionFeedback(harness.ctx, feedbackInput({ trace_id: 'not-a-trace' })))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('validates the feedback input before any write', async () => {
    const harness = await createHarness();
    await seedTrace(harness);

    const invalidInputs: Record<string, unknown>[] = [
      feedbackInput({ kind: 'unreviewed' }),
      feedbackInput({ kind: 'corrected' }),
      feedbackInput({ source_ref: '' }),
      feedbackInput({ idempotency_key: 'short' }),
      feedbackInput({ stability: 'sometimes' }),
      feedbackInput({ unknown: 'field' }),
    ];
    for (const invalid of invalidInputs) {
      await expect(recordDecisionFeedback(harness.ctx, invalid))
        .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    }
    expect((await harness.feedbackFiles()).length).toBe(0);

    const trace = await harness.ctx.traces.get(TRACE_A);
    expect(trace?.feedback_count).toBe(0);
  });

  it('records feedback for a second trace independently', async () => {
    const harness = await createHarness();
    await seedTrace(harness);
    await seedTrace(harness, {
      trace_id: TRACE_B,
      policy_ref: OTHER_POLICY_REF,
      dimension: 'agent-admission',
      created_at: '2026-08-18T10:30:00.000Z',
    });

    await recordDecisionFeedback(harness.ctx, feedbackInput());
    await recordDecisionFeedback(harness.ctx, feedbackInput({
      trace_id: TRACE_B,
      kind: 'rejected',
      idempotency_key: 'paw002-admission-0001',
    }));

    const traceA = await harness.ctx.traces.get(TRACE_A);
    const traceB = await harness.ctx.traces.get(TRACE_B);
    expect(traceA?.feedback_count).toBe(1);
    expect(traceA?.user_feedback).toBe('accepted');
    expect(traceB?.feedback_count).toBe(1);
    expect(traceB?.user_feedback).toBe('rejected');
    expect((await harness.feedbackFiles()).length).toBe(2);
  });
});

/**
 * Real-vault regressions must not lean on the env fallback
 * (`ATL_VAULT_ROOT` + `ATL_ALLOW_REAL_WRITES=1`): the explicit token is the
 * only thing that may admit a write, so both env vars are removed for the
 * duration of the body and restored afterwards.
 */
async function withoutEnvVaultWrites<T>(body: () => Promise<T>): Promise<T> {
  const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
  const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
  delete process.env.ATL_ALLOW_REAL_WRITES;
  delete process.env.ATL_VAULT_ROOT;
  try {
    return await body();
  } finally {
    if (previousAllowRealWrites === undefined) {
      delete process.env.ATL_ALLOW_REAL_WRITES;
    } else {
      process.env.ATL_ALLOW_REAL_WRITES = previousAllowRealWrites;
    }
    if (previousConfiguredRoot === undefined) {
      delete process.env.ATL_VAULT_ROOT;
    } else {
      process.env.ATL_VAULT_ROOT = previousConfiguredRoot;
    }
  }
}

/** A vault root outside the OS temporary directory, cleaned by afterEach. */
async function createRealVaultRoot(name: string): Promise<string> {
  const root = resolve(process.cwd(), name);
  realRoots.push(root);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

describe('recordDecisionFeedback vault authorization (real-root regression)', () => {
  const realVaultClock = () => new Date('2026-08-18T12:00:00.000Z');

  it('carries the explicit token across policy -> trace -> feedback on a non-temporary vault', async () => {
    await withoutEnvVaultWrites(async () => {
      const root = await createRealVaultRoot('.test-record-feedback-real-vault');
      const ctx = createDecisionServiceContext(root, {
        clock: realVaultClock,
        writeAuthorization: createVaultWriteAuthorization(root),
      });

      await ctx.policies.create(policy);
      await ctx.traces.create(traceInput(), {
        policyResolver: (ref) => ctx.policies.get(ref as `${string}@${string}`),
      });
      const result = await recordDecisionFeedback(ctx, feedbackInput());

      expect(result.created).toBe(true);
      expect(result.sample.trace_id).toBe(TRACE_A);
      expect((await listFeedbackFiles(root)).length).toBe(1);

      const trace = await ctx.traces.get(TRACE_A);
      expect(trace?.status).toBe('feedback_recorded');
      expect(trace?.feedback_count).toBe(1);
      expect(trace?.user_feedback).toBe('accepted');

      const lockFiles = await readdir(join(root, '07_System/.atl/decision-locks'))
        .catch(() => [] as string[]);
      expect(lockFiles).toEqual([]);
    });
  });

  it('refuses feedback on a non-temporary vault when no authorization is given', async () => {
    await withoutEnvVaultWrites(async () => {
      const root = await createRealVaultRoot('.test-record-feedback-real-vault');
      const authorized = createDecisionServiceContext(root, {
        clock: realVaultClock,
        writeAuthorization: createVaultWriteAuthorization(root),
      });
      await authorized.policies.create(policy);
      await authorized.traces.create(traceInput(), {
        policyResolver: (ref) => authorized.policies.get(ref as `${string}@${string}`),
      });

      const unauthorized = createDecisionServiceContext(root, { clock: realVaultClock });

      await expect(recordDecisionFeedback(unauthorized, feedbackInput()))
        .rejects.toThrow('Vault writes are disabled');
      expect(await listFeedbackFiles(root)).toEqual([]);

      const trace = await unauthorized.traces.get(TRACE_A);
      expect(trace?.feedback_count).toBe(0);
      expect(trace?.status).toBe('recorded');
    });
  });

  it('refuses feedback when the authorization token names a different vault root', async () => {
    await withoutEnvVaultWrites(async () => {
      const root = await createRealVaultRoot('.test-record-feedback-real-vault');
      const otherRoot = await mkdtemp(join(tmpdir(), 'atl-record-feedback-other-'));
      realRoots.push(otherRoot);
      const authorized = createDecisionServiceContext(root, {
        clock: realVaultClock,
        writeAuthorization: createVaultWriteAuthorization(root),
      });
      await authorized.policies.create(policy);
      await authorized.traces.create(traceInput(), {
        policyResolver: (ref) => authorized.policies.get(ref as `${string}@${string}`),
      });

      const wrongRoot = createDecisionServiceContext(root, {
        clock: realVaultClock,
        writeAuthorization: createVaultWriteAuthorization(otherRoot),
      });

      await expect(recordDecisionFeedback(wrongRoot, feedbackInput()))
        .rejects.toThrow('Vault writes are disabled');
      expect(await listFeedbackFiles(root)).toEqual([]);

      const trace = await wrongRoot.traces.get(TRACE_A);
      expect(trace?.feedback_count).toBe(0);
      expect(trace?.status).toBe('recorded');
    });
  });
});
