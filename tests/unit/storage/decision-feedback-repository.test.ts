import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deterministicFeedbackId,
  type FeedbackSample,
} from '../../../src/domain/decision-feedback.js';
import { parseTaskDocument, serializeTaskDocument } from '../../../src/storage/frontmatter.js';
import {
  MarkdownDecisionFeedbackRepository,
} from '../../../src/storage/markdown-decision-feedback-repository.js';

const TRACE_A = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const TRACE_B = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5';
const IDEMPOTENCY_KEY = 'paw002-correction-0001';
const POLICY_REF = 'policy.input-routing.synthetic@v001';

function sampleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return {
    feedback_id: deterministicFeedbackId(TRACE_A, IDEMPOTENCY_KEY),
    trace_id: TRACE_A,
    kind: 'corrected',
    stability: 'single_exception',
    correction_summary: 'Route to triage only after source confirmation',
    final_outcome: 'task-rerouted',
    created_at: '2026-08-18T11:00:00.000Z',
    source_ref: 'chat://user-correction-1',
    idempotency_key: IDEMPOTENCY_KEY,
    policy_ref: POLICY_REF,
    ...defined,
  };
}

function omitKeys(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !keys.includes(key)),
  );
}

function expectedSample(input: Record<string, unknown>): FeedbackSample {
  return {
    feedback_id: input.feedback_id,
    trace_id: input.trace_id,
    kind: input.kind,
    stability: input.stability,
    correction_summary: input.correction_summary ?? null,
    final_outcome: input.final_outcome ?? null,
    created_at: input.created_at,
    source_ref: input.source_ref,
    ...(input.idempotency_key === undefined ? {} : { idempotency_key: input.idempotency_key }),
    ...(input.policy_ref === undefined ? {} : { policy_ref: input.policy_ref }),
  } as FeedbackSample;
}

function feedbackPath(root: string, input: Record<string, unknown>): string {
  const year = String(input.created_at).slice(0, 4);
  const month = String(input.created_at).slice(5, 7);
  return join(root, '07_System/Logs/Decision_Feedback', year, month, `${input.feedback_id}.md`);
}

const roots: string[] = [];

async function vaultRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-decision-feedback-'));
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MarkdownDecisionFeedbackRepository.createOrGet', () => {
  it('persists an immutable sample at the governance path and reads it back', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    const input = sampleInput();

    const result = await repository.createOrGet(input);

    expect(result.created).toBe(true);
    expect(result.sample).toEqual(expectedSample(input));
    expect(await listVaultFiles(root)).toEqual([
      `07_System/Logs/Decision_Feedback/2026/08/${input.feedback_id}.md`,
    ]);

    const raw = await readFile(feedbackPath(root, input), 'utf8');
    const document = parseTaskDocument(raw);
    expect(document.data).toMatchObject({
      feedback_id: input.feedback_id,
      trace_id: TRACE_A,
      kind: 'corrected',
      idempotency_key: IDEMPOTENCY_KEY,
    });
    // Frontmatter is the only truth source; the body is a human projection.
    expect(raw).toContain(`# ${input.feedback_id}`);
    expect(raw).toContain('immutable feedback fact');
  });

  it('replays the same deterministic sample as created:false without touching bytes', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    const input = sampleInput();

    const first = await repository.createOrGet(input);
    const rawBefore = await readFile(feedbackPath(root, input), 'utf8');

    const second = await repository.createOrGet(sampleInput());

    expect(second.created).toBe(false);
    expect(second.sample).toEqual(first.sample);
    expect(await readFile(feedbackPath(root, input), 'utf8')).toBe(rawBefore);
    expect(await listVaultFiles(root)).toEqual([
      `07_System/Logs/Decision_Feedback/2026/08/${input.feedback_id}.md`,
    ]);
  });

  it('keeps ULID samples distinct when no idempotency key is given', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);

    const first = await repository.createOrGet(omitKeys(sampleInput({
      feedback_id: 'fb_01J9Z8W7Q3V5X2M4N6P8R0T2VX',
      kind: 'accepted',
      correction_summary: null,
    }), ['idempotency_key']));
    const second = await repository.createOrGet(omitKeys(sampleInput({
      feedback_id: 'fb_01J9Z8W7Q3V5X2M4N6P8R0T2VY',
      kind: 'accepted',
      correction_summary: null,
    }), ['idempotency_key']));

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.sample.feedback_id).not.toBe(second.sample.feedback_id);
    expect((await repository.listByTrace(TRACE_A)).length).toBe(2);
  });

  it('rejects a duplicate id that squats a different sample', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    await repository.createOrGet(sampleInput());

    await expect(repository.createOrGet(sampleInput({ kind: 'accepted' })))
      .rejects.toMatchObject({ code: 'decision_feedback_duplicate_conflict' });
    await expect(repository.createOrGet(sampleInput({ idempotency_key: 'paw002-other-key-0002' })))
      .rejects.toMatchObject({ code: 'decision_feedback_duplicate_conflict' });
    await expect(repository.createOrGet(sampleInput({ trace_id: TRACE_B })))
      .rejects.toMatchObject({ code: 'decision_feedback_duplicate_conflict' });
  });

  it('reports a conflict when the taken id is not a readable sample', async () => {
    const root = await vaultRoot();
    const input = sampleInput();
    const monthDirectory = join(root, '07_System/Logs/Decision_Feedback/2026/08');
    await mkdir(monthDirectory, { recursive: true });
    await writeFile(join(monthDirectory, `${input.feedback_id}.md`), 'not a decision document', 'utf8');
    const repository = new MarkdownDecisionFeedbackRepository(root);

    await expect(repository.createOrGet(input))
      .rejects.toMatchObject({ code: 'decision_feedback_duplicate_conflict' });
  });

  it('rejects invalid samples without leaving residue', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);

    const invalidInputs: Record<string, unknown>[] = [
      sampleInput({ feedback_id: 'fb_nonsense' }),
      sampleInput({ feedback_id: 'plain-text' }),
      sampleInput({ kind: 'unreviewed' }),
      omitKeys(sampleInput({ kind: 'corrected' }), ['correction_summary']),
      sampleInput({ correction_summary: null, kind: 'corrected' }),
      sampleInput({ created_at: '2026-13-40T00:00:00.000Z' }),
      sampleInput({ source_ref: '' }),
      sampleInput({ stability: 'sometimes' }),
      sampleInput({ idempotency_key: 'short' }),
      sampleInput({ extra_field: 'unknown' }),
      { ...sampleInput(), trace_id: 'trace-legacy-001' },
    ];
    for (const invalid of invalidInputs) {
      await expect(repository.createOrGet(invalid))
        .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    }

    expect(await listVaultFiles(root)).toEqual([]);
  });

  it('never follows or clobbers a symlinked sample path', async () => {
    const root = await vaultRoot();
    const input = sampleInput();
    const outsidePath = join(root, 'outside-target.md');
    await writeFile(outsidePath, 'outside content', 'utf8');
    const monthDirectory = join(root, '07_System/Logs/Decision_Feedback/2026/08');
    await mkdir(monthDirectory, { recursive: true });
    await symlink(outsidePath, join(monthDirectory, `${input.feedback_id}.md`));
    const repository = new MarkdownDecisionFeedbackRepository(root);

    await expect(repository.createOrGet(input))
      .rejects.toMatchObject({ code: 'decision_feedback_duplicate_conflict' });
    expect(await readFile(outsidePath, 'utf8')).toBe('outside content');
  });

  it('refuses real-root writes without an explicit authorization', async () => {
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    try {
      const realRoot = resolve(process.cwd(), '.test-decision-feedback-real-vault');
      const repository = new MarkdownDecisionFeedbackRepository(realRoot);

      await expect(repository.createOrGet(sampleInput()))
        .rejects.toThrow('Vault writes are disabled');
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

describe('MarkdownDecisionFeedbackRepository.listByTrace', () => {
  it('returns only the trace samples in deterministic order', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    const early = sampleInput({ created_at: '2026-08-18T09:00:00.000Z' });
    const late = sampleInput({
      feedback_id: 'fb_00000000000000000002',
      idempotency_key: 'paw002-second-key-0002',
      created_at: '2026-08-18T11:30:00.000Z',
    });
    const other = sampleInput({
      feedback_id: 'fb_00000000000000000003',
      trace_id: TRACE_B,
      idempotency_key: 'paw002-third-key-0003',
      created_at: '2026-08-18T10:00:00.000Z',
    });
    await repository.createOrGet(late);
    await repository.createOrGet(other);
    await repository.createOrGet(early);

    const samples = await repository.listByTrace(TRACE_A);

    expect(samples.map((sample) => sample.feedback_id)).toEqual([
      early.feedback_id,
      late.feedback_id,
    ]);
  });

  it('sorts same-timestamp samples by feedback id', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    const first = sampleInput({ feedback_id: 'fb_00000000000000000001' });
    const second = sampleInput({
      feedback_id: 'fb_00000000000000000002',
      idempotency_key: 'paw002-second-key-0002',
    });
    await repository.createOrGet(second);
    await repository.createOrGet(first);

    expect((await repository.listByTrace(TRACE_A)).map((s) => s.feedback_id))
      .toEqual([first.feedback_id, second.feedback_id]);
  });

  it('rejects non-native trace ids', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);

    await expect(repository.listByTrace('trace-legacy-001'))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
  });
});

describe('MarkdownDecisionFeedbackRepository.listForAggregation', () => {
  async function seedSamples(root: string): Promise<MarkdownDecisionFeedbackRepository> {
    const repository = new MarkdownDecisionFeedbackRepository(root);
    await repository.createOrGet(sampleInput({
      kind: 'corrected',
      stability: 'single_exception',
      created_at: '2026-08-10T09:00:00.000Z',
    }));
    await repository.createOrGet(sampleInput({
      feedback_id: 'fb_00000000000000000002',
      idempotency_key: 'paw002-second-key-0002',
      kind: 'accepted',
      stability: 'confirmed_pattern',
      created_at: '2026-08-15T09:00:00.000Z',
    }));
    await repository.createOrGet(omitKeys(sampleInput({
      feedback_id: 'fb_00000000000000000004',
      idempotency_key: 'paw002-third-key-0003',
      kind: 'deferred',
      stability: 'unknown',
      created_at: '2026-08-20T09:00:00.000Z',
    }), ['policy_ref']));
    return repository;
  }

  it('filters by kind, stability and inclusive created_at bounds', async () => {
    const root = await vaultRoot();
    const repository = await seedSamples(root);

    expect((await repository.listForAggregation({ kind: 'corrected' })).length).toBe(1);
    expect((await repository.listForAggregation({ stability: 'confirmed_pattern' })).length).toBe(1);
    expect((await repository.listForAggregation({ from: '2026-08-12T00:00:00.000Z' })).length).toBe(2);
    expect((await repository.listForAggregation({ to: '2026-08-15T09:00:00.000Z' })).length).toBe(2);
    expect((await repository.listForAggregation({
      from: '2026-08-12T00:00:00.000Z',
      to: '2026-08-19T23:59:59.999Z',
    })).length).toBe(1);
    expect((await repository.listForAggregation()).length).toBe(3);
  });

  it('filters by dimension through the injected policy dimension resolver', async () => {
    const root = await vaultRoot();
    const resolverCalls: string[] = [];
    const repository = new MarkdownDecisionFeedbackRepository(root, {
      resolvePolicyDimension: async (ref) => {
        resolverCalls.push(ref);
        return ref === POLICY_REF ? 'input-routing' : null;
      },
    });
    await seedSamples(root);

    const matched = await repository.listForAggregation({ dimension: 'input-routing' });
    expect(matched.length).toBe(2);
    expect(matched.every((sample) => sample.kind !== 'deferred')).toBe(true);

    const none = await repository.listForAggregation({ dimension: 'goal-decomposition' });
    expect(none).toEqual([]);
  });

  it('rejects invalid filters and dimension filters without a resolver', async () => {
    const root = await vaultRoot();
    const repository = await seedSamples(root);

    await expect(repository.listForAggregation({ kind: 'unreviewed' as never }))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    await expect(repository.listForAggregation({ stability: 'sometimes' as never }))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    await expect(repository.listForAggregation({ dimension: 'no-such-dimension' as never }))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    await expect(repository.listForAggregation({ from: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
    await expect(repository.listForAggregation({ to: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'decision_feedback_invalid' });
  });

  it('skips foreign files inside the feedback tree', async () => {
    const root = await vaultRoot();
    const repository = await seedSamples(root);
    const monthDirectory = join(root, '07_System/Logs/Decision_Feedback/2026/08');
    await writeFile(join(monthDirectory, 'notes.md'), 'a foreign note', 'utf8');

    expect((await repository.listForAggregation()).length).toBe(3);
  });
});

describe('sample document serialization', () => {
  it('round-trips optional fields without null drift', async () => {
    const root = await vaultRoot();
    const repository = new MarkdownDecisionFeedbackRepository(root);
    const input = omitKeys(sampleInput({
      kind: 'accepted',
      correction_summary: null,
    }), ['idempotency_key', 'policy_ref']);

    const { sample } = await repository.createOrGet(input);
    expect(sample.idempotency_key).toBeUndefined();
    expect(sample.policy_ref).toBeUndefined();
    expect(sample.correction_summary).toBeNull();

    const raw = await readFile(feedbackPath(root, input), 'utf8');
    const document = parseTaskDocument(raw);
    expect(document.data.idempotency_key).toBeUndefined();
    expect(document.data.policy_ref).toBeUndefined();
    expect(document.data.correction_summary).toBeNull();

    // Byte-stable re-serialization: same frontmatter renders same bytes.
    const reserialized = serializeTaskDocument(document.data, document.body);
    expect(reserialized).toBe(raw);
  });
});
