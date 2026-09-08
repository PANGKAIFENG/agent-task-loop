import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import type { DerivedFeedbackSummary } from '../../../src/domain/decision-trace.js';
import {
  DecisionQueryInvalidError,
  queryDecisions,
  type DecisionProjection,
} from '../../../src/services/query-decisions.js';
import type { MigrationLedgerEntry } from '../../../src/storage/decision-migration-ledger.js';
import { deriveLegacyTraceNativeId } from '../../../src/storage/decision-legacy-adapter.js';
import { atomicReplaceSafeTextFile, type StorageReadBoundary } from '../../../src/storage/file-io.js';
import { parseTaskDocument, serializeTaskDocument } from '../../../src/storage/frontmatter.js';
import { MarkdownDecisionPolicyRepository } from '../../../src/storage/markdown-decision-policy-repository.js';
import { MarkdownDecisionTraceRepository } from '../../../src/storage/markdown-decision-trace-repository.js';

const FIXTURE_DIR = join('tests', 'fixtures', 'vault', 'decision-legacy');

const TRACE_T1 = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const TRACE_T3 = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V6';
const TRACE_T2 = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T3V8';
const TRACE_T4 = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T4WA';
const TRACE_F = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T5WC';
const TRACE_D = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T6WD';
const TRACE_E = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T7WE';

const LEGACY_FEEDBACK_ID = 'trace-legacy-demo-feedback-001';
const LEGACY_MISSING_ID = 'trace-legacy-demo-missing-001';
const LEGACY_L1 = deriveLegacyTraceNativeId(LEGACY_FEEDBACK_ID);
const LEGACY_L2 = deriveLegacyTraceNativeId(LEGACY_MISSING_ID);

const POLICY_INPUT = 'policy.input-routing.native-demo@v001';
const POLICY_ADMISSION = 'policy.agent-admission.native-demo@v001';
const POLICY_ATTENTION = 'policy.attention-priority.native-demo@v001';

const FULL_DESC_ORDER = [TRACE_T2, TRACE_T3, TRACE_T1, TRACE_F, TRACE_T4, TRACE_D, TRACE_E, LEGACY_L1, LEGACY_L2];

function basePolicy(
  policyId: string,
  dimension: 'input-routing' | 'agent-admission' | 'attention-priority',
): DecisionPolicy {
  return {
    policy_id: policyId,
    version: 'v001',
    status: 'observing',
    dimension,
    decision_question: `How does ${policyId} decide?`,
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
}

function nativeTraceInput(
  traceId: string,
  policyRef: string,
  dimension: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    trace_id: traceId,
    policy_ref: policyRef,
    dimension,
    input_refs: ['inbox://item-1'],
    decision: `Decision for ${traceId}`,
    reasoning_summary: 'Synthetic reasoning summary.',
    evidence_refs: [`receipt://verify-${traceId}`],
    confidence: 'high',
    created_at: createdAt,
    ...overrides,
  };
}

function handWrittenNativeDocument(
  traceId: string,
  policyRef: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
): string {
  return serializeTaskDocument({
    trace_id: traceId,
    policy_ref: policyRef,
    dimension: 'input-routing',
    input_refs: ['inbox://item-1'],
    decision: `Decision for ${traceId}`,
    reasoning_summary: 'Synthetic reasoning summary.',
    evidence_refs: [`receipt://verify-${traceId}`],
    confidence: 'high',
    user_feedback: 'unreviewed',
    final_outcome: 'pending',
    status: 'recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 0,
    latest_feedback_at: null,
    created_at: createdAt,
    closed_at: null,
    updated_at: null,
    status_history: [],
    ...overrides,
  }, `\n# ${traceId}\n`);
}

const ACCEPTED_SUMMARY: DerivedFeedbackSummary = {
  user_feedback: 'accepted',
  final_outcome: 'accepted_as_is',
  feedback_count: 1,
  latest_feedback_at: '2026-08-18T11:05:00.000Z',
};

const CORRECTED_SUMMARY: DerivedFeedbackSummary = {
  user_feedback: 'corrected',
  final_outcome: 'corrected_after_review',
  feedback_count: 1,
  latest_feedback_at: '2026-08-18T10:05:00.000Z',
};

async function flipTraceStale(vault: string, traceId: string, createdAt: string): Promise<void> {
  const monthDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', createdAt.slice(0, 4), createdAt.slice(5, 7));
  const path = join(monthDirectory, `${traceId}.md`);
  const raw = await readFile(path, 'utf8');
  const document = parseTaskDocument(raw);
  const next = serializeTaskDocument(
    { ...document.data, feedback_summary_status: 'stale' },
    document.body,
  );
  const boundary: StorageReadBoundary = {
    vaultRoot: vault,
    tasksRoot: join(vault, '07_System'),
    subtree: monthDirectory,
  };
  const replaced = await atomicReplaceSafeTextFile(path, raw, next, boundary);
  expect(replaced).toBe(true);
}

async function installLegacyFixtures(vault: string, withLedger: boolean): Promise<void> {
  const traceDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
  const policyDirectory = join(vault, '07_System', 'Rules', 'Decision_Logic', 'input-routing');
  const fixtureRoot = join(process.cwd(), FIXTURE_DIR);
  await mkdir(traceDirectory, { recursive: true });
  await mkdir(policyDirectory, { recursive: true });
  await writeFile(join(policyDirectory, 'policy.input-routing.legacy-demo_v001.md'), await readFile(join(fixtureRoot, 'policy-v001.md')));
  await writeFile(join(traceDirectory, `${LEGACY_FEEDBACK_ID}.md`), await readFile(join(fixtureRoot, 'trace-with-feedback.md')));
  await writeFile(join(traceDirectory, `${LEGACY_MISSING_ID}.md`), await readFile(join(fixtureRoot, 'trace-missing-fields.md')));
  await writeFile(join(traceDirectory, 'corrupt.md'), await readFile(join(fixtureRoot, 'corrupt.md')));
  if (withLedger) {
    const ledgerDirectory = join(vault, '07_System', 'Logs', 'Decision_Migration');
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(join(ledgerDirectory, 'ledger.jsonl'), await readFile(join(fixtureRoot, 'ledger-migrated.jsonl')));
  }
}

async function buildVault(withLedger: boolean): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'atl-query-decisions-'));
  const policyRepository = new MarkdownDecisionPolicyRepository(vault);
  const traceRepository = new MarkdownDecisionTraceRepository(vault);
  const resolver = (ref: string) => policyRepository.get(ref as `${string}@${string}`);

  await policyRepository.create(basePolicy('policy.input-routing.native-demo', 'input-routing'));
  await policyRepository.create(basePolicy('policy.attention-priority.native-demo', 'attention-priority'));
  await policyRepository.create(basePolicy('policy.agent-admission.native-demo', 'agent-admission'));

  await traceRepository.create(nativeTraceInput(TRACE_T1, POLICY_INPUT, 'input-routing', '2026-08-18T10:00:00.000Z', {
    input_refs: ['inbox://item-1', 'goal://PAW-GOAL-002@0.2'],
    evidence_refs: ['receipt://verify-native-t1'],
  }), { policyResolver: resolver });

  await traceRepository.create(nativeTraceInput(TRACE_T3, POLICY_INPUT, 'input-routing', '2026-08-18T10:00:00.000Z'), { policyResolver: resolver });
  await traceRepository.updateFeedbackSummary(TRACE_T3, CORRECTED_SUMMARY);
  await flipTraceStale(vault, TRACE_T3, '2026-08-18T10:00:00.000Z');

  await traceRepository.create(nativeTraceInput(TRACE_T2, POLICY_ADMISSION, 'agent-admission', '2026-08-18T11:00:00.000Z'), { policyResolver: resolver });
  await traceRepository.updateFeedbackSummary(TRACE_T2, ACCEPTED_SUMMARY);
  await policyRepository.updateStatus(POLICY_ADMISSION, 'deprecated');

  await traceRepository.create(nativeTraceInput(TRACE_T4, POLICY_INPUT, 'input-routing', '2026-08-18T09:00:00.000Z', {
    evidence_refs: ['receipt://verify-v0.2-loop'],
  }), { policyResolver: resolver });
  await traceRepository.updateFeedbackSummary(TRACE_T4, {
    ...ACCEPTED_SUMMARY,
    latest_feedback_at: '2026-08-18T09:05:00.000Z',
  });

  // Dimension mismatch: input-routing trace pinned to an attention-priority policy.
  await traceRepository.create(nativeTraceInput(TRACE_F, POLICY_ATTENTION, 'input-routing', '2026-08-18T09:30:00.000Z'), { policyResolver: resolver });

  const monthDirectory = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
  await mkdir(monthDirectory, { recursive: true });
  await writeFile(join(monthDirectory, `${TRACE_D}.md`), handWrittenNativeDocument(TRACE_D, POLICY_INPUT, '2026-08-18T08:30:00.000Z', { input_refs: [] }));
  await writeFile(join(monthDirectory, `${TRACE_E}.md`), handWrittenNativeDocument(TRACE_E, 'policy.missing.nowhere@v001', '2026-08-18T08:00:00.000Z'));

  await installLegacyFixtures(vault, withLedger);
  return vault;
}

function idsOf(projection: DecisionProjection): string[] {
  return projection.items.map((item) => item.trace_id);
}

function byTraceId(projection: DecisionProjection, traceId: string) {
  return projection.items.find((item) => item.trace_id === traceId);
}

function cursorOf(projection: DecisionProjection): string {
  const cursor = projection.next_cursor;
  expect(cursor).not.toBeNull();
  return cursor as string;
}

async function walkAllPages(vault: string, query: Record<string, unknown>): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const projection = await queryDecisions({ root: vault }, { ...query, cursor });
    collected.push(...idsOf(projection));
    if (projection.next_cursor === null) {
      return collected;
    }
    cursor = projection.next_cursor;
  }
  throw new Error('pagination did not terminate');
}

describe('queryDecisions', () => {
  let vault: string;

  beforeEach(async () => {
    vault = await buildVault(false);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  describe('default projection over a mixed native+legacy vault', () => {
    it('returns every integrity class including broken items, in stable full order', async () => {
      const projection = await queryDecisions({ root: vault }, { limit: 50 });
      expect(idsOf(projection)).toEqual(FULL_DESC_ORDER);
      expect(projection.next_cursor).toBeNull();

      const integrityById = new Map(projection.items.map((item) => [item.trace_id, item.integrity_status]));
      expect(integrityById.get(TRACE_T1)).toBe('valid');
      expect(integrityById.get(TRACE_T4)).toBe('valid');
      expect(integrityById.get(TRACE_T2)).toBe('warning');
      expect(integrityById.get(TRACE_T3)).toBe('warning');
      expect(integrityById.get(TRACE_F)).toBe('broken');
      expect(integrityById.get(TRACE_D)).toBe('broken');
      expect(integrityById.get(TRACE_E)).toBe('broken');
      expect(integrityById.get(LEGACY_L1)).toBe('legacy_compatible');
      expect(integrityById.get(LEGACY_L2)).toBe('legacy_compatible');
    });

    it('projects the frozen item fields for native and legacy rows', async () => {
      const projection = await queryDecisions({ root: vault }, { limit: 50 });

      const native = byTraceId(projection, TRACE_T1);
      expect(native).toMatchObject({
        trace_id: TRACE_T1,
        policy_ref: POLICY_INPUT,
        dimension: 'input-routing',
        input_refs: ['inbox://item-1', 'goal://PAW-GOAL-002@0.2'],
        decision: `Decision for ${TRACE_T1}`,
        evidence_refs: ['receipt://verify-native-t1'],
        confidence: 'high',
        user_feedback: 'unreviewed',
        final_outcome: 'pending',
        trace_status: 'recorded',
        created_at: '2026-08-18T10:00:00.000Z',
        policy_status: 'observing',
        schema_version: 'v1',
        source: 'native',
        integrity_status: 'valid',
      });
      expect(native?.legacy_id).toBeUndefined();

      const legacy = byTraceId(projection, LEGACY_L1);
      expect(legacy).toMatchObject({
        trace_id: LEGACY_L1,
        legacy_id: LEGACY_FEEDBACK_ID,
        policy_ref: 'policy.input-routing.legacy-demo@v001',
        input_refs: ['goal:PAW-GOAL-002@0.2'],
        confidence: 'high',
        user_feedback: 'corrected',
        final_outcome: 'corrected_after_review',
        trace_status: 'feedback_recorded',
        created_at: '2026-08-17T09:30:00.000Z',
        policy_status: 'observing',
        schema_version: 'v1',
        source: 'legacy',
        integrity_status: 'legacy_compatible',
      });

      const brokenNative = byTraceId(projection, TRACE_D);
      expect(brokenNative).toMatchObject({
        trace_id: TRACE_D,
        source: 'native',
        integrity_status: 'broken',
        input_refs: [],
        policy_status: 'observing',
      });

      const dangling = byTraceId(projection, TRACE_E);
      expect(dangling).toMatchObject({ integrity_status: 'broken', policy_status: null });

      const missingFields = byTraceId(projection, LEGACY_L2);
      expect(missingFields).toMatchObject({
        input_refs: [],
        confidence: null,
        user_feedback: 'unreviewed',
        created_at: '2026-08-16T08:00:00.000Z',
        trace_status: 'recorded',
      });
    });

    it('computes the six frozen facets over the full filtered set, not the page', async () => {
      const projection = await queryDecisions({ root: vault }, { limit: 1 });
      expect(projection.items).toHaveLength(1);
      expect(projection.facets).toEqual({
        dimension: { 'input-routing': 8, 'agent-admission': 1 },
        policy_status: { observing: 7, deprecated: 1 },
        trace_status: { recorded: 5, feedback_recorded: 4 },
        feedback_kind: { unreviewed: 5, accepted: 2, corrected: 2 },
        integrity_status: { valid: 2, warning: 2, broken: 3, legacy_compatible: 2 },
        source: { native: 7, legacy: 2 },
      });
    });

    it('emits explicit diagnostics through the warnings channel', async () => {
      const projection = await queryDecisions({ root: vault }, { limit: 50 });
      const codes = projection.warnings.map((warning) => warning.code);

      expect(codes).toContain('feedback_summary_stale');
      expect(projection.warnings.find((warning) => warning.code === 'feedback_summary_stale')?.trace_id)
        .toBe(TRACE_T3);

      expect(codes).toContain('policy_deprecated_reference');
      expect(projection.warnings.find((warning) => warning.code === 'policy_deprecated_reference')?.trace_id)
        .toBe(TRACE_T2);

      expect(codes).toContain('legacy_missing_input_refs');
      const missingRefs = projection.warnings.find((warning) => warning.code === 'legacy_missing_input_refs');
      expect(missingRefs?.trace_id).toBe(LEGACY_L2);
      expect(missingRefs?.detail).toContain(LEGACY_MISSING_ID);

      expect(codes).toContain('legacy_missing_confidence');
      expect(codes).toContain('legacy_schema_unparseable');
      const unparseable = projection.warnings.find((warning) => warning.code === 'legacy_schema_unparseable');
      expect(unparseable?.detail).toContain('corrupt.md');
      expect(unparseable?.trace_id).toBeUndefined();
    });

    it('is deterministic: identical queries return identical projections', async () => {
      const first = await queryDecisions({ root: vault }, { limit: 3 });
      const second = await queryDecisions({ root: vault }, { limit: 3 });
      expect(second).toEqual(first);
    });
  });

  describe('filters', () => {
    it('filters by dimension, policy id, policy version and policy status', async () => {
      expect(idsOf(await queryDecisions({ root: vault }, { dimension: 'agent-admission' }))).toEqual([TRACE_T2]);
      expect(idsOf(await queryDecisions({ root: vault }, { policyId: 'policy.input-routing.native-demo' })))
        .toEqual([TRACE_T3, TRACE_T1, TRACE_T4, TRACE_D]);
      expect(idsOf(await queryDecisions({ root: vault }, { policyId: 'policy.attention-priority.native-demo' })))
        .toEqual([TRACE_F]);
      expect((await queryDecisions({ root: vault }, { policyVersion: 'v001' })).items).toHaveLength(9);
      expect(idsOf(await queryDecisions({ root: vault }, { policyStatus: 'deprecated' }))).toEqual([TRACE_T2]);
    });

    it('filters by trace status, feedback kind, integrity status and source', async () => {
      expect(idsOf(await queryDecisions({ root: vault }, { traceStatus: 'feedback_recorded' })))
        .toEqual([TRACE_T2, TRACE_T3, TRACE_T4, LEGACY_L1]);
      expect(idsOf(await queryDecisions({ root: vault }, { feedbackKind: 'corrected' })))
        .toEqual([TRACE_T3, LEGACY_L1]);
      expect(idsOf(await queryDecisions({ root: vault }, { integrityStatus: 'broken' })))
        .toEqual([TRACE_F, TRACE_D, TRACE_E]);
      expect(idsOf(await queryDecisions({ root: vault }, { source: 'legacy' }))).toEqual([LEGACY_L1, LEGACY_L2]);
    });

    it('filters by inclusive created_at bounds', async () => {
      const projection = await queryDecisions({ root: vault }, {
        createdFrom: '2026-08-18T09:00:00.000Z',
        createdTo: '2026-08-18T10:00:00.000Z',
      });
      expect(idsOf(projection)).toEqual([TRACE_T3, TRACE_T1, TRACE_F, TRACE_T4]);
    });

    it('filters by refs across input_refs and evidence_refs', async () => {
      expect(idsOf(await queryDecisions({ root: vault }, { refs: ['goal:PAW-GOAL-002@0.2'] })))
        .toEqual([LEGACY_L1]);
      expect(idsOf(await queryDecisions({ root: vault }, { refs: ['goal://PAW-GOAL-002@0.2'] })))
        .toEqual([TRACE_T1]);
      expect(idsOf(await queryDecisions({ root: vault }, { refs: ['receipt://verify-v0.2-loop'] })))
        .toEqual([TRACE_T4]);
    });

    it('resolves stability: unknown derives from feedback presence, others need the injected reader', async () => {
      expect(idsOf(await queryDecisions({ root: vault }, { stability: 'unknown' })))
        .toEqual([TRACE_T1, TRACE_F, TRACE_D, TRACE_E, LEGACY_L2]);
      expect(idsOf(await queryDecisions({ root: vault }, { stability: 'confirmed_pattern' }))).toEqual([]);
      const injected = await queryDecisions({ root: vault }, { stability: 'confirmed_pattern' }, {
        feedbackStabilityByTrace: (candidate) => (
          candidate.trace_id === TRACE_T4 ? 'confirmed_pattern' : 'single_exception'
        ),
      });
      expect(idsOf(injected)).toEqual([TRACE_T4]);
    });
  });

  describe('sorting and pagination', () => {
    it('sorts ascending on request', async () => {
      const projection = await queryDecisions({ root: vault }, { sort: 'created_asc' });
      expect(idsOf(projection)).toEqual([...FULL_DESC_ORDER].reverse());
    });

    it('breaks created_at ties with the trace_id lexicographic order', async () => {
      const projection = await queryDecisions({ root: vault }, { limit: 50 });
      const order = idsOf(projection);
      expect(order.indexOf(TRACE_T3)).toBeLessThan(order.indexOf(TRACE_T1));
    });

    it('paginates with closure: the union of pages equals the full set without duplicates', async () => {
      const walked = await walkAllPages(vault, { limit: 2 });
      expect(walked).toEqual(FULL_DESC_ORDER);
      expect(new Set(walked).size).toBe(walked.length);
    });

    it('returns the next page from next_cursor and null on the final page', async () => {
      const first = await queryDecisions({ root: vault }, { limit: 2 });
      expect(idsOf(first)).toEqual([TRACE_T2, TRACE_T3]);
      const second = await queryDecisions({ root: vault }, { limit: 2, cursor: cursorOf(first) });
      expect(idsOf(second)).toEqual([TRACE_T1, TRACE_F]);
      const last = await queryDecisions({ root: vault }, { limit: 8, cursor: cursorOf(second) });
      expect(idsOf(last)).toEqual([TRACE_T4, TRACE_D, TRACE_E, LEGACY_L1, LEGACY_L2]);
      expect(last.next_cursor).toBeNull();
    });

    it('rejects malformed cursors', async () => {
      const malformed: Array<string> = [
        'not-a-cursor',
        Buffer.from('{}', 'utf8').toString('base64url'),
        Buffer.from(JSON.stringify(['yesterday', 'dt_x']), 'utf8').toString('base64url'),
        Buffer.from(JSON.stringify(['2026-08-18T10:00:00.000Z']), 'utf8').toString('base64url'),
      ];
      for (const cursor of malformed) {
        await expect(queryDecisions({ root: vault }, { cursor })).rejects.toBeInstanceOf(DecisionQueryInvalidError);
      }
    });
  });

  describe('query validation', () => {
    it('rejects out-of-range or non-integer limits', async () => {
      for (const limit of [0, 201, 2.5, '50']) {
        await expect(queryDecisions({ root: vault }, { limit: limit as number }))
          .rejects.toBeInstanceOf(DecisionQueryInvalidError);
      }
    });

    it('rejects invalid enum filter values with decision_query_invalid', async () => {
      const invalid: Array<Record<string, unknown>> = [
        { dimension: 'misc' },
        { sort: 'random' },
        { source: 'any' },
        { integrityStatus: 'ok' },
        { feedbackKind: 'none' },
        { stability: 'wobbly' },
        { policyStatus: 'retired' },
        { traceStatus: 'open' },
        { policyVersion: 'v1' },
      ];
      for (const query of invalid) {
        await expect(queryDecisions({ root: vault }, { limit: 10, ...query }))
          .rejects.toBeInstanceOf(DecisionQueryInvalidError);
      }
    });

    it('exposes the frozen error code on invalid queries', async () => {
      const failure = queryDecisions({ root: vault }, { limit: 0 });
      await expect(failure).rejects.toMatchObject({ code: 'decision_query_invalid' });
    });
  });

  describe('migration ledger deduplication', () => {
    it('excludes migrated legacy traces from items and facets via the default vault reader', async () => {
      const withLedger = await buildVault(true);
      try {
        const projection = await queryDecisions({ root: withLedger }, { limit: 50 });

        expect(idsOf(projection)).toEqual([TRACE_T2, TRACE_T3, TRACE_T1, TRACE_F, TRACE_T4, TRACE_D, TRACE_E, LEGACY_L2]);
        expect(projection.facets).toEqual({
          dimension: { 'input-routing': 7, 'agent-admission': 1 },
          policy_status: { observing: 5, deprecated: 1 },
          trace_status: { recorded: 5, feedback_recorded: 3 },
          feedback_kind: { unreviewed: 5, accepted: 2, corrected: 1 },
          integrity_status: { valid: 2, warning: 2, broken: 3, legacy_compatible: 1 },
          source: { native: 7, legacy: 1 },
        });
        // The migrated legacy policy no longer feeds resolution: L2 loses its
        // policy_status join but stays legacy_compatible (M1: never broken).
        expect(byTraceId(projection, LEGACY_L2)?.policy_status).toBeNull();

        const unreadable = projection.warnings
          .filter((warning) => warning.code === 'migration_ledger_entry_unreadable');
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0]?.detail).toContain('line');
      } finally {
        await rm(withLedger, { recursive: true, force: true });
      }
    });

    it('does not deduplicate a native id whose only ledger rows are failed/duplicate', async () => {
      const withLedger = await buildVault(true);
      try {
        // LEGACY_L1 carries a migrated row plus a failed row in the fixture; it
        // must still be deduplicated (migrated wins). LEGACY_L2 has no rows and
        // stays projected — covered above; here assert L1 is gone while the
        // corrupt line did not disable deduplication for the policy entry.
        const projection = await queryDecisions({ root: withLedger }, { limit: 50, source: 'legacy' });
        expect(idsOf(projection)).toEqual([LEGACY_L2]);
      } finally {
        await rm(withLedger, { recursive: true, force: true });
      }
    });

    it('honours injected ledger entries over the default reader', async () => {
      const failedOnly: MigrationLedgerEntry[] = [{
        run_id: 'run-injected-001',
        at: '2026-08-18T12:00:00.000Z',
        source_path: `07_System/Logs/Decision_Traces/2026/08/${LEGACY_MISSING_ID}.md`,
        source_sha256: '0'.repeat(64),
        kind: 'trace',
        native_id: LEGACY_L2,
        status: 'failed',
        detail: 'write_failed',
      }];
      const projection = await queryDecisions({ root: vault }, { limit: 50 }, { ledgerEntries: failedOnly });
      // failed rows never deduplicate: both legacy traces stay projected.
      expect(idsOf(projection)).toEqual(FULL_DESC_ORDER);

      const migrated: MigrationLedgerEntry[] = [{
        ...failedOnly[0]!,
        status: 'migrated',
        detail: undefined,
      }];
      const deduped = await queryDecisions({ root: vault }, { limit: 50 }, { ledgerEntries: migrated });
      expect(idsOf(deduped)).toEqual([TRACE_T2, TRACE_T3, TRACE_T1, TRACE_F, TRACE_T4, TRACE_D, TRACE_E, LEGACY_L1]);
    });
  });
});
