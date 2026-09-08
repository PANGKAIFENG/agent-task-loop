import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { feedbackSampleSchema } from '../../../src/domain/decision-feedback.js';
import { POLICY_STATUSES, type PolicyStatus } from '../../../src/domain/decision-policy.js';
import { decisionTraceSchema } from '../../../src/domain/decision-trace.js';
import type { StorageReadBoundary } from '../../../src/storage/file-io.js';
import { InvalidFrontmatterError } from '../../../src/storage/frontmatter.js';
import {
  DecisionPolicyConflictError,
  DecisionPolicyInvalidError,
  DecisionPolicyRefUnresolvedError,
  DecisionPolicyTransitionInvalidError,
  DecisionPolicyVersionExistsError,
  DecisionPolicyVersionGapError,
  MarkdownDecisionPolicyRepository,
  type PolicyRef,
} from '../../../src/storage/markdown-decision-policy-repository.js';
import {
  parseDecisionDocument,
  renderFeedbackBody,
  renderPolicyBody,
  renderTraceBody,
  serializeDecisionDocument,
} from '../../../src/storage/decision-document.js';

const tamperBeforeReplace = { enabled: false };

vi.mock('../../../src/storage/file-io.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../../../src/storage/file-io.js');
  return {
    ...actual,
    atomicReplaceSafeTextFile: async (
      targetPath: string,
      expectedContent: string,
      content: string,
      boundary: StorageReadBoundary,
    ): Promise<boolean> => {
      if (tamperBeforeReplace.enabled) {
        tamperBeforeReplace.enabled = false;
        // Simulate a concurrent writer changing the document after the
        // repository read its expected content but before the CAS attempt.
        await actual.atomicWriteTextFile(targetPath, `${expectedContent}\n<!-- concurrent -->\n`);
      }
      return actual.atomicReplaceSafeTextFile(targetPath, expectedContent, content, boundary);
    },
  };
});

const originalVaultRoot = process.env.ATL_VAULT_ROOT;
const originalAllowWrites = process.env.ATL_ALLOW_REAL_WRITES;

afterEach(() => {
  if (originalVaultRoot === undefined) {
    delete process.env.ATL_VAULT_ROOT;
  } else {
    process.env.ATL_VAULT_ROOT = originalVaultRoot;
  }
  if (originalAllowWrites === undefined) {
    delete process.env.ATL_ALLOW_REAL_WRITES;
  } else {
    process.env.ATL_ALLOW_REAL_WRITES = originalAllowWrites;
  }
  tamperBeforeReplace.enabled = false;
});

function makePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_id: 'policy.input-routing.synthetic',
    version: 'v001',
    status: 'observing',
    dimension: 'input-routing',
    decision_question: 'Is a WeChat message information, a candidate, a task, a project or a decision?',
    inputs: [{ name: 'sender identity', source: 'wechat contact profile' }],
    sources: ['synthetic_input', 'PAW-GOAL-002@0.1'],
    rules: [
      { statement: 'Route messages with an explicit commitment to inbox candidates.', priority: 10 },
      { statement: 'Leave messages without a detectable ask in the inbox.', priority: 20 },
    ],
    exceptions: ['Messages from unknown senders stay unreviewed.'],
    outputs: ['inbox', 'candidate', 'project_link', 'clarify_request'],
    rationale: 'First version calibrated by the synthetic loop only.',
    examples: [{ input: 'synthetic message asking for a report', output: 'candidate' }],
    counterexamples: [{ input: 'synthetic chit-chat', output: 'inbox' }],
    metrics: ['trace_coverage', 'user_correction_rate'],
    next_review_at: '2026-08-24',
    created_at: '2026-08-18T06:00:00.000Z',
    ...overrides,
  };
}

function makeTrace(): Record<string, unknown> {
  return {
    trace_id: 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    policy_ref: 'policy.input-routing.synthetic@v001',
    dimension: 'input-routing',
    input_refs: ['msg://synthetic-001'],
    decision: 'candidate',
    reasoning_summary: 'The message contains an explicit commitment to deliver a report.',
    evidence_refs: ['07_System/Rules/Decision_Logic/input-routing/policy.input-routing.synthetic_v001.md'],
    confidence: 'high',
    user_feedback: 'unreviewed',
    final_outcome: 'pending',
    status: 'recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 0,
    latest_feedback_at: null,
    created_at: '2026-08-18T06:00:00.000Z',
    status_history: [],
  };
}

function makeFeedback(): Record<string, unknown> {
  return {
    feedback_id: 'fb_0123456789abcdefghij',
    trace_id: 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'accepted',
    stability: 'single_exception',
    correction_summary: null,
    final_outcome: null,
    created_at: '2026-08-18T07:00:00.000Z',
    source_ref: 'chat://synthetic-session/001',
  };
}

const POLICY_REF = 'policy.input-routing.synthetic@v001';

function policyPath(vaultRoot: string, dimension: string, policyId: string, version: string): string {
  return join(vaultRoot, '07_System', 'Rules', 'Decision_Logic', dimension, `${policyId}_${version}.md`);
}

async function makeVault(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atl-decision-policy-repo-'));
}

async function assertNoTempResidue(directory: string): Promise<void> {
  const entries = await readdir(directory);
  expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
}

describe('markdown decision policy repository', () => {
  describe('create and exact ref lookup', () => {
    it('persists v001 at the governance path and reads it back unchanged', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      const input = makePolicy();

      const created = await repository.create(input);

      expect(created).toEqual({ ...input, status_history: [] });
      const stored = await readFile(
        policyPath(vaultRoot, 'input-routing', 'policy.input-routing.synthetic', 'v001'),
        'utf8',
      );
      expect(stored.startsWith('---\n')).toBe(true);
      expect(parseDecisionDocument(stored).data.policy_id).toBe('policy.input-routing.synthetic');

      expect(await repository.get(POLICY_REF)).toEqual(created);
    });

    it('trusts frontmatter only: body edits never affect read-back', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      const created = await repository.create(makePolicy());

      const path = policyPath(vaultRoot, 'input-routing', 'policy.input-routing.synthetic', 'v001');
      const document = parseDecisionDocument(await readFile(path, 'utf8'));
      await writeFile(
        path,
        serializeDecisionDocument(document.data, '\n# hand-edited body\n\nHuman notes only.\n'),
        'utf8',
      );

      expect(await repository.get(POLICY_REF)).toEqual(created);
    });

    it('rejects schema-invalid input without writing any file', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);

      await expect(repository.create(makePolicy({ surprise: true }))).rejects
        .toBeInstanceOf(DecisionPolicyInvalidError);
      await expect(repository.create(makePolicy({ policy_id: 'policy.bad/../evil' })))
        .rejects.toMatchObject({ code: 'decision_policy_invalid' });
      await expect(repository.create(makePolicy({ version: 'v1' }))).rejects
        .toMatchObject({ code: 'decision_policy_invalid' });

      await expect(repository.get('policy.bad/../evil@v001')).rejects
        .toMatchObject({ code: 'decision_policy_invalid' });
      expect(await repository.list()).toEqual([]);
      const logicEntries = await readdir(
        join(vaultRoot, '07_System', 'Rules', 'Decision_Logic'),
      ).catch(() => []);
      expect(logicEntries).toEqual([]);
    });

    it('returns null for an unresolved ref and rejects malformed refs', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());

      expect(await repository.get('policy.input-routing.synthetic@v002')).toBe(null);
      expect(await repository.get('policy.unknown.dimension@v001')).toBe(null);
      await expect(repository.get('no-at-sign' as PolicyRef)).rejects.toMatchObject({
        code: 'decision_policy_invalid',
      });
      await expect(repository.get('policy.x@v0001')).rejects.toMatchObject({
        code: 'decision_policy_invalid',
      });
    });

    it('skips foreign and legacy-shaped files instead of projecting them', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());

      const legacyPath = policyPath(
        vaultRoot,
        'attention-priority',
        'policy.attention-priority.synthetic',
        'v001',
      );
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, `---
type: decision_policy
policy_id: policy.attention-priority.synthetic
version: v001
status: observing
dimension: attention-priority
decision_question: legacy harness shorthand
sources:
  - synthetic_input
next_review_at: 2026-08-24
---

# legacy document
`, 'utf8');

      expect(await repository.list()).toHaveLength(1);
      expect(await repository.get('policy.attention-priority.synthetic@v001')).toBe(null);
      expect(await repository.listVersions('policy.attention-priority.synthetic')).toEqual([]);
    });
  });

  describe('version chain', () => {
    it('rejects creating the same version twice', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());

      await expect(repository.create(makePolicy())).rejects
        .toBeInstanceOf(DecisionPolicyVersionExistsError);
      await expect(repository.create(makePolicy())).rejects
        .toMatchObject({ code: 'decision_policy_version_exists' });

      await assertNoTempResidue(join(vaultRoot, '07_System', 'Rules', 'Decision_Logic', 'input-routing'));
    });

    it('rejects v002 when v001 is missing (no holes in the chain)', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);

      await expect(repository.create(makePolicy({ version: 'v002' }))).rejects
        .toBeInstanceOf(DecisionPolicyVersionGapError);
      await expect(repository.create(makePolicy({ version: 'v003' }))).rejects
        .toMatchObject({ code: 'decision_policy_version_gap' });

      expect(await repository.list()).toEqual([]);
    });

    it('rejects versions that skip the next slot', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());

      await expect(repository.create(makePolicy({ version: 'v003' }))).rejects
        .toMatchObject({ code: 'decision_policy_version_gap' });
      await repository.create(makePolicy({ version: 'v002' }));
      await repository.create(makePolicy({ version: 'v003' }));

      const versions = (await repository.listVersions('policy.input-routing.synthetic'))
        .map((policy) => policy.version);
      expect(versions).toEqual(['v001', 'v002', 'v003']);
    });

    it('rolls back by copying old content into a new draft version, keeping old refs readable', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      const v001 = await repository.create(makePolicy({ status: 'active' }));
      await repository.create(makePolicy({
        version: 'v002',
        status: 'deprecated',
        rationale: 'Second version mis-calibrated.',
      }));

      const rollback = await repository.create(makePolicy({
        version: 'v003',
        status: 'draft',
        rationale: v001.rationale,
        created_at: '2026-08-18T08:00:00.000Z',
      }));

      expect(rollback.status).toBe('draft');
      expect(rollback.rationale).toBe(v001.rationale);
      expect(rollback.decision_question).toBe(v001.decision_question);
      expect(await repository.get(POLICY_REF)).toEqual(v001);
      expect((await repository.get('policy.input-routing.synthetic@v002'))?.status).toBe('deprecated');
      expect((await repository.get('policy.input-routing.synthetic@v003'))?.status).toBe('draft');
    });
  });

  describe('status transitions', () => {
    const legal: [PolicyStatus, PolicyStatus][] = [
      ['draft', 'observing'],
      ['draft', 'deprecated'],
      ['observing', 'active'],
      ['observing', 'deprecated'],
      ['active', 'deprecated'],
    ];
    const all: [PolicyStatus, PolicyStatus][] = [];
    for (const from of POLICY_STATUSES) {
      for (const to of POLICY_STATUSES) {
        all.push([from, to]);
      }
    }
    const illegal = all.filter(([from, to]) => !legal.some(([f, t]) => f === from && t === to));

    async function createAtStatus(
      repository: MarkdownDecisionPolicyRepository,
      status: PolicyStatus,
    ): Promise<void> {
      await repository.create(makePolicy({
        status,
        status_history: [{ status, at: '2026-08-18T06:00:00.000Z' }],
      }));
    }

    it.each(legal)('allows %s -> %s', async (from, to) => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await createAtStatus(repository, from);

      const updated = await repository.updateStatus(POLICY_REF, to);

      expect(updated.status).toBe(to);
      expect(updated.status_history).toHaveLength(2);
      expect(updated.status_history[0]).toEqual({ status: from, at: '2026-08-18T06:00:00.000Z' });
      expect(updated.status_history[1]?.status).toBe(to);
      expect(Date.parse(updated.status_history[1]?.at ?? '')).not.toBeNaN();
      expect(await repository.get(POLICY_REF)).toEqual(updated);
    });

    it.each(illegal)('rejects %s -> %s', async (from, to) => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await createAtStatus(repository, from);
      const created = await repository.get(POLICY_REF);

      await expect(repository.updateStatus(POLICY_REF, to)).rejects
        .toBeInstanceOf(DecisionPolicyTransitionInvalidError);
      await expect(repository.updateStatus(POLICY_REF, to)).rejects
        .toMatchObject({ code: 'decision_policy_transition_invalid' });
      expect(await repository.get(POLICY_REF)).toEqual(created);
    });

    it('explicitly forbids deprecated -> active (rollback goes through a new version)', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await createAtStatus(repository, 'deprecated');

      await expect(repository.updateStatus(POLICY_REF, 'active')).rejects
        .toMatchObject({ code: 'decision_policy_transition_invalid' });
    });

    it('changes only status and status_history on a successful update', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      const created = await repository.create(makePolicy({ status: 'observing' }));

      const updated = await repository.updateStatus(POLICY_REF, 'active');

      const before: Record<string, unknown> = { ...created };
      const after: Record<string, unknown> = { ...updated };
      delete before.status;
      delete before.status_history;
      delete after.status;
      delete after.status_history;
      expect(after).toEqual(before);
    });

    it('reports an unresolved ref when updating a missing policy', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);

      await expect(repository.updateStatus(POLICY_REF, 'active')).rejects
        .toBeInstanceOf(DecisionPolicyRefUnresolvedError);
    });

    it('surfaces a CAS conflict when the document changes concurrently', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy({ status: 'observing' }));

      tamperBeforeReplace.enabled = true;
      let conflict: unknown;
      try {
        await repository.updateStatus(POLICY_REF, 'active');
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(DecisionPolicyConflictError);
      expect((conflict as DecisionPolicyConflictError).code).toBe('decision_policy_conflict');

      const path = policyPath(vaultRoot, 'input-routing', 'policy.input-routing.synthetic', 'v001');
      const raw = await readFile(path, 'utf8');
      expect(raw).toContain('<!-- concurrent -->');
      expect(parseDecisionDocument(raw).data.status).toBe('observing');
      await assertNoTempResidue(dirname(path));

      // A retry that re-reads current content still succeeds.
      const retried = await repository.updateStatus(POLICY_REF, 'active');
      expect(retried.status).toBe('active');
      expect(parseDecisionDocument(await readFile(path, 'utf8')).data.status).toBe('active');
    });
  });

  describe('list and version ordering', () => {
    it('orders list by policy_id then version and applies filters', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy({
        policy_id: 'policy.result-acceptance.synthetic',
        dimension: 'result-acceptance',
        status: 'active',
      }));
      await repository.create(makePolicy({
        policy_id: 'policy.attention-priority.synthetic',
        dimension: 'attention-priority',
        status: 'draft',
      }));
      await repository.create(makePolicy());
      await repository.create(makePolicy({ version: 'v002', status: 'active' }));

      const all = await repository.list();
      expect(all.map((policy) => `${policy.policy_id}@${policy.version}`)).toEqual([
        'policy.attention-priority.synthetic@v001',
        'policy.input-routing.synthetic@v001',
        'policy.input-routing.synthetic@v002',
        'policy.result-acceptance.synthetic@v001',
      ]);

      expect((await repository.list({ dimension: 'input-routing' })).map((p) => p.version))
        .toEqual(['v001', 'v002']);
      expect((await repository.list({ status: 'active' })).map((p) => p.policy_id)).toEqual([
        'policy.input-routing.synthetic',
        'policy.result-acceptance.synthetic',
      ]);
      expect(await repository.list({ dimension: 'session-return' })).toEqual([]);
    });

    it('returns versions ascending and nothing for unknown policies', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());
      await repository.create(makePolicy({ version: 'v002', status: 'active' }));
      await repository.create(makePolicy({ version: 'v003', status: 'active' }));

      const versions = (await repository.listVersions('policy.input-routing.synthetic'))
        .map((policy) => policy.version);
      expect(versions).toEqual(['v001', 'v002', 'v003']);
      expect(await repository.listVersions('policy.never.created')).toEqual([]);
      await expect(repository.listVersions('../escape')).rejects
        .toMatchObject({ code: 'decision_policy_invalid' });
    });
  });

  describe('vault safety', () => {
    it('refuses writes to a real (non-temp) root without authorization', async () => {
      delete process.env.ATL_VAULT_ROOT;
      delete process.env.ATL_ALLOW_REAL_WRITES;
      const vaultRoot = resolve(process.cwd(), '.atl-policy-repo-real-root-probe');
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);

      await expect(repository.create(makePolicy())).rejects.toThrow('Vault writes are disabled');
      await expect(repository.updateStatus(POLICY_REF, 'active'))
        .rejects.toThrow('Vault writes are disabled');
    });

    it('refuses to create through a symlinked dimension directory', async () => {
      const vaultRoot = await makeVault();
      const outsideTarget = join(vaultRoot, 'outside-target');
      const logicRoot = join(vaultRoot, '07_System', 'Rules', 'Decision_Logic');
      await mkdir(outsideTarget, { recursive: true });
      await mkdir(logicRoot, { recursive: true });
      await symlink(outsideTarget, join(logicRoot, 'input-routing'));

      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await expect(repository.create(makePolicy())).rejects.toThrow();

      expect(await readdir(outsideTarget)).toEqual([]);
      await assertNoTempResidue(logicRoot);
    });

    it('returns null when the canonical path is a symlink to outside content', async () => {
      const vaultRoot = await makeVault();
      const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
      await repository.create(makePolicy());

      const decoyPath = join(vaultRoot, 'decoy-outside.md');
      await writeFile(
        decoyPath,
        serializeDecisionDocument(makePolicy({
          policy_id: 'policy.attention-priority.synthetic',
          dimension: 'attention-priority',
        }), '\n# decoy\n'),
        'utf8',
      );
      await symlink(decoyPath, policyPath(
        vaultRoot,
        'input-routing',
        'policy.input-routing.synthetic',
        'v002',
      ));

      expect(await repository.get('policy.input-routing.synthetic@v002')).toBe(null);
      expect((await repository.list()).map((policy) => policy.version)).toEqual(['v001']);
    });
  });
});

describe('decision document', () => {
  it('round-trips frontmatter values through serialize and parse', () => {
    const frontmatter = makePolicy({ status_history: [] });
    const raw = serializeDecisionDocument(frontmatter, '\n# body\n');

    expect(raw.startsWith('---\n')).toBe(true);
    const parsed = parseDecisionDocument(raw);
    expect(parsed.data).toEqual(frontmatter);
    expect(parsed.body).toBe('\n# body\n');
  });

  it('rejects documents without frontmatter', () => {
    expect(() => parseDecisionDocument('plain markdown')).toThrow(InvalidFrontmatterError);
  });

  it('renders policy bodies deterministically from frontmatter', async () => {
    const vaultRoot = await makeVault();
    const repository = new MarkdownDecisionPolicyRepository(vaultRoot);
    const policy = await repository.create(makePolicy());

    const first = renderPolicyBody(policy);
    expect(renderPolicyBody(policy)).toBe(first);
    expect(first).toContain('# policy.input-routing.synthetic@v001');
    expect(first).toContain(policy.decision_question);

    const deprecated = await repository.create(makePolicy({
      policy_id: 'policy.attention-priority.synthetic',
      dimension: 'attention-priority',
      status: 'deprecated',
      status_history: [{ status: 'deprecated', at: '2026-08-18T06:00:00.000Z' }],
    }));
    expect(renderPolicyBody(deprecated)).not.toBe(first);
  });

  it('renders trace and feedback bodies as frontmatter projections', () => {
    const traceBody = renderTraceBody(decisionTraceSchema.parse(makeTrace()));
    expect(traceBody).toContain('dt_01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(traceBody).toContain('policy.input-routing.synthetic@v001');
    expect(traceBody).toContain('not hidden chain-of-thought or source transcripts');

    const sample = feedbackSampleSchema.parse(makeFeedback());
    const feedbackBody = renderFeedbackBody(sample);
    expect(feedbackBody).toContain(sample.feedback_id);
    expect(feedbackBody).toContain(sample.kind);
  });
});
