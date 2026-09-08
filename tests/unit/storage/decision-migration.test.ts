import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deterministicFeedbackId } from '../../../src/domain/decision-feedback.js';
import { deriveLegacyTraceNativeId } from '../../../src/storage/decision-legacy-adapter.js';
import {
  migrationLedgerPath,
  readMigrationLedger,
} from '../../../src/storage/decision-migration-ledger.js';
import {
  DecisionMigrationInvalidError,
  migrateLegacyDecisions,
  type MigrationReport,
} from '../../../src/storage/decision-migration.js';
import {
  createDecisionServiceContext,
  type DecisionServiceContext,
} from '../../../src/services/service-context.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';
import { queryDecisions } from '../../../src/services/query-decisions.js';
import type { FeedbackAggregationFilter } from '../../../src/storage/markdown-decision-feedback-repository.js';
import {
  DecisionTraceReadonlyError,
  recordDecisionFeedback,
} from '../../../src/services/record-decision-feedback.js';
import { checkDecisionConsistency } from '../../../src/services/check-decision-consistency.js';

const FIXTURE_DIR = join('tests', 'fixtures', 'vault', 'decision-legacy');
const LEGACY_FEEDBACK_ID = 'trace-legacy-demo-feedback-001';
const LEGACY_MISSING_ID = 'trace-legacy-demo-missing-001';
const LEGACY_ACCEPTED_ID = 'trace-legacy-demo-accepted-001';
const LEGACY_POLICY_INPUT = 'policy.input-routing.legacy-demo';
const LEGACY_POLICY_ATTENTION = 'policy.attention-priority.legacy-demo';

const DT_FEEDBACK = deriveLegacyTraceNativeId(LEGACY_FEEDBACK_ID);
const DT_MISSING = deriveLegacyTraceNativeId(LEGACY_MISSING_ID);
const DT_ACCEPTED = deriveLegacyTraceNativeId(LEGACY_ACCEPTED_ID);
const FB_FEEDBACK = deterministicFeedbackId(DT_FEEDBACK, 'legacy-feedback');
const FB_ACCEPTED = deterministicFeedbackId(DT_ACCEPTED, 'legacy-feedback');

const TRACE_SOURCE_PATH = '07_System/Logs/Decision_Traces/2026/08'
  + `/${LEGACY_FEEDBACK_ID}.md`;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixtureBytes(name: string): Promise<string> {
  return readFile(join(process.cwd(), FIXTURE_DIR, name), 'utf8');
}

async function writeFixture(directory: string, name: string, fileName: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, fileName), await fixtureBytes(name));
}

/** Full legacy source vault: two dimensions, two feedback traces, gaps, corruption. */
async function installFullSource(vault: string): Promise<void> {
  await writeFixture(
    join(vault, '07_System', 'Rules', 'Decision_Logic', 'input-routing'),
    'policy-v001.md',
    `${LEGACY_POLICY_INPUT}_v001.md`,
  );
  await writeFixture(
    join(vault, '07_System', 'Rules', 'Decision_Logic', 'attention-priority'),
    'policy-attention-v001.md',
    `${LEGACY_POLICY_ATTENTION}_v001.md`,
  );
  const traces = join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08');
  await writeFixture(traces, 'trace-with-feedback.md', `${LEGACY_FEEDBACK_ID}.md`);
  await writeFixture(traces, 'trace-missing-fields.md', `${LEGACY_MISSING_ID}.md`);
  await writeFixture(traces, 'trace-accepted-history.md', `${LEGACY_ACCEPTED_ID}.md`);
  await writeFixture(traces, 'corrupt.md', 'corrupt.md');
}

/**
 * Mixed vault (I2 linkage shape): the legacy policy sits under a
 * non-canonical file name so its native canonical path is free to create.
 */
async function installMixedLegacy(vault: string): Promise<void> {
  await writeFixture(
    join(vault, '07_System', 'Rules', 'Decision_Logic', 'input-routing'),
    'policy-v001.md',
    'legacy-input-routing-policy.md',
  );
  await writeFixture(
    join(vault, '07_System', 'Logs', 'Decision_Traces', '2026', '08'),
    'trace-with-feedback.md',
    `${LEGACY_FEEDBACK_ID}.md`,
  );
}

async function sha256Tree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        hashes.set(relative(root, path), sha256(await readFile(path)));
      }
    }
  };
  await walk(root);
  return hashes;
}

async function countMarkdownFiles(root: string, subtree: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count += 1;
      }
    }
  };
  await walk(join(root, '07_System', subtree));
  return count;
}

function assertClosureInvariants(report: MigrationReport): void {
  expect(report.source_total).toBe(
    report.migrated + report.duplicate + report.conflict + report.failed + report.skipped,
  );
  expect(report.source_total).toBe(
    report.parseable + report.duplicate + report.conflict + report.failed_unparseable,
  );
  expect(report.parseable).toBe(
    report.migrated + report.skipped + report.failed_write_failed,
  );
}

function outcomeFor(report: MigrationReport, sourcePath: string) {
  const match = report.outcomes.filter((outcome) => outcome.source_path === sourcePath);
  expect(match).toHaveLength(1);
  return match[0] ?? null;
}

describe('decision migration', () => {
  let source: string;
  let target: string;
  let ctx: DecisionServiceContext;

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'atl-migration-source-'));
    target = await mkdtemp(join(tmpdir(), 'atl-migration-target-'));
    ctx = createDecisionServiceContext(target);
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it('migrates legacy policies and traces into a fresh target with closed accounting', async () => {
    await installFullSource(source);
    const reportPath = join(target, 'migration-report.json');

    const report = await migrateLegacyDecisions(ctx, { sourceDir: source, reportPath });

    expect(report).toMatchObject({
      source_root: source,
      source_total: 6,
      parseable: 5,
      migrated: 4,
      duplicate: 0,
      conflict: 0,
      failed: 1,
      skipped: 1,
      failed_unparseable: 1,
      failed_write_failed: 0,
      generated: { policies: 2, traces: 2, feedbacks: 2 },
      missing_or_conflict_refs: 0,
    });
    assertClosureInvariants(report);

    // Per-file diagnostics stay locatable and never block the other entries.
    expect(outcomeFor(report, '07_System/Logs/Decision_Traces/2026/08/corrupt.md')).toMatchObject({
      kind: 'trace',
      status: 'failed',
      detail: 'unparseable',
    });
    expect(outcomeFor(report, `07_System/Logs/Decision_Traces/2026/08/${LEGACY_MISSING_ID}.md`))
      .toMatchObject({
        kind: 'trace',
        status: 'skipped',
        native_id: DT_MISSING,
        detail: 'missing_required_field:input_refs',
      });
    expect(outcomeFor(report, `07_System/Logs/Decision_Traces/2026/08/${LEGACY_FEEDBACK_ID}.md`))
      .toMatchObject({
        kind: 'trace',
        status: 'migrated',
        native_id: DT_FEEDBACK,
        legacy_id: LEGACY_FEEDBACK_ID,
      });
    expect(outcomeFor(report, `07_System/Rules/Decision_Logic/input-routing/${LEGACY_POLICY_INPUT}_v001.md`))
      .toMatchObject({
        kind: 'policy',
        status: 'migrated',
        native_id: `${LEGACY_POLICY_INPUT}@v001`,
      });

    // Native objects exist at canonical paths, one per migrated source.
    expect(await countMarkdownFiles(target, 'Rules/Decision_Logic')).toBe(2);
    expect(await countMarkdownFiles(target, 'Logs/Decision_Traces')).toBe(2);
    expect(await countMarkdownFiles(target, 'Logs/Decision_Feedback')).toBe(2);

    const inputPolicy = await ctx.policies.get(`${LEGACY_POLICY_INPUT}@v001`);
    expect(inputPolicy).toMatchObject({
      status: 'observing',
      dimension: 'input-routing',
      decision_question: 'Should this legacy synthetic input become a work item?',
      sources: ['synthetic_input', 'TEP27-PRD@1.1'],
    });
    expect(inputPolicy?.rules.map((rule) => rule.statement)).toEqual([
      'Preserve source_key and create an Inbox candidate first.',
    ]);
    const attentionPolicy = await ctx.policies.get(`${LEGACY_POLICY_ATTENTION}@v001`);
    expect(attentionPolicy?.dimension).toBe('attention-priority');

    // The corrected legacy trace carries its embedded feedback into the summary.
    const trace = await ctx.traces.get(DT_FEEDBACK);
    expect(trace).toMatchObject({
      trace_id: DT_FEEDBACK,
      policy_ref: `${LEGACY_POLICY_INPUT}@v001`,
      user_feedback: 'corrected',
      final_outcome: 'corrected_after_review',
      status: 'feedback_recorded',
      feedback_summary_status: 'fresh',
      feedback_count: 1,
      created_at: '2026-08-17T09:30:00.000Z',
    });

    // Embedded feedback ids are the frozen D8 derivation with legacy data only.
    const samples = await ctx.feedback.listByTrace(DT_FEEDBACK);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      feedback_id: FB_FEEDBACK,
      trace_id: DT_FEEDBACK,
      kind: 'corrected',
      stability: 'unknown',
      correction_summary: 'User corrected the routing rationale during weekly review.',
      final_outcome: 'corrected_after_review',
      source_ref: TRACE_SOURCE_PATH,
      idempotency_key: 'legacy-feedback',
    });
    const acceptedSamples = await ctx.feedback.listByTrace(DT_ACCEPTED);
    expect(acceptedSamples[0]).toMatchObject({
      feedback_id: FB_ACCEPTED,
      kind: 'accepted',
      correction_summary: null,
      final_outcome: 'accepted_after_review',
    });

    // Skipped candidates never produce native objects.
    expect(await ctx.traces.get(DT_MISSING)).toBeNull();

    // The ledger records every source outcome plus embedded feedback rows.
    const entries = await readMigrationLedger(target);
    expect(entries.filter((entry) => entry.status === 'migrated')).toHaveLength(6);
    expect(entries.filter((entry) => entry.kind === 'feedback')).toHaveLength(2);
    // The trace's source file emits its trace row plus its embedded-feedback row.
    const traceRows = entries.filter((entry) => entry.source_path === TRACE_SOURCE_PATH);
    expect(traceRows.map((row) => row.kind).sort()).toEqual(['feedback', 'trace']);
    expect(traceRows.filter((row) => row.kind === 'trace')[0]?.native_id).toBe(DT_FEEDBACK);
    expect(traceRows.filter((row) => row.kind === 'feedback')[0]?.native_id).toBe(FB_FEEDBACK);

    // The report file is the JSON projection of the returned report.
    const written = JSON.parse(await readFile(reportPath, 'utf8')) as MigrationReport;
    expect(written.source_total).toBe(report.source_total);
    expect(written.outcomes).toEqual(report.outcomes);
  });

  it('keeps source files byte-identical and reruns with zero increment (all duplicate)', async () => {
    await installFullSource(source);
    const before = await sha256Tree(source);

    const first = await migrateLegacyDecisions(ctx, {
      sourceDir: source,
      reportPath: join(target, 'run-1.json'),
    });
    expect(first.migrated).toBe(4);

    const nativeAfterFirst = await countMarkdownFiles(target, 'Rules/Decision_Logic')
      + await countMarkdownFiles(target, 'Logs/Decision_Traces')
      + await countMarkdownFiles(target, 'Logs/Decision_Feedback');

    const second = await migrateLegacyDecisions(ctx, {
      sourceDir: source,
      reportPath: join(target, 'run-2.json'),
    });

    expect(second).toMatchObject({
      source_total: 6,
      parseable: 0,
      migrated: 0,
      duplicate: 6,
      conflict: 0,
      failed: 0,
      skipped: 0,
      generated: { policies: 0, traces: 0, feedbacks: 0 },
    });
    assertClosureInvariants(second);
    for (const outcome of second.outcomes) {
      expect(outcome.status).toBe('duplicate');
    }

    const nativeAfterSecond = await countMarkdownFiles(target, 'Rules/Decision_Logic')
      + await countMarkdownFiles(target, 'Logs/Decision_Traces')
      + await countMarkdownFiles(target, 'Logs/Decision_Feedback');
    expect(nativeAfterSecond).toBe(nativeAfterFirst);

    // Source files are read-only to the migrator: byte-identical after two runs.
    expect(await sha256Tree(source)).toEqual(before);
  });

  it('reports conflict when a source file changed between runs', async () => {
    await installFullSource(source);
    await migrateLegacyDecisions(ctx, { sourceDir: source, reportPath: join(target, 'run-1.json') });

    const editedPath = join(
      source,
      '07_System',
      'Logs',
      'Decision_Traces',
      '2026',
      '08',
      `${LEGACY_FEEDBACK_ID}.md`,
    );
    const original = await readFile(editedPath, 'utf8');
    await writeFile(editedPath, `${original}\n<!-- edited between runs -->\n`, 'utf8');

    const second = await migrateLegacyDecisions(ctx, {
      sourceDir: source,
      reportPath: join(target, 'run-2.json'),
    });

    expect(second).toMatchObject({
      source_total: 6,
      conflict: 1,
      duplicate: 5,
      migrated: 0,
    });
    assertClosureInvariants(second);
    const conflict = outcomeFor(second, TRACE_SOURCE_PATH);
    expect(conflict).toMatchObject({ status: 'conflict', native_id: DT_FEEDBACK });
    expect(conflict?.detail).toContain('sha_mismatch');

    // Conflict short-circuits before parsing: still zero new objects.
    expect(await countMarkdownFiles(target, 'Logs/Decision_Traces')).toBe(2);
    expect(await countMarkdownFiles(target, 'Logs/Decision_Feedback')).toBe(2);
  });

  it('skips traces whose policy reference cannot be resolved natively', async () => {
    await writeFixture(
      join(source, '07_System', 'Logs', 'Decision_Traces', '2026', '08'),
      'trace-with-feedback.md',
      `${LEGACY_FEEDBACK_ID}.md`,
    );

    const report = await migrateLegacyDecisions(ctx, {
      sourceDir: source,
      reportPath: join(target, 'run-1.json'),
    });

    expect(report).toMatchObject({
      source_total: 1,
      parseable: 1,
      migrated: 0,
      skipped: 1,
      missing_or_conflict_refs: 1,
    });
    assertClosureInvariants(report);
    expect(outcomeFor(report, TRACE_SOURCE_PATH)).toMatchObject({
      status: 'skipped',
      native_id: DT_FEEDBACK,
      detail: `missing_or_conflict_ref:${LEGACY_POLICY_INPUT}@v001`,
    });
    expect(await ctx.traces.get(DT_FEEDBACK)).toBeNull();
  });

  it('keeps the mixed-vault query unique across migration and a zero-increment rerun (I2)', async () => {
    const mixed = await mkdtemp(join(tmpdir(), 'atl-migration-mixed-'));
    try {
      await installMixedLegacy(mixed);
      const mixedCtx = createDecisionServiceContext(mixed);
      const query = { limit: 50 };

      const before = await queryDecisions({ root: mixed }, query);
      const beforeMatches = before.items.filter((item) => item.trace_id === DT_FEEDBACK);
      expect(beforeMatches).toHaveLength(1);
      expect(beforeMatches[0]).toMatchObject({
        source: 'legacy',
        legacy_id: LEGACY_FEEDBACK_ID,
        integrity_status: 'legacy_compatible',
        user_feedback: 'corrected',
        trace_status: 'feedback_recorded',
        policy_status: 'observing',
        created_at: '2026-08-17T09:30:00.000Z',
      });

      const report = await migrateLegacyDecisions(mixedCtx, {
        sourceDir: mixed,
        reportPath: join(mixed, 'migration-report.json'),
      });
      expect(report.migrated).toBe(2);
      expect(report.missing_or_conflict_refs).toBe(0);

      const after = await queryDecisions({ root: mixed }, query);
      const afterMatches = after.items.filter((item) => item.trace_id === DT_FEEDBACK);
      expect(afterMatches).toHaveLength(1);
      expect(afterMatches[0]).toMatchObject({
        source: 'native',
        integrity_status: 'valid',
        user_feedback: 'corrected',
        trace_status: 'feedback_recorded',
        policy_status: 'observing',
        created_at: '2026-08-17T09:30:00.000Z',
      });
      // The migrated native row keeps the legacy backlink (frozen Task 6).
      expect(afterMatches[0]?.legacy_id).toBe(LEGACY_FEEDBACK_ID);

      // No double counting: item count and every stable facet stay identical.
      expect(after.items).toHaveLength(before.items.length);
      expect(after.facets.dimension).toEqual(before.facets.dimension);
      expect(after.facets.policy_status).toEqual(before.facets.policy_status);
      expect(after.facets.trace_status).toEqual(before.facets.trace_status);
      expect(after.facets.feedback_kind).toEqual(before.facets.feedback_kind);
      // The trace moves across exactly one source and one integrity bucket.
      expect(after.facets.source).toEqual({ native: 1 });
      expect(before.facets.source).toEqual({ legacy: 1 });
      expect(after.facets.integrity_status).toEqual({ valid: 1 });
      expect(before.facets.integrity_status).toEqual({ legacy_compatible: 1 });

      // Second run: zero increment, and the same uniqueness assertion holds.
      const rerun = await migrateLegacyDecisions(mixedCtx, {
        sourceDir: mixed,
        reportPath: join(mixed, 'migration-report-2.json'),
      });
      expect(rerun.duplicate).toBe(2);
      expect(rerun.migrated).toBe(0);

      const final = await queryDecisions({ root: mixed }, query);
      const finalMatches = final.items.filter((item) => item.trace_id === DT_FEEDBACK);
      expect(finalMatches).toHaveLength(1);
      expect(finalMatches[0]?.source).toBe('native');
      expect(finalMatches[0]?.legacy_id).toBe(LEGACY_FEEDBACK_ID);
      expect(final.items).toHaveLength(before.items.length);

      // The report carries the legacy_id -> native_id backlink (D8).
      expect(outcomeFor(rerun, TRACE_SOURCE_PATH)).toMatchObject({
        native_id: DT_FEEDBACK,
        legacy_id: LEGACY_FEEDBACK_ID,
      });
    } finally {
      await rm(mixed, { recursive: true, force: true });
    }
  });

  it('rejects feedback on the legacy id and accepts it on the native copy (PRD 7/8)', async () => {
    await installMixedLegacy(target);
    const mixedCtx = createDecisionServiceContext(target);
    await migrateLegacyDecisions(mixedCtx, {
      sourceDir: target,
      reportPath: join(target, 'migration-report.json'),
    });

    await expect(recordDecisionFeedback(mixedCtx, {
      trace_id: LEGACY_FEEDBACK_ID,
      kind: 'accepted',
      source_ref: 'synthetic:post-migration',
    })).rejects.toThrow(DecisionTraceReadonlyError);

    const result = await recordDecisionFeedback(mixedCtx, {
      trace_id: DT_FEEDBACK,
      kind: 'accepted',
      source_ref: 'synthetic:post-migration',
      idempotency_key: 'post-migration-probe-0001',
    });
    expect(result.created).toBe(true);

    const trace = await mixedCtx.traces.get(DT_FEEDBACK);
    expect(trace).toMatchObject({
      feedback_count: 2,
      user_feedback: 'accepted',
      feedback_summary_status: 'fresh',
    });

    const consistency = await checkDecisionConsistency(mixedCtx, {});
    expect(consistency.issues.filter((issue) => issue.trace_id === DT_FEEDBACK)).toEqual([]);
  });

  it('returns an empty closed report for a source without candidates', async () => {
    await mkdir(join(source, '07_System', 'Rules', 'Decision_Logic'), { recursive: true });
    await mkdir(join(source, '07_System', 'Logs', 'Decision_Traces'), { recursive: true });
    const reportPath = join(target, 'empty-report.json');

    const report = await migrateLegacyDecisions(ctx, { sourceDir: source, reportPath });

    expect(report).toMatchObject({
      source_total: 0,
      parseable: 0,
      migrated: 0,
      duplicate: 0,
      conflict: 0,
      failed: 0,
      skipped: 0,
      generated: { policies: 0, traces: 0, feedbacks: 0 },
    });
    assertClosureInvariants(report);
    expect(report.outcomes).toEqual([]);
    // Nothing to record: no ledger file is created for an empty run.
    await expect(readFile(migrationLedgerPath(target), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an unauthorized target vault before scan or report write', async () => {
    await mkdir(join(source, '07_System', 'Rules', 'Decision_Logic'), { recursive: true });
    await mkdir(join(source, '07_System', 'Logs', 'Decision_Traces'), { recursive: true });
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    try {
      const unauthorizedRoot = resolve(process.cwd(), '.test-decision-migration-unauthorized-vault');
      const unauthorizedCtx = createDecisionServiceContext(unauthorizedRoot);
      const reportPath = join(target, 'unauthorized-report.json');

      // An empty source (source_total=0) still rejects: the gate must not
      // depend on repository writes happening during the run.
      await expect(migrateLegacyDecisions(unauthorizedCtx, { sourceDir: source, reportPath }))
        .rejects.toThrow('Vault writes are disabled');
      // The rejection precedes the source scan: even an absent source
      // directory never reaches the scanner.
      await expect(migrateLegacyDecisions(unauthorizedCtx, {
        sourceDir: join(target, 'absent-source'),
        reportPath,
      })).rejects.toThrow('Vault writes are disabled');

      // The rejected run leaves neither a report nor a ledger behind.
      await expect(readFile(reportPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(migrationLedgerPath(unauthorizedRoot), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
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

  it('rejects a report path outside the authorized target vault before any write', async () => {
    await installFullSource(source);
    const outside = await mkdtemp(join(tmpdir(), 'atl-migration-outside-'));
    const dotdotReport = join(target, '..', 'atl-migration-dotdot-escape.json');
    try {
      // Absolute escape: a sibling temp directory, not the target vault.
      const outsideAbsolute = join(outside, 'absolute-report.json');
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: outsideAbsolute,
      })).rejects.toThrow(DecisionMigrationInvalidError);
      // `..` traversal inside an absolute path resolves outside the target.
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: dotdotReport,
      })).rejects.toThrow(DecisionMigrationInvalidError);
      // The gate precedes the source scan: even an absent source directory
      // rejects on the report boundary, not on the scanner.
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: join(target, 'absent-source'),
        reportPath: outsideAbsolute,
      })).rejects.toThrow(DecisionMigrationInvalidError);

      // Rejected runs leave the outside files and the target untouched: no
      // report anywhere, no native objects, no ledger.
      await expect(readFile(outsideAbsolute, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(dotdotReport, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(migrationLedgerPath(target), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(target, '07_System'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(dotdotReport, { force: true });
    }
  });

  it('rejects a report path whose symlinks resolve outside the target vault', async () => {
    await installFullSource(source);
    const outside = await mkdtemp(join(tmpdir(), 'atl-migration-outside-link-'));
    try {
      // Parent-directory symlink: lexically inside the target, resolves out.
      await symlink(outside, join(target, 'reports-link'));
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: join(target, 'reports-link', 'report.json'),
      })).rejects.toThrow(DecisionMigrationInvalidError);

      // File symlink: an inside-target link onto an existing outside file.
      const outsideFile = join(outside, 'existing-report.json');
      await writeFile(outsideFile, 'sentinel', 'utf8');
      await symlink(outsideFile, join(target, 'file-link-report.json'));
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: join(target, 'file-link-report.json'),
      })).rejects.toThrow(DecisionMigrationInvalidError);

      // The outside file keeps its bytes and no new file appears next to it.
      expect(await readFile(outsideFile, 'utf8')).toBe('sentinel');
      await expect(readFile(join(outside, 'report.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a report path that is a dangling symlink out of the target vault', async () => {
    await installFullSource(source);
    const outside = await mkdtemp(join(tmpdir(), 'atl-migration-outside-dangling-'));
    try {
      // File symlink whose target does not exist yet: the report write would
      // follow the link and create the outside file (CR round 2 probe).
      const danglingOutsideFile = join(outside, 'dangling-report.json');
      await symlink(danglingOutsideFile, join(target, 'dangling-report.json'));
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: join(target, 'dangling-report.json'),
      })).rejects.toThrow(DecisionMigrationInvalidError);

      // A dangling parent-directory symlink is the same escape one level up.
      await symlink(join(outside, 'missing-dir'), join(target, 'dangling-dir-link'));
      await expect(migrateLegacyDecisions(ctx, {
        sourceDir: source,
        reportPath: join(target, 'dangling-dir-link', 'report.json'),
      })).rejects.toThrow(DecisionMigrationInvalidError);

      // Zero outside writes: neither dangling target gets created, and the
      // rejected run leaves no native objects and no ledger behind.
      await expect(readFile(danglingOutsideFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(outside, 'missing-dir', 'report.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(migrationLedgerPath(target), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(target, '07_System'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes the report at a nested not-yet-existing path inside the target vault', async () => {
    await installFullSource(source);
    const nested = join(target, 'reports', 'run-001', 'report.json');

    const report = await migrateLegacyDecisions(ctx, { sourceDir: source, reportPath: nested });

    expect(report.migrated).toBe(4);
    const written = JSON.parse(await readFile(nested, 'utf8')) as MigrationReport;
    expect(written.run_id).toBe(report.run_id);
    expect(written.outcomes).toEqual(report.outcomes);
  });

  it('migrates a non-empty source into a non-temporary target with an explicit authorization', async () => {
    await installFullSource(source);
    const previousAllowRealWrites = process.env.ATL_ALLOW_REAL_WRITES;
    const previousConfiguredRoot = process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_VAULT_ROOT;
    try {
      const authorizedRoot = resolve(process.cwd(), '.test-decision-migration-authorized-vault');
      await rm(authorizedRoot, { recursive: true, force: true });
      // The target vault exists outside the OS temp root (repository subtree
      // creation assumes an existing vault root, like any real Vault).
      await mkdir(authorizedRoot, { recursive: true, mode: 0o700 });
      // The explicit token alone must authorize the non-temporary target:
      // neither the OS temp root nor the ATL_VAULT_ROOT env pair applies.
      const authorizedCtx = createDecisionServiceContext(authorizedRoot, {
        writeAuthorization: createVaultWriteAuthorization(authorizedRoot),
      });
      const reportPath = join(authorizedRoot, 'migration-report.json');

      const report = await migrateLegacyDecisions(authorizedCtx, {
        sourceDir: source,
        reportPath,
      });

      // The authorized run completes the full non-empty migration instead of
      // rejecting at the preflight or the ledger append.
      expect(report).toMatchObject({
        source_root: source,
        source_total: 6,
        migrated: 4,
        duplicate: 0,
        conflict: 0,
        failed: 1,
        skipped: 1,
        failed_write_failed: 0,
        generated: { policies: 2, traces: 2, feedbacks: 2 },
      });
      assertClosureInvariants(report);

      // Native objects land in the non-temporary target vault.
      expect(await countMarkdownFiles(authorizedRoot, 'Rules/Decision_Logic')).toBe(2);
      expect(await countMarkdownFiles(authorizedRoot, 'Logs/Decision_Traces')).toBe(2);
      expect(await countMarkdownFiles(authorizedRoot, 'Logs/Decision_Feedback')).toBe(2);
      expect(await authorizedCtx.policies.get(`${LEGACY_POLICY_INPUT}@v001`)).not.toBeNull();
      expect(await authorizedCtx.traces.get(DT_FEEDBACK)).toMatchObject({
        status: 'feedback_recorded',
        feedback_count: 1,
      });
      expect(await authorizedCtx.feedback.listByTrace(DT_FEEDBACK)).toHaveLength(1);

      // The reconciliation report is written inside the authorized target.
      const written = JSON.parse(await readFile(reportPath, 'utf8')) as MigrationReport;
      expect(written.source_total).toBe(report.source_total);
      expect(written.outcomes).toEqual(report.outcomes);

      // The ledger append also runs under the explicit authorization.
      const entries = await readMigrationLedger(authorizedRoot);
      expect(entries.filter((entry) => entry.status === 'migrated')).toHaveLength(6);
      expect(entries.filter((entry) => entry.kind === 'feedback')).toHaveLength(2);
      expect(entries.filter((entry) => entry.source_path === TRACE_SOURCE_PATH)
        .map((entry) => entry.kind).sort()).toEqual(['feedback', 'trace']);
    } finally {
      await rm(resolve(process.cwd(), '.test-decision-migration-authorized-vault'),
        { recursive: true, force: true });
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

  it('fails the owning trace outcome when embedded feedback persistence fails', async () => {
    const mixed = await mkdtemp(join(tmpdir(), 'atl-migration-fault-'));
    try {
      await installMixedLegacy(mixed);
      const baseCtx = createDecisionServiceContext(mixed);
      const fault = Object.assign(new Error('Synthetic embedded feedback write failure'), {
        code: 'synthetic_write_failed',
      });
      const faultedCtx: DecisionServiceContext = {
        ...baseCtx,
        feedback: {
          createOrGet: async () => {
            throw fault;
          },
          listByTrace: (traceId: string) => baseCtx.feedback.listByTrace(traceId),
          listForAggregation: (filter?: FeedbackAggregationFilter) =>
            baseCtx.feedback.listForAggregation(filter),
        },
      };

      const report = await migrateLegacyDecisions(faultedCtx, {
        sourceDir: mixed,
        reportPath: join(mixed, 'fault-report.json'),
      });

      // The trace source flips from migrated to failed(write_failed) so all
      // three closure invariants keep holding under fault injection.
      expect(report).toMatchObject({
        source_total: 2,
        parseable: 2,
        migrated: 1,
        duplicate: 0,
        conflict: 0,
        failed: 1,
        skipped: 0,
        failed_write_failed: 1,
        generated: { policies: 1, traces: 1, feedbacks: 0 },
      });
      assertClosureInvariants(report);
      expect(outcomeFor(report, TRACE_SOURCE_PATH)).toMatchObject({
        kind: 'trace',
        status: 'failed',
        native_id: DT_FEEDBACK,
        legacy_id: LEGACY_FEEDBACK_ID,
        detail: 'write_failed',
        error_code: 'synthetic_write_failed',
      });

      // The ledger never claims a fully migrated trace whose required
      // embedded feedback failed.
      const entries = await readMigrationLedger(mixed);
      const traceLedgerRows = entries.filter((row) => row.source_path === TRACE_SOURCE_PATH
        && row.kind === 'trace');
      expect(traceLedgerRows).toHaveLength(1);
      expect(traceLedgerRows[0]).toMatchObject({ status: 'failed', detail: 'write_failed' });
      const feedbackLedgerRows = entries.filter((row) => row.kind === 'feedback');
      expect(feedbackLedgerRows).toHaveLength(1);
      expect(feedbackLedgerRows[0]).toMatchObject({
        status: 'failed',
        detail: 'write_failed',
        native_id: FB_FEEDBACK,
      });

      // Partial native object semantics: the trace exists without its
      // embedded feedback sample.
      expect(await baseCtx.traces.get(DT_FEEDBACK)).not.toBeNull();
      expect(await baseCtx.feedback.listByTrace(DT_FEEDBACK)).toEqual([]);

      // A rerun with a healthy context hits the ledger idempotency key and
      // does not auto-retry the failed feedback write (documented semantics).
      const rerun = await migrateLegacyDecisions(baseCtx, {
        sourceDir: mixed,
        reportPath: join(mixed, 'fault-report-2.json'),
      });
      expect(rerun).toMatchObject({ duplicate: 2, migrated: 0 });
      expect(await baseCtx.feedback.listByTrace(DT_FEEDBACK)).toEqual([]);
    } finally {
      await rm(mixed, { recursive: true, force: true });
    }
  });
});
