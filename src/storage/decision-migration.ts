import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ulid } from 'ulid';

import {
  FEEDBACK_KINDS,
  deterministicFeedbackId,
  type FeedbackKind,
  type FeedbackSample,
} from '../domain/decision-feedback.js';
import type { DecisionPolicy } from '../domain/decision-policy.js';
import {
  deriveFeedbackSummary,
  type DecisionTrace,
} from '../domain/decision-trace.js';
import type { DecisionFeedbackRepository } from './markdown-decision-feedback-repository.js';
import type { PolicyRef } from './markdown-decision-policy-repository.js';
import type { DecisionTraceRepository } from './markdown-decision-trace-repository.js';
import {
  LEGACY_CREATED_AT_SENTINEL,
  scanDecisionTrees,
  type LegacyPolicyProjection,
  type LegacyTraceProjection,
} from './decision-legacy-adapter.js';
import {
  appendMigrationEntries,
  readMigrationLedger,
  type MigrationLedgerEntry,
  type MigrationLedgerKind,
  type MigrationLedgerStatus,
} from './decision-migration-ledger.js';
import {
  assertVaultWriteAllowed,
  vaultRoot,
  type VaultWriteAuthorization,
} from './task-paths.js';

/**
 * Safe legacy migration with ledger reconciliation (Task 6, D8/D12): reads a
 * legacy source vault through the read-only adapter, creates native objects
 * with deterministic ids, and records every source outcome in the T5 ledger.
 * Source files are never mutated; reruns hit the `(source_path,
 * source_sha256)` idempotency key and produce zero new objects.
 *
 * Partial native object semantics: when an embedded feedback write fails
 * after its native trace was created, the trace stays as a partial native
 * object (traces and samples are immutable, so there is no rollback) while
 * the owning source outcome and ledger row say `failed(write_failed)` — the
 * ledger never claims a fully migrated trace. A rerun of the same bytes hits
 * the idempotency key as `duplicate` and does not retry the failed feedback
 * write; completing it is an operator action (ledger correction or the T4
 * consistency repair path), not an automatic one.
 */
export interface MigrationServiceContext {
  vaultRoot: string;
  clock: () => Date;
  policies: { get(ref: PolicyRef): Promise<DecisionPolicy | null> } & {
    create(policy: unknown): Promise<DecisionPolicy>;
  };
  traces: DecisionTraceRepository;
  feedback: DecisionFeedbackRepository;
  /**
   * The caller's explicit Vault write authorization. The preflight and the
   * ledger append are migration-level writes that bypass the repositories,
   * so the token must ride on the context to reach both gates.
   */
  writeAuthorization?: VaultWriteAuthorization;
}

export interface MigrateLegacyDecisionsInput {
  /** Root of the legacy vault to scan (its `07_System` decision subtrees). */
  sourceDir: string;
  /** Where the JSON reconciliation report is written. */
  reportPath: string;
}

export interface MigrationOutcome {
  source_path: string;
  kind: MigrationLedgerKind;
  status: MigrationLedgerStatus;
  native_id: string;
  legacy_id?: string;
  /** Binary failure diagnosis: `unparseable` or `write_failed` (M2). */
  detail?: string;
  /** Underlying repository error code for `write_failed` outcomes. */
  error_code?: string;
}

export interface MigrationReport {
  run_id: string;
  at: string;
  source_root: string;
  source_total: number;
  parseable: number;
  migrated: number;
  duplicate: number;
  conflict: number;
  failed: number;
  skipped: number;
  failed_unparseable: number;
  failed_write_failed: number;
  generated: { policies: number; traces: number; feedbacks: number };
  missing_or_conflict_refs: number;
  outcomes: MigrationOutcome[];
}

export class DecisionMigrationInvalidError extends Error {
  readonly code = 'decision_migration_invalid';

  constructor() {
    super('Invalid legacy decision migration input');
    this.name = 'DecisionMigrationInvalidError';
  }
}

const POLICY_TREE_PREFIX = '07_System/Rules/Decision_Logic/';
const LEGACY_FEEDBACK_IDEMPOTENCY_KEY = 'legacy-feedback';
const POLICY_BODY_PROVENANCE_SOURCE = 'legacy-body';

interface MigrationCandidate {
  sourcePath: string;
  absolutePath: string;
  sourceSha256: string;
  kind: 'policy' | 'trace';
  classification:
    | { type: 'policy'; projection: LegacyPolicyProjection }
    | { type: 'trace'; projection: LegacyTraceProjection }
    | { type: 'unparseable' };
}

interface LedgerLookup {
  hit: MigrationLedgerEntry | null;
  pathRows: MigrationLedgerEntry[];
}

interface MigrationCounters {
  parseable: number;
  failedUnparseable: number;
  failedWriteFailed: number;
  missingOrConflictRefs: number;
  generatedPolicies: number;
  generatedTraces: number;
  generatedFeedbacks: number;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** List items grouped under `## <Section>` headings in a document body. */
function parseBodySections(raw: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of raw.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      current = heading[1] ?? null;
      if (current !== null && !sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    if (current === null) {
      continue;
    }
    const item = /^\s*-\s+(.+?)\s*$/u.exec(line);
    if (item !== null) {
      sections.get(current)?.push(item[1] ?? '');
    }
  }
  return sections;
}

/**
 * Native policy assembly from a legacy projection. Frontmatter keeps identity,
 * status, dimension, question, sources and review date; the native-only
 * content fields come from the legacy body sections, which is where the
 * harness rendered them. Only `rationale` has no legacy source at all and
 * carries an explicit provenance statement instead of an invented reason.
 */
function assembleLegacyPolicy(
  projection: LegacyPolicyProjection,
  sections: Map<string, string[]>,
  sourcePath: string,
): { policy: DecisionPolicy } | { missing: string } {
  const inputs = sections.get('Inputs') ?? [];
  const rules = sections.get('Rules') ?? [];
  const outputs = sections.get('Outputs') ?? [];
  const metrics = sections.get('Metrics') ?? [];
  if (projection.sources.length === 0) {
    return { missing: 'sources' };
  }
  if (inputs.length === 0) {
    return { missing: 'inputs' };
  }
  if (rules.length === 0) {
    return { missing: 'rules' };
  }
  if (outputs.length === 0) {
    return { missing: 'outputs' };
  }
  if (metrics.length === 0) {
    return { missing: 'metrics' };
  }
  if (projection.next_review_at === null) {
    return { missing: 'next_review_at' };
  }
  const policy: DecisionPolicy = {
    policy_id: projection.policy_id,
    version: projection.version,
    status: projection.status,
    dimension: projection.dimension,
    decision_question: projection.decision_question,
    inputs: inputs.map((name) => ({ name, source: POLICY_BODY_PROVENANCE_SOURCE })),
    sources: [...projection.sources],
    rules: rules.map((statement) => ({ statement })),
    exceptions: [...(sections.get('Exceptions') ?? [])],
    outputs: [...outputs],
    rationale: `Migrated from legacy policy document ${sourcePath}; `
      + 'the legacy format carries no rationale section.',
    examples: [],
    counterexamples: [],
    metrics: [...metrics],
    next_review_at: projection.next_review_at,
    created_at: LEGACY_CREATED_AT_SENTINEL,
    status_history: [],
  };
  return { policy };
}

/** M1 companion: a legacy trace missing a native-required field is skipped,
 * never defaulted — the query keeps projecting it as `legacy_compatible`. */
function traceMissingField(projection: LegacyTraceProjection): string | null {
  if (projection.input_refs === null || projection.input_refs.length === 0) {
    return 'input_refs';
  }
  if (projection.confidence === null) {
    return 'confidence';
  }
  if (projection.evidence_refs.length === 0) {
    return 'evidence_refs';
  }
  if (projection.reasoning_summary.trim() === '') {
    return 'reasoning_summary';
  }
  return null;
}

function embeddedFeedbackKind(projection: LegacyTraceProjection): FeedbackKind | null {
  return FEEDBACK_KINDS.includes(projection.user_feedback as FeedbackKind)
    ? projection.user_feedback as FeedbackKind
    : null;
}

function legacyHasEmbeddedFeedback(projection: LegacyTraceProjection): boolean {
  return projection.user_feedback !== 'unreviewed' || projection.history.length > 0;
}

/**
 * Embedded feedback sample for a migrated trace (D8): the deterministic
 * `fb_<sha20(trace_id + ':legacy-feedback')>` id, legacy data only — the
 * correction record is the frontmatter history, falling back to the body's
 * `## Decision history` section where the harness rendered it.
 */
function assembleEmbeddedFeedback(
  projection: LegacyTraceProjection,
  nativeTraceId: string,
  bodyHistory: string[],
): { sample: FeedbackSample } | { missing: string } {
  const kind = embeddedFeedbackKind(projection);
  if (kind === null) {
    return { missing: 'kind' };
  }
  let correctionSummary: string | null = null;
  if (kind === 'corrected') {
    const history = projection.history.length > 0
      ? projection.history
      : bodyHistory;
    correctionSummary = history.length > 0 ? history.join(' | ') : null;
    if (correctionSummary === null) {
      return { missing: 'correction_summary' };
    }
  }
  const sample: FeedbackSample = {
    feedback_id: deterministicFeedbackId(nativeTraceId, LEGACY_FEEDBACK_IDEMPOTENCY_KEY),
    trace_id: nativeTraceId,
    kind,
    stability: 'unknown',
    correction_summary: correctionSummary,
    final_outcome: projection.final_outcome,
    created_at: projection.created_at,
    source_ref: projection.source_path,
    idempotency_key: LEGACY_FEEDBACK_IDEMPOTENCY_KEY,
    policy_ref: projection.policy_ref,
  };
  return { sample };
}

function lookupLedger(
  entries: MigrationLedgerEntry[],
  candidate: MigrationCandidate,
): LedgerLookup {
  // A trace source also emits embedded-feedback rows under the same path, so
  // both the idempotency hit and the conflict identity stay kind-scoped.
  const pathRows = entries.filter((entry) => entry.source_path === candidate.sourcePath);
  const kindRows = pathRows.filter((entry) => entry.kind === candidate.kind);
  return {
    hit: kindRows.find((entry) => entry.source_sha256 === candidate.sourceSha256)
      ?? pathRows.find((entry) => entry.source_sha256 === candidate.sourceSha256)
      ?? null,
    pathRows: kindRows.length > 0 ? kindRows : pathRows,
  };
}

function projectionLegacyId(candidate: MigrationCandidate): string | undefined {
  return candidate.classification.type === 'trace'
    ? candidate.classification.projection.legacy_id
    : undefined;
}

function legacyIdField(legacyId: string | undefined): { legacy_id?: string } {
  return legacyId === undefined ? {} : { legacy_id: legacyId };
}

function errorCodeField(error: unknown): { error_code?: string } {
  return error instanceof Error && 'code' in error
    ? { error_code: String((error as { code?: string }).code) }
    : {};
}

async function collectCandidates(sourceRoot: string): Promise<MigrationCandidate[]> {
  const scan = await scanDecisionTrees(sourceRoot);
  const policyCandidates: Array<{ path: string; projection: LegacyPolicyProjection }> = [];
  const traceCandidates: Array<{ path: string; projection: LegacyTraceProjection }> = [];
  const unparseablePaths: string[] = [];
  for (const entry of scan.policies) {
    if (entry.source === 'legacy') {
      policyCandidates.push({ path: toPosix(entry.path), projection: entry.projection });
    }
  }
  for (const entry of scan.traces) {
    if (entry.source === 'legacy') {
      traceCandidates.push({ path: toPosix(entry.path), projection: entry.projection });
    }
  }
  for (const entry of scan.unparseable) {
    unparseablePaths.push(toPosix(entry.path));
  }
  const candidates: MigrationCandidate[] = [];
  for (const entry of [...policyCandidates]
    .sort((left, right) => left.path.localeCompare(right.path))) {
    const raw = await readFile(join(sourceRoot, entry.path), 'utf8');
    candidates.push({
      sourcePath: entry.path,
      absolutePath: join(sourceRoot, entry.path),
      sourceSha256: sha256Hex(raw),
      kind: 'policy',
      classification: { type: 'policy', projection: entry.projection },
    });
  }
  const traceTree = [
    ...traceCandidates.map((entry) => ({ path: entry.path, projection: entry.projection })),
    ...unparseablePaths
      .filter((path) => !path.startsWith(POLICY_TREE_PREFIX))
      .map((path) => ({ path, projection: null })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of traceTree) {
    const raw = await readFile(join(sourceRoot, entry.path), 'utf8');
    candidates.push({
      sourcePath: entry.path,
      absolutePath: join(sourceRoot, entry.path),
      sourceSha256: sha256Hex(raw),
      kind: 'trace',
      classification: entry.projection === null
        ? { type: 'unparseable' }
        : { type: 'trace', projection: entry.projection },
    });
  }
  // Unparseable files under the policy tree still belong to the policy phase.
  for (const path of unparseablePaths.filter((item) => item.startsWith(POLICY_TREE_PREFIX))) {
    const raw = await readFile(join(sourceRoot, path), 'utf8');
    candidates.push({
      sourcePath: path,
      absolutePath: join(sourceRoot, path),
      sourceSha256: sha256Hex(raw),
      kind: 'policy',
      classification: { type: 'unparseable' },
    });
  }
  return candidates;
}

function countByStatus(outcomes: MigrationOutcome[], status: MigrationLedgerStatus): number {
  return outcomes.filter((outcome) => outcome.status === status).length;
}

/** lstat-based existence probe: unlike existsSync it never follows the final
 * symlink, so a dangling link still counts as an existing directory entry
 * instead of masquerading as an absent tail component. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Canonical form of a path whose tail may not exist yet: resolve the
 * deepest existing ancestor through symlinks, then re-append the tail, so
 * symlinked parents land on their real location. Because existence is probed
 * with lstat, a symlinked tail (even a dangling one) stays an existing
 * entry, so realpathSync — not the re-appended lexical name — decides where
 * it lands, and a dangling link makes the canonicalization itself fail. */
function canonicalizePotentialPath(path: string): string {
  let existingParent = resolve(path);
  const missingSegments: string[] = [];
  while (!pathEntryExists(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) {
      break;
    }
    missingSegments.unshift(basename(existingParent));
    existingParent = parent;
  }
  return resolve(realpathSync(existingParent), ...missingSegments);
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

/**
 * Reconciliation-report boundary (Task 7 CR): the report write is a
 * migration-level write that bypasses the repositories, so — like the vault
 * preflight and the ledger append — it must land inside the canonical
 * authorized target vault. Absolute escapes, `..` traversal, and any report
 * path or parent symlink resolving outside the target reject under the
 * migration validation contract before the run touches the source, the
 * ledger, or the outside file. A dangling symlink anywhere on the report
 * path rejects the same way (Task 7 CR round 2): lstat keeps it an existing
 * entry, so canonicalization fails instead of re-appending the link name
 * inside the vault — the report write must never follow a link whose target
 * does not provably sit inside the authorized vault.
 */
function assertReportPathWithinVault(targetRoot: string, reportPath: string): void {
  let canonicalRoot: string;
  let canonicalReport: string;
  try {
    canonicalRoot = canonicalizePotentialPath(targetRoot);
    canonicalReport = canonicalizePotentialPath(reportPath);
  } catch {
    throw new DecisionMigrationInvalidError();
  }
  if (!isWithin(canonicalRoot, canonicalReport)) {
    throw new DecisionMigrationInvalidError();
  }
}

async function writeReportFile(reportPath: string, report: MigrationReport): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function rowFor(
  base: { runId: string; at: string },
  candidate: MigrationCandidate,
  status: MigrationLedgerStatus,
  nativeId: string,
  detail?: string,
): MigrationLedgerEntry {
  return {
    run_id: base.runId,
    at: base.at,
    source_path: candidate.sourcePath,
    source_sha256: candidate.sourceSha256,
    kind: candidate.kind,
    native_id: nativeId,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

async function migratePolicyCandidate(
  ctx: MigrationServiceContext,
  candidate: MigrationCandidate,
  projection: LegacyPolicyProjection,
  rows: MigrationLedgerEntry[],
  outcomes: MigrationOutcome[],
  counters: MigrationCounters,
  base: { runId: string; at: string },
): Promise<void> {
  const nativeId = `${projection.policy_id}@${projection.version}`;
  const raw = await readFile(candidate.absolutePath, 'utf8');
  const assembled = assembleLegacyPolicy(projection, parseBodySections(raw), candidate.sourcePath);
  if ('missing' in assembled) {
    rows.push(rowFor(base, candidate, 'skipped', nativeId, `missing_required_field:${assembled.missing}`));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'policy',
      status: 'skipped',
      native_id: nativeId,
      detail: `missing_required_field:${assembled.missing}`,
    });
    return;
  }
  try {
    await ctx.policies.create(assembled.policy);
  } catch (error) {
    counters.failedWriteFailed += 1;
    rows.push(rowFor(base, candidate, 'failed', nativeId, 'write_failed'));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'policy',
      status: 'failed',
      native_id: nativeId,
      detail: 'write_failed',
      ...errorCodeField(error),
    });
    return;
  }
  counters.generatedPolicies += 1;
  rows.push(rowFor(base, candidate, 'migrated', nativeId));
  outcomes.push({
    source_path: candidate.sourcePath,
    kind: 'policy',
    status: 'migrated',
    native_id: nativeId,
  });
}

/** Structured embedded-feedback persistence result for the owning trace. */
type EmbeddedFeedbackResult =
  | { status: 'skipped' }
  | { status: 'recorded' }
  | { status: 'failed'; error: unknown };

async function migrateEmbeddedFeedback(
  ctx: MigrationServiceContext,
  candidate: MigrationCandidate,
  projection: LegacyTraceProjection,
  nativeTrace: DecisionTrace,
  rows: MigrationLedgerEntry[],
  counters: MigrationCounters,
  base: { runId: string; at: string },
): Promise<EmbeddedFeedbackResult> {
  const raw = await readFile(candidate.absolutePath, 'utf8');
  const bodyHistory = parseBodySections(raw).get('Decision history') ?? [];
  const assembled = assembleEmbeddedFeedback(projection, nativeTrace.trace_id, bodyHistory);
  const feedbackRow = (status: MigrationLedgerStatus, detail?: string): MigrationLedgerEntry => ({
    run_id: base.runId,
    at: base.at,
    source_path: candidate.sourcePath,
    source_sha256: candidate.sourceSha256,
    kind: 'feedback',
    native_id: deterministicFeedbackId(nativeTrace.trace_id, LEGACY_FEEDBACK_IDEMPOTENCY_KEY),
    status,
    ...(detail === undefined ? {} : { detail }),
  });
  if ('missing' in assembled) {
    rows.push(feedbackRow('skipped', `missing_required_field:${assembled.missing}`));
    return { status: 'skipped' };
  }
  try {
    const { sample, created } = await ctx.feedback.createOrGet(assembled.sample);
    if (created) {
      counters.generatedFeedbacks += 1;
    }
    await ctx.traces.updateFeedbackSummary(
      nativeTrace.trace_id,
      deriveFeedbackSummary([sample], nativeTrace),
    );
    rows.push(feedbackRow(created ? 'migrated' : 'duplicate'));
    return { status: 'recorded' };
  } catch (error) {
    counters.failedWriteFailed += 1;
    rows.push(feedbackRow('failed', 'write_failed'));
    return { status: 'failed', error };
  }
}

async function migrateTraceCandidate(
  ctx: MigrationServiceContext,
  candidate: MigrationCandidate,
  projection: LegacyTraceProjection,
  rows: MigrationLedgerEntry[],
  outcomes: MigrationOutcome[],
  counters: MigrationCounters,
  base: { runId: string; at: string },
): Promise<void> {
  const nativeId = projection.native_id;
  const missingField = traceMissingField(projection);
  if (missingField !== null) {
    rows.push(rowFor(base, candidate, 'skipped', nativeId, `missing_required_field:${missingField}`));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'trace',
      status: 'skipped',
      native_id: nativeId,
      legacy_id: projection.legacy_id,
      detail: `missing_required_field:${missingField}`,
    });
    return;
  }
  const policy = await ctx.policies.get(projection.policy_ref as PolicyRef);
  if (policy === null || policy.dimension !== projection.dimension) {
    counters.missingOrConflictRefs += 1;
    const detail = `missing_or_conflict_ref:${projection.policy_ref}`;
    rows.push(rowFor(base, candidate, 'skipped', nativeId, detail));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'trace',
      status: 'skipped',
      native_id: nativeId,
      legacy_id: projection.legacy_id,
      detail,
    });
    return;
  }
  let nativeTrace: DecisionTrace;
  try {
    nativeTrace = await ctx.traces.create({
      trace_id: nativeId,
      policy_ref: projection.policy_ref,
      dimension: projection.dimension,
      input_refs: [...projection.input_refs ?? []],
      decision: projection.decision,
      reasoning_summary: projection.reasoning_summary,
      evidence_refs: [...projection.evidence_refs],
      confidence: projection.confidence,
      created_at: projection.created_at,
    }, { policyResolver: async () => policy });
  } catch (error) {
    counters.failedWriteFailed += 1;
    rows.push(rowFor(base, candidate, 'failed', nativeId, 'write_failed'));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'trace',
      status: 'failed',
      native_id: nativeId,
      legacy_id: projection.legacy_id,
      detail: 'write_failed',
      ...errorCodeField(error),
    });
    return;
  }
  counters.generatedTraces += 1;
  const embedded = legacyHasEmbeddedFeedback(projection)
    ? await migrateEmbeddedFeedback(
      ctx,
      candidate,
      projection,
      nativeTrace,
      rows,
      counters,
      base,
    )
    : null;
  if (embedded !== null && embedded.status === 'failed') {
    // The required embedded feedback did not persist: the owning trace
    // source outcome and its ledger row say failed(write_failed) with the
    // underlying error code, never migrated. The already-created trace
    // stays as a partial native object (see module comment for the
    // documented no-auto-retry rerun semantics).
    rows.push(rowFor(base, candidate, 'failed', nativeId, 'write_failed'));
    outcomes.push({
      source_path: candidate.sourcePath,
      kind: 'trace',
      status: 'failed',
      native_id: nativeId,
      legacy_id: projection.legacy_id,
      detail: 'write_failed',
      ...errorCodeField(embedded.error),
    });
    return;
  }
  rows.push(rowFor(base, candidate, 'migrated', nativeId));
  outcomes.push({
    source_path: candidate.sourcePath,
    kind: 'trace',
    status: 'migrated',
    native_id: nativeId,
    legacy_id: projection.legacy_id,
  });
}

/**
 * Scans the legacy source vault, migrates every legacy candidate into the
 * context vault (policies first so trace references resolve natively), appends
 * one ledger row per source outcome plus embedded-feedback rows, and writes
 * the JSON reconciliation report. The three closure invariants hold by
 * construction: every source file gets exactly one of the five statuses.
 */
export async function migrateLegacyDecisions(
  ctx: MigrationServiceContext,
  input: MigrateLegacyDecisionsInput,
): Promise<MigrationReport> {
  if (typeof input?.sourceDir !== 'string' || input.sourceDir.trim() === ''
    || typeof input?.reportPath !== 'string' || input.reportPath.trim() === '') {
    throw new DecisionMigrationInvalidError();
  }
  const sourceRoot = vaultRoot(input.sourceDir);
  // Target-vault authorization preflight (frozen Task 6): the gate runs
  // before the source scan, so an unauthorized run rejects without touching
  // the source, the ledger, or the report — even when the source holds no
  // candidates and no repository write would ever trigger the per-write gate.
  assertVaultWriteAllowed(ctx.vaultRoot, ctx.writeAuthorization);
  // The report is the one migration write aimed at a caller-supplied path,
  // so its boundary gets its own pre-scan gate (Task 7 CR).
  assertReportPathWithinVault(ctx.vaultRoot, input.reportPath);
  const candidates = await collectCandidates(sourceRoot);
  const ledger = await readMigrationLedger(ctx.vaultRoot);
  const at = ctx.clock().toISOString();
  const runId = `mig_${ulid(ctx.clock().getTime()).toLowerCase()}`;
  const rows: MigrationLedgerEntry[] = [];
  const outcomes: MigrationOutcome[] = [];
  const counters: MigrationCounters = {
    parseable: 0,
    failedUnparseable: 0,
    failedWriteFailed: 0,
    missingOrConflictRefs: 0,
    generatedPolicies: 0,
    generatedTraces: 0,
    generatedFeedbacks: 0,
  };
  const base = { runId, at };

  for (const candidate of candidates) {
    const { hit, pathRows } = lookupLedger(ledger, candidate);
    if (hit !== null) {
      // Idempotency key hit (any status): the exact bytes were processed.
      rows.push(rowFor(base, candidate, 'duplicate', hit.native_id));
      outcomes.push({
        source_path: candidate.sourcePath,
        kind: candidate.kind,
        status: 'duplicate',
        native_id: hit.native_id,
        ...legacyIdField(projectionLegacyId(candidate)),
      });
      continue;
    }
    if (pathRows.length > 0) {
      const conflictNativeId = pathRows.at(-1)?.native_id ?? '';
      const detail = `sha_mismatch:${candidate.sourceSha256.slice(0, 12)}`;
      rows.push(rowFor(base, candidate, 'conflict', conflictNativeId, detail));
      outcomes.push({
        source_path: candidate.sourcePath,
        kind: candidate.kind,
        status: 'conflict',
        native_id: conflictNativeId,
        ...legacyIdField(projectionLegacyId(candidate)),
        detail,
      });
      continue;
    }
    if (candidate.classification.type === 'unparseable') {
      counters.failedUnparseable += 1;
      const nativeId = `unparsed_${sha256Hex(`${candidate.sourcePath}:${candidate.sourceSha256}`).slice(0, 20)}`;
      rows.push(rowFor(base, candidate, 'failed', nativeId, 'unparseable'));
      outcomes.push({
        source_path: candidate.sourcePath,
        kind: candidate.kind,
        status: 'failed',
        native_id: nativeId,
        detail: 'unparseable',
      });
      continue;
    }
    counters.parseable += 1;
    if (candidate.classification.type === 'policy') {
      await migratePolicyCandidate(
        ctx,
        candidate,
        candidate.classification.projection,
        rows,
        outcomes,
        counters,
        base,
      );
      continue;
    }
    await migrateTraceCandidate(
      ctx,
      candidate,
      candidate.classification.projection,
      rows,
      outcomes,
      counters,
      base,
    );
  }

  if (rows.length > 0) {
    // The ledger append re-checks authorization independent of the
    // repositories, so it needs the same explicit token as the preflight
    // (exactOptionalPropertyTypes forbids passing an explicit undefined).
    await appendMigrationEntries(ctx.vaultRoot, rows, ctx.writeAuthorization === undefined
      ? {}
      : { writeAuthorization: ctx.writeAuthorization });
  }

  const report: MigrationReport = {
    run_id: runId,
    at,
    source_root: sourceRoot,
    source_total: outcomes.length,
    parseable: counters.parseable,
    migrated: countByStatus(outcomes, 'migrated'),
    duplicate: countByStatus(outcomes, 'duplicate'),
    conflict: countByStatus(outcomes, 'conflict'),
    failed: countByStatus(outcomes, 'failed'),
    skipped: countByStatus(outcomes, 'skipped'),
    failed_unparseable: counters.failedUnparseable,
    failed_write_failed: counters.failedWriteFailed,
    generated: {
      policies: counters.generatedPolicies,
      traces: counters.generatedTraces,
      feedbacks: counters.generatedFeedbacks,
    },
    missing_or_conflict_refs: counters.missingOrConflictRefs,
    outcomes,
  };
  await writeReportFile(input.reportPath, report);
  return report;
}
