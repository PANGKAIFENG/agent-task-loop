import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import type {
  DecisionTrace,
  DerivedFeedbackSummary,
} from '../../../src/domain/decision-trace.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';
import {
  DecisionPolicyRefUnresolvedError,
  DecisionTraceConflictError,
  MarkdownDecisionTraceRepository,
  withDecisionTraceLock,
} from '../../../src/storage/markdown-decision-trace-repository.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const FIXED_NOW = new Date('2026-08-18T12:00:00.000Z');
const TRACE_A = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const TRACE_B = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5';
const TRACE_MIGRATED = 'dt_abcdef0123456789abcd';
const POLICY_REF = 'policy.input-routing.synthetic@v001';
const OTHER_POLICY_REF = 'policy.agent-admission.synthetic@v001';

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

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: TRACE_A,
    policy_ref: POLICY_REF,
    dimension: 'input-routing',
    input_refs: ['inbox://item-1', 'goal://PAW-GOAL-002@0.2'],
    decision: 'Route inbox item to the triage queue',
    reasoning_summary: 'Source declared inbox; policy v001 maps inbox sources to triage.',
    evidence_refs: ['receipt://verify-v0.2-loop'],
    confidence: 'high',
    created_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function expectedCreatedTrace(input: Record<string, unknown>): DecisionTrace {
  return {
    trace_id: input.trace_id,
    policy_ref: input.policy_ref,
    dimension: input.dimension,
    input_refs: input.input_refs,
    decision: input.decision,
    reasoning_summary: input.reasoning_summary,
    evidence_refs: input.evidence_refs,
    confidence: input.confidence,
    user_feedback: 'unreviewed',
    final_outcome: 'pending',
    status: 'recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 0,
    latest_feedback_at: null,
    created_at: input.created_at,
    closed_at: null,
    updated_at: null,
    status_history: [{ status: 'recorded', at: input.created_at, actor: 'system' }],
  } as DecisionTrace;
}

function derivedSummary(overrides: Partial<DerivedFeedbackSummary> = {}): DerivedFeedbackSummary {
  return {
    user_feedback: 'accepted',
    final_outcome: 'accepted-as-is',
    feedback_count: 1,
    latest_feedback_at: '2026-08-18T11:00:00.000Z',
    ...overrides,
  };
}

const LEGACY_TRACE_PATH = '07_System/Logs/Decision_Traces/2026/08/trace-paw002-input-routing-001.md';
const LEGACY_TRACE_CONTENT = `---
type: decision_trace
trace_id: trace-paw002-input-routing-001
policy_ref: ${POLICY_REF}
dimension: input-routing
input_refs:
  - synthetic_input
decision: Route synthetic input
reasoning_summary: Legacy harness wrote this trace directly.
evidence_refs:
  - receipt://verify-v0.2-loop
confidence: high
user_feedback: none
final_outcome: pending
created_at: 2026-08-17T09:00:00.000Z
---

# trace-paw002-input-routing-001

## Decision history

- No correction recorded.
`;

const roots: string[] = [];

async function vaultRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-decision-traces-'));
  roots.push(root);
  return root;
}

async function listVaultFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listVaultFiles(root, path));
    } else {
      files.push(path.slice(root.length + 1));
    }
  }
  return files.sort();
}

async function writeLegacyTrace(root: string): Promise<void> {
  await mkdir(join(root, LEGACY_TRACE_PATH, '..'), { recursive: true });
  await writeFile(join(root, LEGACY_TRACE_PATH), LEGACY_TRACE_CONTENT, 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MarkdownDecisionTraceRepository create', () => {
  it('persists a native trace under YYYY/MM derived from created_at', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const input = createInput();

    const created = await repository.create(input, { policyResolver: async () => policy });

    expect(created).toEqual(expectedCreatedTrace(input));
    expect(await listVaultFiles(root)).toEqual([
      '07_System/Logs/Decision_Traces/2026/08/'
        + `${input.trace_id}.md`,
    ]);
    const raw = await readFile(
      join(root, '07_System/Logs/Decision_Traces/2026/08', `${input.trace_id}.md`),
      'utf8',
    );
    const { data, body } = parseTaskDocument(raw);
    expect(data.trace_id).toBe(input.trace_id);
    expect(data.input_refs).toEqual(input.input_refs);
    expect(data.status).toBe('recorded');
    expect(body).toContain(String(input.decision));
    expect(body).toContain(String(input.reasoning_summary));
    expect(body).not.toContain('transcript');
    expect(raw).not.toContain('chain-of-thought');
  });

  it('serializes deterministically: identical input yields identical bytes in a fresh vault', async () => {
    const rootA = await vaultRoot();
    const rootB = await vaultRoot();
    const options = { clock: () => FIXED_NOW };
    const input = createInput();

    await new MarkdownDecisionTraceRepository(rootA, options)
      .create(input, { policyResolver: async () => policy });
    await new MarkdownDecisionTraceRepository(rootB, options)
      .create(input, { policyResolver: async () => policy });

    const rawA = await readFile(
      join(rootA, '07_System/Logs/Decision_Traces/2026/08', `${input.trace_id}.md`),
      'utf8',
    );
    const rawB = await readFile(
      join(rootB, '07_System/Logs/Decision_Traces/2026/08', `${input.trace_id}.md`),
      'utf8',
    );
    expect(rawA).toBe(rawB);
  });

  it('rejects schema-invalid traces without leaving any residue', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.create(
      createInput({ input_refs: [] }),
      { policyResolver: async () => policy },
    )).rejects.toMatchObject({
      name: 'DecisionTraceInvalidError',
      code: 'decision_trace_invalid',
    });
    await expect(repository.create(
      createInput({ unknown_field: 'x' }),
      { policyResolver: async () => policy },
    )).rejects.toMatchObject({ code: 'decision_trace_invalid' });
    await expect(repository.create(
      createInput({ created_at: 'not-a-date' }),
      { policyResolver: async () => policy },
    )).rejects.toMatchObject({ code: 'decision_trace_invalid' });

    expect(await listVaultFiles(root)).toEqual([]);
  });

  it('rejects unsafe trace ids before any filesystem access', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    let resolverCalls = 0;

    await expect(repository.create(
      createInput({ trace_id: 'dt_../../escape' }),
      {
        policyResolver: async () => {
          resolverCalls += 1;
          return policy;
        },
      },
    )).rejects.toMatchObject({ code: 'decision_trace_invalid' });

    expect(resolverCalls).toBe(0);
    expect(await listVaultFiles(root)).toEqual([]);
  });

  it('rejects malformed policy refs without calling the resolver', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    let resolverCalls = 0;

    await expect(repository.create(
      createInput({ policy_ref: 'policy.Not-Valid@v1' }),
      {
        policyResolver: async () => {
          resolverCalls += 1;
          return policy;
        },
      },
    )).rejects.toMatchObject({ code: 'decision_trace_invalid' });

    expect(resolverCalls).toBe(0);
  });

  it('rejects unresolved policy references with decision_policy_ref_unresolved', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.create(
      createInput(),
      { policyResolver: async () => null },
    )).rejects.toMatchObject({
      name: 'DecisionPolicyRefUnresolvedError',
      code: 'decision_policy_ref_unresolved',
    });

    expect(await listVaultFiles(root)).toEqual([]);
  });

  it('requires a policyResolver option', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.create(createInput(), {} as never))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
    expect(await listVaultFiles(root)).toEqual([]);
  });

  it('rejects duplicate trace creation and preserves the original file', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const input = createInput();
    await repository.create(input, { policyResolver: async () => policy });

    const originalRaw = await readFile(
      join(root, '07_System/Logs/Decision_Traces/2026/08', `${input.trace_id}.md`),
      'utf8',
    );

    await expect(repository.create(
      createInput({ decision: 'Conflicting duplicate decision' }),
      { policyResolver: async () => policy },
    )).rejects.toMatchObject({
      name: 'DecisionTraceConflictError',
      code: 'decision_trace_conflict',
    });

    const rawAfter = await readFile(
      join(root, '07_System/Logs/Decision_Traces/2026/08', `${input.trace_id}.md`),
      'utf8',
    );
    expect(rawAfter).toBe(originalRaw);
    expect(await listVaultFiles(root)).toEqual([
      `07_System/Logs/Decision_Traces/2026/08/${input.trace_id}.md`,
    ]);
  });

  it('refuses real-root writes without an explicit authorization', async () => {
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    try {
      const realRoot = resolve(process.cwd(), '.test-decision-trace-real-vault');
      const repository = new MarkdownDecisionTraceRepository(realRoot, { clock: () => FIXED_NOW });

      await expect(repository.create(
        createInput(),
        { policyResolver: async () => policy },
      )).rejects.toThrow('Vault writes are disabled');
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
  });
});

describe('MarkdownDecisionTraceRepository get', () => {
  it('returns null for unknown trace ids', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    expect(await repository.get(TRACE_A)).toBeNull();
  });

  it('reads a created trace back with all judgment fields intact', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const input = createInput();
    await repository.create(input, { policyResolver: async () => policy });

    await expect(repository.get(String(input.trace_id)))
      .resolves.toEqual(expectedCreatedTrace(input));
  });

  it('accepts migration-derived lowercase trace ids', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const input = createInput({ trace_id: TRACE_MIGRATED });
    await repository.create(input, { policyResolver: async () => policy });

    await expect(repository.get(TRACE_MIGRATED))
      .resolves.toEqual(expectedCreatedTrace(input));
  });

  it('rejects legacy-style ids as not addressable by the native repository', async () => {
    const root = await vaultRoot();
    await writeLegacyTrace(root);
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.get('trace-paw002-input-routing-001'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('rejects native-keyed files whose content is not a native trace document', async () => {
    const root = await vaultRoot();
    const corruptPath = join(
      root,
      '07_System/Logs/Decision_Traces/2026/08',
      `${TRACE_B}.md`,
    );
    await mkdir(join(corruptPath, '..'), { recursive: true });
    await writeFile(corruptPath, 'not a markdown document', 'utf8');
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.get(TRACE_B))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });
});

describe('MarkdownDecisionTraceRepository listByPolicyRef', () => {
  it('lists traces of a policy ref ordered by created_at then trace_id', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(
      createInput({
        trace_id: TRACE_B,
        created_at: '2026-07-05T08:00:00.000Z',
      }),
      { policyResolver: async () => policy },
    );
    await repository.create(
      createInput({
        trace_id: TRACE_A,
        created_at: '2026-08-18T10:00:00.000Z',
      }),
      { policyResolver: async () => policy },
    );
    await repository.create(
      createInput({
        trace_id: TRACE_MIGRATED,
        policy_ref: OTHER_POLICY_REF,
        created_at: '2026-06-01T08:00:00.000Z',
      }),
      { policyResolver: async () => policy },
    );

    const listed = await repository.listByPolicyRef(POLICY_REF);

    expect(listed.map((trace) => trace.trace_id)).toEqual([TRACE_B, TRACE_A]);
  });

  it('breaks created_at ties deterministically by trace_id', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const sameInstant = '2026-08-18T10:00:00.000Z';
    await repository.create(
      createInput({ trace_id: TRACE_B, created_at: sameInstant }),
      { policyResolver: async () => policy },
    );
    await repository.create(
      createInput({ trace_id: TRACE_A, created_at: sameInstant }),
      { policyResolver: async () => policy },
    );

    const listed = await repository.listByPolicyRef(POLICY_REF);

    expect(listed.map((trace) => trace.trace_id)).toEqual([TRACE_A, TRACE_B]);
  });

  it('tolerates coexisting legacy files: skips them and never mutates them', async () => {
    const root = await vaultRoot();
    await writeLegacyTrace(root);
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });

    const listed = await repository.listByPolicyRef(POLICY_REF);

    expect(listed.map((trace) => trace.trace_id)).toEqual([TRACE_A]);
    expect(await readFile(join(root, LEGACY_TRACE_PATH), 'utf8')).toBe(LEGACY_TRACE_CONTENT);
  });

  it('rejects malformed policy refs', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.listByPolicyRef('policy/invalid'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });
});

describe('MarkdownDecisionTraceRepository updateFeedbackSummary', () => {
  it('replaces only the summary zone and records the derived status transition', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    const input = createInput();
    await repository.create(input, { policyResolver: async () => policy });
    const tracePath = join(
      root,
      '07_System/Logs/Decision_Traces/2026/08',
      `${input.trace_id}.md`,
    );
    const before = parseTaskDocument(await readFile(tracePath, 'utf8')).data;

    const updated = await repository.updateFeedbackSummary(TRACE_A, derivedSummary());

    expect(updated.user_feedback).toBe('accepted');
    expect(updated.final_outcome).toBe('accepted-as-is');
    expect(updated.feedback_count).toBe(1);
    expect(updated.latest_feedback_at).toBe('2026-08-18T11:00:00.000Z');
    expect(updated.feedback_summary_status).toBe('fresh');
    expect(updated.status).toBe('feedback_recorded');
    expect(updated.updated_at).toBe(FIXED_NOW.toISOString());
    expect(updated.status_history).toEqual([
      { status: 'recorded', at: input.created_at, actor: 'system' },
      { status: 'feedback_recorded', at: FIXED_NOW.toISOString(), actor: 'system' },
    ]);

    const after = parseTaskDocument(await readFile(tracePath, 'utf8')).data;
    for (const key of [
      'trace_id',
      'policy_ref',
      'dimension',
      'input_refs',
      'decision',
      'reasoning_summary',
      'evidence_refs',
      'confidence',
      'created_at',
    ]) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(updated.decision).toBe(input.decision);
    expect(updated.reasoning_summary).toBe(input.reasoning_summary);
    expect(updated.input_refs).toEqual(input.input_refs);
  });

  it('does not append history when the derived status is unchanged', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    await repository.updateFeedbackSummary(TRACE_A, derivedSummary());

    const updated = await repository.updateFeedbackSummary(TRACE_A, derivedSummary({
      user_feedback: 'corrected',
      final_outcome: 'corrected-output',
      feedback_count: 2,
      latest_feedback_at: '2026-08-18T11:30:00.000Z',
    }));

    expect(updated.status).toBe('feedback_recorded');
    expect(updated.status_history).toHaveLength(2);
    expect(updated.user_feedback).toBe('corrected');
  });

  it('keeps a closed trace closed while rebuilding its summary', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    const closed = await repository.close(TRACE_A, 'user:linctex');

    const updated = await repository.updateFeedbackSummary(
      TRACE_A,
      derivedSummary(),
      closed.closed_at,
    );

    expect(updated.status).toBe('closed');
    expect(updated.closed_at).toBe(closed.closed_at);
    expect(updated.feedback_count).toBe(1);
  });

  it('fails with decision_trace_not_found for unknown traces', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.updateFeedbackSummary(TRACE_A, derivedSummary()))
      .rejects.toMatchObject({
        name: 'DecisionTraceNotFoundError',
        code: 'decision_trace_not_found',
      });
  });

  it('fails with decision_trace_conflict when the document changed after the read', async () => {
    const root = await vaultRoot();
    const tracePath = join(
      root,
      '07_System/Logs/Decision_Traces/2026/08',
      `${TRACE_A}.md`,
    );
    let tampered = false;
    const clock = (): Date => {
      if (!tampered) {
        tampered = true;
        // Synchronous on purpose: simulates a concurrent writer replacing the
        // document between the repository's read and its CAS replacement.
        writeFileSync(tracePath, '---\ncorrupted: true\n---\nconcurrently replaced\n', 'utf8');
      }
      return FIXED_NOW;
    };
    const repository = new MarkdownDecisionTraceRepository(root, { clock });
    await repository.create(createInput(), { policyResolver: async () => policy });

    await expect(repository.updateFeedbackSummary(TRACE_A, derivedSummary()))
      .rejects.toMatchObject({
        name: 'DecisionTraceConflictError',
        code: 'decision_trace_conflict',
      });
    await expect(readFile(tracePath, 'utf8'))
      .resolves.toBe('---\ncorrupted: true\n---\nconcurrently replaced\n');
  });
});

describe('MarkdownDecisionTraceRepository close and reopen', () => {
  it('closes explicitly with an audited status_history entry', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });

    const closed = await repository.close(TRACE_A, 'user:linctex');

    expect(closed.status).toBe('closed');
    expect(closed.closed_at).toBe(FIXED_NOW.toISOString());
    expect(closed.updated_at).toBe(FIXED_NOW.toISOString());
    expect(closed.status_history.at(-1)).toEqual({
      status: 'closed',
      at: FIXED_NOW.toISOString(),
      actor: 'user:linctex',
    });
    await expect(repository.get(TRACE_A)).resolves.toEqual(closed);
  });

  it('rejects closing an already closed trace', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    await repository.close(TRACE_A, 'user:linctex');

    await expect(repository.close(TRACE_A, 'user:linctex'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('rejects closing unknown traces or using an empty actor', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });

    await expect(repository.close(TRACE_B, 'user:linctex'))
      .rejects.toMatchObject({ code: 'decision_trace_not_found' });
    await expect(repository.close(TRACE_A, '  '))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('reopens audited and derives the pre-close feedback status', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    await repository.updateFeedbackSummary(TRACE_A, derivedSummary());
    await repository.close(TRACE_A, 'user:linctex');

    const reopened = await repository.reopen(TRACE_A, 'user:linctex');

    expect(reopened.status).toBe('feedback_recorded');
    expect(reopened.closed_at).toBeNull();
    expect(reopened.feedback_count).toBe(1);
    expect(reopened.status_history.at(-1)).toEqual({
      status: 'feedback_recorded',
      at: FIXED_NOW.toISOString(),
      actor: 'user:linctex',
    });
  });

  it('reopens to recorded when no feedback was ever recorded', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    await repository.close(TRACE_A, 'user:linctex');

    const reopened = await repository.reopen(TRACE_A, 'user:linctex');

    expect(reopened.status).toBe('recorded');
    expect(reopened.closed_at).toBeNull();
  });

  it('rejects reopening a trace that is not closed', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });

    await expect(repository.reopen(TRACE_A, 'user:linctex'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('rejects mutation of a native-keyed file with foreign content', async () => {
    const root = await vaultRoot();
    const corruptPath = join(
      root,
      '07_System/Logs/Decision_Traces/2026/08',
      `${TRACE_B}.md`,
    );
    await mkdir(join(corruptPath, '..'), { recursive: true });
    await writeFile(corruptPath, '---\nnot: native\n---\n', 'utf8');
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.close(TRACE_B, 'user:linctex'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
    await expect(repository.reopen(TRACE_B, 'user:linctex'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
    await expect(repository.updateFeedbackSummary(TRACE_B, derivedSummary()))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });
});

describe('MarkdownDecisionTraceRepository legacy read-only behavior', () => {
  it('never modifies legacy files across create, read, update, close and reopen', async () => {
    const root = await vaultRoot();
    await writeLegacyTrace(root);
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await repository.create(createInput(), { policyResolver: async () => policy });
    await repository.listByPolicyRef(POLICY_REF);
    await repository.get(TRACE_A);
    await repository.updateFeedbackSummary(TRACE_A, derivedSummary());
    await repository.close(TRACE_A, 'user:linctex');
    await repository.reopen(TRACE_A, 'user:linctex');

    expect(await readFile(join(root, LEGACY_TRACE_PATH), 'utf8')).toBe(LEGACY_TRACE_CONTENT);
    expect(await repository.listByPolicyRef(POLICY_REF)).toHaveLength(1);
  });

  it('leaves no temporary files behind after rejected or failed writes', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });
    await repository.create(createInput(), { policyResolver: async () => policy });
    await expect(repository.create(createInput(), { policyResolver: async () => policy }))
      .rejects.toBeInstanceOf(DecisionTraceConflictError);
    await expect(repository.create(createInput(), { policyResolver: async () => null }))
      .rejects.toBeInstanceOf(DecisionPolicyRefUnresolvedError);

    const files = await listVaultFiles(root);
    expect(files).toEqual([`07_System/Logs/Decision_Traces/2026/08/${TRACE_A}.md`]);
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('never follows or clobbers a symlinked trace path', async () => {
    const root = await vaultRoot();
    const outsidePath = join(root, 'outside-target.md');
    await writeFile(outsidePath, 'outside content', 'utf8');
    const monthDirectory = join(root, '07_System/Logs/Decision_Traces/2026/08');
    await mkdir(monthDirectory, { recursive: true });
    await symlink(outsidePath, join(monthDirectory, `${TRACE_A}.md`));
    const repository = new MarkdownDecisionTraceRepository(root, { clock: () => FIXED_NOW });

    await expect(repository.get(TRACE_A)).resolves.toBeNull();
    await expect(repository.create(createInput(), { policyResolver: async () => policy }))
      .rejects.toMatchObject({ code: 'decision_trace_conflict' });

    expect(await readFile(outsidePath, 'utf8')).toBe('outside content');
  });
});

describe('withDecisionTraceLock', () => {
  it('holds the lease under 07_System/.atl/decision-locks and releases it', async () => {
    const root = await vaultRoot();
    const lockKey = createHash('sha256').update(TRACE_A).digest('hex');
    const lockPath = join(root, '07_System/.atl/decision-locks', `${lockKey}.lock`);

    let observed = false;
    await withDecisionTraceLock(root, TRACE_A, async () => {
      observed = true;
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('ownerToken');
    });

    expect(observed).toBe(true);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-native trace ids', async () => {
    const root = await vaultRoot();

    await expect(withDecisionTraceLock(root, 'trace-legacy-001', async () => 'unused'))
      .rejects.toMatchObject({ code: 'decision_trace_invalid' });
  });

  it('times out when another holder keeps the lock', async () => {
    const root = await vaultRoot();
    let holderEntered!: () => void;
    const holderAcquired = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withDecisionTraceLock(root, TRACE_A, async () => {
      holderEntered();
      await holderReleased;
    });
    await holderAcquired;

    await expect(withDecisionTraceLock(root, TRACE_A, async () => 'unused', {
      attempts: 1,
      retryMs: 1,
      leaseMs: 60_000,
      clock: () => FIXED_NOW,
    })).rejects.toMatchObject({
      name: 'DecisionTraceLockTimeoutError',
      code: 'decision_trace_lock_timeout',
    });

    releaseHolder();
    await holder;
  });

  it('reclaims an expired lease from an absent owner', async () => {
    const root = await vaultRoot();
    const lockKey = createHash('sha256').update(TRACE_A).digest('hex');
    const lockRoot = join(root, '07_System/.atl/decision-locks');
    await mkdir(lockRoot, { recursive: true });
    const acquiredAt = new Date('2026-08-18T00:00:00.000Z');
    const metadata = {
      ownerToken: '0aa7ba5e-77ec-4cd0-a1f5-3e8a5d9c2b41',
      ownerPid: 2_147_483_000,
      acquiredAt: acquiredAt.toISOString(),
      leaseExpiresAt: new Date(acquiredAt.getTime() + 1_000).toISOString(),
    };
    await writeFile(
      join(lockRoot, `${lockKey}.lock`),
      `${JSON.stringify(metadata)}\n`,
      'utf8',
    );

    let ran = false;
    await withDecisionTraceLock(root, TRACE_A, async () => {
      ran = true;
    }, { attempts: 2, retryMs: 1, leaseMs: 60_000, clock: () => FIXED_NOW });

    expect(ran).toBe(true);
  });

  it('refuses lock acquisition on real roots without authorization', async () => {
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    try {
      await expect(withDecisionTraceLock(
        resolve(process.cwd(), '.test-decision-trace-real-vault'),
        TRACE_A,
        async () => 'unused',
      )).rejects.toThrow('Vault writes are disabled');
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
  });

  it('admits lock acquisition on real roots with the authorization for that root', async () => {
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    const realRoot = resolve(process.cwd(), '.test-decision-trace-real-vault');
    try {
      await mkdir(realRoot, { recursive: true });
      let observed = false;
      await withDecisionTraceLock(realRoot, TRACE_A, async () => {
        observed = true;
      }, { writeAuthorization: createVaultWriteAuthorization(realRoot) });

      expect(observed).toBe(true);
      await expect(readdir(join(realRoot, '07_System/.atl/decision-locks')))
        .resolves.toEqual([]);
    } finally {
      await rm(realRoot, { recursive: true, force: true });
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
  });

  it('refuses lock acquisition when the authorization token names another root', async () => {
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    const realRoot = resolve(process.cwd(), '.test-decision-trace-real-vault');
    const otherRoot = await mkdtemp(join(tmpdir(), 'atl-trace-lock-other-'));
    try {
      await expect(withDecisionTraceLock(realRoot, TRACE_A, async () => 'unused', {
        writeAuthorization: createVaultWriteAuthorization(otherRoot),
      })).rejects.toThrow('Vault writes are disabled');

      await expect(readdir(join(realRoot, '07_System')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
      await rm(realRoot, { recursive: true, force: true });
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
  });
});
