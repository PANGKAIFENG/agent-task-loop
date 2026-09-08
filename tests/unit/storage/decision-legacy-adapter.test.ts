import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import {
  LEGACY_CREATED_AT_SENTINEL,
  deriveLegacyTraceNativeId,
  parseLegacyPolicyDocument,
  parseLegacyTraceDocument,
  scanDecisionTrees,
} from '../../../src/storage/decision-legacy-adapter.js';
import { MarkdownDecisionPolicyRepository } from '../../../src/storage/markdown-decision-policy-repository.js';
import { MarkdownDecisionTraceRepository } from '../../../src/storage/markdown-decision-trace-repository.js';

const FIXTURE_DIR = join('tests', 'fixtures', 'vault', 'decision-legacy');
const LEGACY_TRACE_ID = 'trace-legacy-demo-feedback-001';
const LEGACY_MISSING_TRACE_ID = 'trace-legacy-demo-missing-001';
const LEGACY_POLICY_ID = 'policy.input-routing.legacy-demo';
const NATIVE_TRACE_ID = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';

const policy: DecisionPolicy = {
  policy_id: 'policy.input-routing.native-demo',
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

function legacyTraceData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'decision_trace',
    trace_id: LEGACY_TRACE_ID,
    policy_ref: `${LEGACY_POLICY_ID}@v001`,
    dimension: 'input-routing',
    input_refs: ['goal:PAW-GOAL-002@0.2'],
    decision: 'candidate_inbox',
    reasoning_summary: 'Traceable synthetic source; execution stays unauthorized.',
    evidence_refs: ['source_key:goal:PAW-GOAL-002@0.2'],
    confidence: 'high',
    user_feedback: 'corrected',
    final_outcome: 'corrected_after_review',
    created_at: '2026-08-17T09:30:00.000Z',
    ...overrides,
  };
}

function legacyPolicyData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'decision_policy',
    policy_id: LEGACY_POLICY_ID,
    version: 'v001',
    status: 'observing',
    dimension: 'input-routing',
    decision_question: 'Should this legacy synthetic input become a work item?',
    sources: ['synthetic_input'],
    next_review_at: '2026-08-24',
    ...overrides,
  };
}

async function fixtureBytes(name: string): Promise<string> {
  return readFile(join(process.cwd(), FIXTURE_DIR, name), 'utf8');
}

async function installLegacyFixtures(vault: string): Promise<void> {
  const traceDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
  const policyDirectory = join(vault, '07_System', 'Rules', 'Decision_Logic', 'input-routing');
  await mkdir(traceDirectory, { recursive: true });
  await mkdir(policyDirectory, { recursive: true });
  await writeFile(join(policyDirectory, `${LEGACY_POLICY_ID}_v001.md`), await fixtureBytes('policy-v001.md'));
  await writeFile(join(traceDirectory, `${LEGACY_TRACE_ID}.md`), await fixtureBytes('trace-with-feedback.md'));
  await writeFile(join(traceDirectory, `${LEGACY_MISSING_TRACE_ID}.md`), await fixtureBytes('trace-missing-fields.md'));
  await writeFile(join(traceDirectory, 'corrupt.md'), await fixtureBytes('corrupt.md'));
}

async function sha256Tree(vault: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        hashes.set(relative(vault, path), createHash('sha256').update(await readFile(path)).digest('hex'));
      }
    }
  };
  await walk(vault);
  return hashes;
}

describe('decision legacy adapter', () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'atl-decision-legacy-adapter-'));
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  describe('deriveLegacyTraceNativeId', () => {
    it('derives a deterministic migration-shaped native id', () => {
      const derived = deriveLegacyTraceNativeId(LEGACY_TRACE_ID);
      expect(derived).toBe(`dt_${createHash('sha256').update(LEGACY_TRACE_ID).digest('hex').slice(0, 20)}`);
      expect(derived).toMatch(/^dt_[0-9a-z]{20}$/u);
      expect(deriveLegacyTraceNativeId(LEGACY_TRACE_ID)).toBe(derived);
      expect(deriveLegacyTraceNativeId(LEGACY_MISSING_TRACE_ID)).not.toBe(derived);
    });
  });

  describe('parseLegacyTraceDocument', () => {
    it('projects a full legacy trace document', () => {
      const projection = parseLegacyTraceDocument(legacyTraceData());
      expect(projection).not.toBeNull();
      expect(projection?.legacy_id).toBe(LEGACY_TRACE_ID);
      expect(projection?.native_id).toBe(deriveLegacyTraceNativeId(LEGACY_TRACE_ID));
      expect(projection?.policy_ref).toBe(`${LEGACY_POLICY_ID}@v001`);
      expect(projection?.dimension).toBe('input-routing');
      expect(projection?.input_refs).toEqual(['goal:PAW-GOAL-002@0.2']);
      expect(projection?.decision).toBe('candidate_inbox');
      expect(projection?.confidence).toBe('high');
      expect(projection?.user_feedback).toBe('corrected');
      expect(projection?.final_outcome).toBe('corrected_after_review');
      expect(projection?.created_at).toBe('2026-08-17T09:30:00.000Z');
    });

    it('maps the legacy `none` feedback value to `unreviewed`', () => {
      const projection = parseLegacyTraceDocument(legacyTraceData({ user_feedback: 'none' }));
      expect(projection?.user_feedback).toBe('unreviewed');
    });

    it('defaults missing optional fields without fabricating input_refs or confidence', () => {
      const projection = parseLegacyTraceDocument(legacyTraceData({
        input_refs: undefined,
        confidence: undefined,
        evidence_refs: undefined,
        reasoning_summary: undefined,
        user_feedback: undefined,
        final_outcome: undefined,
        created_at: undefined,
      }));
      expect(projection?.input_refs).toBeNull();
      expect(projection?.confidence).toBeNull();
      expect(projection?.evidence_refs).toEqual([]);
      expect(projection?.reasoning_summary).toBe('');
      expect(projection?.user_feedback).toBe('unreviewed');
      expect(projection?.final_outcome).toBe('pending');
      expect(projection?.created_at).toBe(LEGACY_CREATED_AT_SENTINEL);
    });

    it('falls back to the sentinel when created_at is present but unparseable', () => {
      const projection = parseLegacyTraceDocument(legacyTraceData({ created_at: 'yesterday' }));
      expect(projection?.created_at).toBe(LEGACY_CREATED_AT_SENTINEL);
    });

    it('treats an empty input_refs list as missing', () => {
      const projection = parseLegacyTraceDocument(legacyTraceData({ input_refs: [] }));
      expect(projection?.input_refs).toBeNull();
    });

    it('rejects documents that are not identifiable legacy traces', () => {
      expect(parseLegacyTraceDocument(legacyTraceData({ type: undefined }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ type: 'decision_policy' }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ trace_id: undefined }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ policy_ref: 'policy.input-routing@1' }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ policy_ref: undefined }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ dimension: 'misc' }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ decision: '' }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ user_feedback: 'maybe' }))).toBeNull();
      expect(parseLegacyTraceDocument(legacyTraceData({ confidence: 'certain' }))).toBeNull();
      expect(parseLegacyTraceDocument('not-an-object' as unknown as Record<string, unknown>)).toBeNull();
    });
  });

  describe('parseLegacyPolicyDocument', () => {
    it('projects a legacy policy document', () => {
      const projection = parseLegacyPolicyDocument(legacyPolicyData());
      expect(projection?.policy_id).toBe(LEGACY_POLICY_ID);
      expect(projection?.version).toBe('v001');
      expect(projection?.status).toBe('observing');
      expect(projection?.dimension).toBe('input-routing');
      expect(projection?.decision_question).toBe('Should this legacy synthetic input become a work item?');
      expect(projection?.sources).toEqual(['synthetic_input']);
      expect(projection?.next_review_at).toBe('2026-08-24');
    });

    it('rejects legacy policies without a frozen status, dimension or identity', () => {
      expect(parseLegacyPolicyDocument(legacyPolicyData({ type: undefined }))).toBeNull();
      expect(parseLegacyPolicyDocument(legacyPolicyData({ status: undefined }))).toBeNull();
      expect(parseLegacyPolicyDocument(legacyPolicyData({ status: 'retired' }))).toBeNull();
      expect(parseLegacyPolicyDocument(legacyPolicyData({ dimension: 'misc' }))).toBeNull();
      expect(parseLegacyPolicyDocument(legacyPolicyData({ policy_id: undefined }))).toBeNull();
      expect(parseLegacyPolicyDocument(legacyPolicyData({ version: '1' }))).toBeNull();
    });
  });

  describe('scanDecisionTrees', () => {
    it('classifies native and legacy documents by format and reports unparseable files', async () => {
      const policyRepository = new MarkdownDecisionPolicyRepository(vault);
      await policyRepository.create(policy);
      const traceRepository = new MarkdownDecisionTraceRepository(vault);
      await traceRepository.create({
        trace_id: NATIVE_TRACE_ID,
        policy_ref: `${policy.policy_id}@v001`,
        dimension: 'input-routing',
        input_refs: ['inbox://item-1'],
        decision: 'Route inbox item to the triage queue',
        reasoning_summary: 'Source declared inbox.',
        evidence_refs: ['receipt://verify-v0.2-loop'],
        confidence: 'high',
        created_at: '2026-08-18T10:00:00.000Z',
      }, { policyResolver: (ref: string) => policyRepository.get(ref as `${string}@${string}`) });
      // Native-shaped but schema-invalid (empty input_refs) => broken native.
      const traceDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
      await writeFile(join(traceDirectory, 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5.md'), [
        '---',
        `trace_id: ${'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5'}`,
        `policy_ref: ${policy.policy_id}@v001`,
        'dimension: input-routing',
        'input_refs: []',
        'decision: Broken on purpose',
        'reasoning_summary: Schema-invalid native document.',
        'evidence_refs:',
        '  - receipt://broken',
        'confidence: high',
        'status: recorded',
        'feedback_summary_status: fresh',
        'feedback_count: 0',
        'latest_feedback_at: null',
        'created_at: 2026-08-18T08:30:00.000Z',
        'status_history: []',
        '---',
        '',
        '# broken native document',
        '',
      ].join('\n'), 'utf8');
      await installLegacyFixtures(vault);

      const scan = await scanDecisionTrees(vault);

      expect(scan.policies.map((entry) => entry.source).sort()).toEqual(['legacy', 'native']);
      expect(scan.traces.map((entry) => entry.source).sort()).toEqual(
        ['legacy', 'legacy', 'native', 'native_broken'],
      );
      const broken = scan.traces.filter((entry) => entry.source === 'native_broken');
      expect(broken).toHaveLength(1);
      if (broken[0]?.source === 'native_broken') {
        expect(broken[0].broken.trace_id).toBe('dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5');
        expect(broken[0].broken.reason).toContain('input_refs');
      }
      expect(scan.unparseable.map((entry) => entry.path)).toContain(
        join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'corrupt.md'),
      );
    });

    it('keeps the native schema-first discriminator honest for repository-written files', async () => {
      const policyRepository = new MarkdownDecisionPolicyRepository(vault);
      await policyRepository.create(policy);
      const traceRepository = new MarkdownDecisionTraceRepository(vault);
      await traceRepository.create({
        trace_id: NATIVE_TRACE_ID,
        policy_ref: `${policy.policy_id}@v001`,
        dimension: 'input-routing',
        input_refs: ['inbox://item-1'],
        decision: 'Route inbox item to the triage queue',
        reasoning_summary: 'Source declared inbox.',
        evidence_refs: ['receipt://verify-v0.2-loop'],
        confidence: 'high',
        created_at: '2026-08-18T10:00:00.000Z',
      }, { policyResolver: (ref: string) => policyRepository.get(ref as `${string}@${string}`) });

      const scan = await scanDecisionTrees(vault);
      expect(scan.traces).toHaveLength(1);
      expect(scan.traces[0]?.source).toBe('native');
      expect(scan.unparseable).toEqual([]);
    });

    it('parses the checked-in fixture documents exactly as legacy projections', async () => {
      await installLegacyFixtures(vault);
      const scan = await scanDecisionTrees(vault);

      const legacyPolicy = scan.policies.find((entry) => entry.source === 'legacy');
      expect(legacyPolicy?.source === 'legacy' && legacyPolicy.projection.policy_id).toBe(LEGACY_POLICY_ID);

      const legacyTraces = scan.traces.filter((entry) => entry.source === 'legacy');
      expect(legacyTraces).toHaveLength(2);
      const withFeedback = legacyTraces.find(
        (entry) => entry.source === 'legacy' && entry.projection.legacy_id === LEGACY_TRACE_ID,
      );
      expect(withFeedback?.source === 'legacy' && withFeedback.projection.input_refs).toEqual(['goal:PAW-GOAL-002@0.2']);
      expect(withFeedback?.source === 'legacy' && withFeedback.projection.confidence).toBe('high');
      const missingFields = legacyTraces.find(
        (entry) => entry.source === 'legacy' && entry.projection.legacy_id === LEGACY_MISSING_TRACE_ID,
      );
      expect(missingFields?.source === 'legacy' && missingFields.projection.input_refs).toBeNull();
      expect(missingFields?.source === 'legacy' && missingFields.projection.confidence).toBeNull();
      expect(scan.unparseable).toHaveLength(1);
    });

    it('is read-only: scanning leaves every file byte and the tree shape untouched', async () => {
      const policyRepository = new MarkdownDecisionPolicyRepository(vault);
      await policyRepository.create(policy);
      await installLegacyFixtures(vault);
      const before = await sha256Tree(vault);

      await scanDecisionTrees(vault);

      const after = await sha256Tree(vault);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, hash] of before) {
        expect(after.get(path)).toBe(hash);
      }
    });

    it('silently skips symlinked files instead of projecting them', async () => {
      await installLegacyFixtures(vault);
      const outsideVault = await mkdtemp(join(tmpdir(), 'atl-decision-legacy-outside-'));
      try {
        const outsideFile = join(outsideVault, 'trace-outsider.md');
        await writeFile(outsideFile, '---\ntype: decision_trace\ntrace_id: trace-outsider\n---\n', 'utf8');
        const traceDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
        await symlink(outsideFile, join(traceDirectory, 'trace-symlinked.md'));

        const scan = await scanDecisionTrees(vault);
        const ids = scan.traces.map((entry) => (
          entry.source === 'legacy' ? entry.projection.legacy_id : entry.source
        ));
        expect(ids).not.toContain('trace-outsider');
        expect(scan.unparseable.map((entry) => entry.path)).not.toContain(
          join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'trace-symlinked.md'),
        );
      } finally {
        await rm(outsideVault, { recursive: true, force: true });
      }
    });

    it('returns empty scans for a vault without decision trees', async () => {
      const scan = await scanDecisionTrees(vault);
      expect(scan.policies).toEqual([]);
      expect(scan.traces).toEqual([]);
      expect(scan.unparseable).toEqual([]);
    });
  });
});
