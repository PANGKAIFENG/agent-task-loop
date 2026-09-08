import { z } from 'zod';

import { FEEDBACK_STABILITY, type FeedbackStability } from '../domain/decision-feedback.js';
import {
  DECISION_DIMENSIONS,
  POLICY_STATUSES,
  type DecisionDimension,
  type PolicyStatus,
} from '../domain/decision-policy.js';
import {
  TRACE_STATUSES,
  USER_FEEDBACK,
  type DecisionTrace,
  type TraceStatus,
  type UserFeedback,
} from '../domain/decision-trace.js';
import {
  scanDecisionTrees,
  type BrokenNativeTraceDocument,
  type LegacyTraceProjection,
  type ScannedPolicyDocument,
  type ScannedTraceDocument,
} from '../storage/decision-legacy-adapter.js';
import {
  isMigratedNativeId,
  readMigrationLedgerDetailed,
  type MigrationLedgerEntry,
} from '../storage/decision-migration-ledger.js';
import { vaultRoot } from '../storage/task-paths.js';

/**
 * Unified read-only decision query (PRD frozen contract, D7/D12): merges
 * native traces with legacy projections, joins policy status, classifies
 * integrity (M1: `broken` is native-only), computes facets over the full
 * filtered set, pages over the total order `[created_at, trace_id]`, and
 * deduplicates already-migrated legacy rows against the migration ledger
 * (key `native_id + kind + status='migrated'`, reader injectable) while
 * carrying the deduped projection's `legacy_id` onto the native row.
 */
export const INTEGRITY_STATUSES = ['valid', 'legacy_compatible', 'warning', 'broken'] as const;
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

export const DECISION_SORTS = ['created_desc', 'created_asc'] as const;
export type DecisionSort = (typeof DECISION_SORTS)[number];

export const DECISION_FACET_KEYS = [
  'dimension',
  'policy_status',
  'trace_status',
  'feedback_kind',
  'integrity_status',
  'source',
] as const;
export type DecisionFacetKey = (typeof DECISION_FACET_KEYS)[number];

/** Version of this query projection contract. */
export const DECISION_PROJECTION_SCHEMA_VERSION = 'v1';

export type DecisionQuery = z.input<typeof decisionQuerySchema>;

const decisionQuerySchema = z.object({
  dimension: z.enum(DECISION_DIMENSIONS).optional(),
  policyId: z.string().trim().min(1).max(300).optional(),
  policyVersion: z.string().regex(/^v\d{3}$/u).optional(),
  policyStatus: z.enum(POLICY_STATUSES).optional(),
  traceStatus: z.enum(TRACE_STATUSES).optional(),
  feedbackKind: z.enum(USER_FEEDBACK).optional(),
  stability: z.enum(FEEDBACK_STABILITY).optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  refs: z.array(z.string().trim().min(1).max(500)).min(1).optional(),
  integrityStatus: z.enum(INTEGRITY_STATUSES).optional(),
  source: z.enum(['native', 'legacy']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1000).optional(),
  sort: z.enum(DECISION_SORTS).default('created_desc'),
}).strict();

export interface DecisionTraceItem {
  trace_id: string;
  policy_ref: string;
  dimension: DecisionDimension | null;
  input_refs: string[];
  decision: string;
  reasoning_summary: string;
  evidence_refs: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  user_feedback: UserFeedback;
  final_outcome: string;
  trace_status: TraceStatus;
  created_at: string;
  policy_status: PolicyStatus | null;
  schema_version: string;
  source: 'native' | 'legacy';
  integrity_status: IntegrityStatus;
  legacy_id?: string;
}

export type DecisionFacets = Record<DecisionFacetKey, Record<string, number>>;

export interface DecisionQueryWarning {
  code: string;
  trace_id?: string;
  detail: string;
}

export interface DecisionProjection {
  items: DecisionTraceItem[];
  facets: DecisionFacets;
  next_cursor: string | null;
  warnings: DecisionQueryWarning[];
}

export interface QueryContext {
  /** Vault root; falls back to `ATL_VAULT_ROOT` like the repositories. */
  root?: string;
}

export interface QueryDecisionsDeps {
  /** Injected ledger entries; defaults to reading the vault ledger (D12). */
  ledgerEntries?: MigrationLedgerEntry[];
  /**
   * Latest-sample stability lookup. Zero-feedback traces derive `unknown`;
   * non-unknown values resolve through this seam (wired to the feedback
   * repository at final assembly; M1: the query never fabricates one).
   */
  feedbackStabilityByTrace?: (candidate: { trace_id: string; feedback_count: number }) =>
    FeedbackStability | undefined;
}

export class DecisionQueryInvalidError extends Error {
  readonly code = 'decision_query_invalid';

  constructor(message = 'Invalid decision query') {
    super(message);
    this.name = 'DecisionQueryInvalidError';
  }
}

interface PolicyIndexEntry {
  status: PolicyStatus;
  dimension: DecisionDimension;
}

interface TraceRow {
  item: DecisionTraceItem;
  feedbackCount: number;
  warnings: DecisionQueryWarning[];
}

interface CursorKey {
  createdAt: string;
  traceId: string;
}

type ValidatedQuery = z.infer<typeof decisionQuerySchema>;

function buildPolicyIndex(
  policies: ScannedPolicyDocument[],
  ledgerEntries: MigrationLedgerEntry[],
): Map<string, PolicyIndexEntry> {
  const index = new Map<string, PolicyIndexEntry>();
  // Native documents win over legacy projections for the same ref; a legacy
  // policy already migrated is excluded so its native copy is the join truth.
  for (const entry of policies) {
    if (entry.source === 'native') {
      index.set(`${entry.policy.policy_id}@${entry.policy.version}`, {
        status: entry.policy.status,
        dimension: entry.policy.dimension,
      });
    }
  }
  for (const entry of policies) {
    if (entry.source !== 'legacy') {
      continue;
    }
    const ref = `${entry.projection.policy_id}@${entry.projection.version}`;
    if (index.has(ref) || isMigratedNativeId(ledgerEntries, ref, 'policy')) {
      continue;
    }
    index.set(ref, {
      status: entry.projection.status,
      dimension: entry.projection.dimension,
    });
  }
  return index;
}

function nativeRow(
  trace: DecisionTrace,
  policyIndex: Map<string, PolicyIndexEntry>,
  legacyBacklinks: ReadonlyMap<string, string>,
): TraceRow {
  const warnings: DecisionQueryWarning[] = [];
  const resolved = policyIndex.get(trace.policy_ref) ?? null;
  // `broken` is native-only (M1): dangling or mis-dimensioned references
  // stay visible in items with the diagnosis carried by integrity_status.
  const referenceBroken = resolved === null || resolved.dimension !== trace.dimension;
  let integrity: IntegrityStatus;
  if (referenceBroken) {
    integrity = 'broken';
  } else if (trace.feedback_summary_status === 'stale') {
    integrity = 'warning';
    warnings.push({
      code: 'feedback_summary_stale',
      trace_id: trace.trace_id,
      detail: 'Feedback summary is stale relative to persisted samples',
    });
  } else if (resolved?.status === 'deprecated') {
    integrity = 'warning';
  } else {
    integrity = 'valid';
  }
  if (!referenceBroken && resolved?.status === 'deprecated') {
    warnings.push({
      code: 'policy_deprecated_reference',
      trace_id: trace.trace_id,
      detail: `Trace references deprecated policy ${trace.policy_ref}`,
    });
  }
  // Migrated traces keep their legacy backlink (frozen Task 6): the deduped
  // legacy projection is the only legacy_id carrier, so its derived native
  // id maps onto the native row built from the vault document.
  const legacyId = legacyBacklinks.get(trace.trace_id);
  return {
    item: {
      trace_id: trace.trace_id,
      policy_ref: trace.policy_ref,
      dimension: trace.dimension,
      input_refs: [...trace.input_refs],
      decision: trace.decision,
      reasoning_summary: trace.reasoning_summary,
      evidence_refs: [...trace.evidence_refs],
      confidence: trace.confidence,
      user_feedback: trace.user_feedback,
      final_outcome: trace.final_outcome,
      trace_status: trace.status,
      created_at: trace.created_at,
      policy_status: resolved?.status ?? null,
      schema_version: DECISION_PROJECTION_SCHEMA_VERSION,
      source: 'native',
      integrity_status: integrity,
      ...(legacyId === undefined ? {} : { legacy_id: legacyId }),
    },
    feedbackCount: trace.feedback_count,
    warnings,
  };
}

/** Legacy rows keep feedback presence (not count) for stability derivation. */
function legacyHasFeedback(projection: LegacyTraceProjection): boolean {
  return projection.user_feedback !== 'unreviewed' || projection.history.length > 0;
}

function legacyRow(
  projection: LegacyTraceProjection,
  policyIndex: Map<string, PolicyIndexEntry>,
): TraceRow {
  const warnings: DecisionQueryWarning[] = [];
  const resolved = policyIndex.get(projection.policy_ref) ?? null;
  // Legacy rows never degrade to broken on reference gaps (M1): the legacy
  // harness never carried a native strong-reference guarantee.
  if (resolved?.status === 'deprecated') {
    warnings.push({
      code: 'policy_deprecated_reference',
      trace_id: projection.native_id,
      detail: `Legacy trace references deprecated policy ${projection.policy_ref}`,
    });
  }
  if (projection.input_refs === null) {
    warnings.push({
      code: 'legacy_missing_input_refs',
      trace_id: projection.native_id,
      detail: `Legacy trace ${projection.legacy_id} (${projection.source_path}) has no input_refs`,
    });
  }
  if (projection.confidence === null) {
    warnings.push({
      code: 'legacy_missing_confidence',
      trace_id: projection.native_id,
      detail: `Legacy trace ${projection.legacy_id} (${projection.source_path}) has no confidence`,
    });
  }
  const hasFeedback = legacyHasFeedback(projection);
  return {
    item: {
      trace_id: projection.native_id,
      policy_ref: projection.policy_ref,
      dimension: projection.dimension,
      input_refs: projection.input_refs ?? [],
      decision: projection.decision,
      reasoning_summary: projection.reasoning_summary,
      evidence_refs: [...projection.evidence_refs],
      confidence: projection.confidence,
      user_feedback: projection.user_feedback,
      final_outcome: projection.final_outcome,
      trace_status: hasFeedback ? 'feedback_recorded' : 'recorded',
      created_at: projection.created_at,
      policy_status: resolved?.status ?? null,
      schema_version: DECISION_PROJECTION_SCHEMA_VERSION,
      source: 'legacy',
      integrity_status: resolved?.status === 'deprecated' ? 'warning' : 'legacy_compatible',
      legacy_id: projection.legacy_id,
    },
    feedbackCount: hasFeedback ? 1 : 0,
    warnings,
  };
}

function brokenNativeRow(
  broken: BrokenNativeTraceDocument,
  policyIndex: Map<string, PolicyIndexEntry>,
): TraceRow {
  const resolved = broken.policy_ref === null
    ? null
    : policyIndex.get(broken.policy_ref) ?? null;
  return {
    item: {
      trace_id: broken.trace_id,
      policy_ref: broken.policy_ref ?? '',
      dimension: broken.dimension,
      input_refs: [...broken.input_refs],
      decision: broken.decision,
      reasoning_summary: '',
      evidence_refs: [],
      confidence: null,
      user_feedback: 'unreviewed',
      final_outcome: 'pending',
      trace_status: 'recorded',
      created_at: broken.created_at,
      policy_status: resolved?.status ?? null,
      schema_version: DECISION_PROJECTION_SCHEMA_VERSION,
      source: 'native',
      integrity_status: 'broken',
    },
    feedbackCount: 0,
    warnings: [],
  };
}

function traceRow(
  entry: ScannedTraceDocument,
  policyIndex: Map<string, PolicyIndexEntry>,
  ledgerEntries: MigrationLedgerEntry[],
  legacyBacklinks: ReadonlyMap<string, string>,
): TraceRow | null {
  if (entry.source === 'native') {
    return nativeRow(entry.trace, policyIndex, legacyBacklinks);
  }
  if (entry.source === 'native_broken') {
    return brokenNativeRow(entry.broken, policyIndex);
  }
  // Ledger dedup (I2): a migrated legacy trace already has its native copy;
  // excluding it from items and facets prevents double counting.
  if (isMigratedNativeId(ledgerEntries, entry.projection.native_id, 'trace')) {
    return null;
  }
  return legacyRow(entry.projection, policyIndex);
}

function policyRefIdentity(policyRef: string): { policyId: string; version: string } | null {
  const separatorIndex = policyRef.lastIndexOf('@');
  if (separatorIndex < 1) {
    return null;
  }
  return {
    policyId: policyRef.slice(0, separatorIndex),
    version: policyRef.slice(separatorIndex + 1),
  };
}

function stabilityOf(row: TraceRow, deps: QueryDecisionsDeps): FeedbackStability | undefined {
  if (row.feedbackCount === 0) {
    return 'unknown';
  }
  return deps.feedbackStabilityByTrace?.({
    trace_id: row.item.trace_id,
    feedback_count: row.feedbackCount,
  });
}

function matchesQuery(row: TraceRow, query: ValidatedQuery, deps: QueryDecisionsDeps): boolean {
  const { item } = row;
  if (query.dimension !== undefined && item.dimension !== query.dimension) {
    return false;
  }
  if (query.policyId !== undefined || query.policyVersion !== undefined) {
    const identity = policyRefIdentity(item.policy_ref);
    if (identity === null) {
      return false;
    }
    if (query.policyId !== undefined && identity.policyId !== query.policyId) {
      return false;
    }
    if (query.policyVersion !== undefined && identity.version !== query.policyVersion) {
      return false;
    }
  }
  if (query.policyStatus !== undefined && item.policy_status !== query.policyStatus) {
    return false;
  }
  if (query.traceStatus !== undefined && item.trace_status !== query.traceStatus) {
    return false;
  }
  if (query.feedbackKind !== undefined && item.user_feedback !== query.feedbackKind) {
    return false;
  }
  if (query.stability !== undefined && stabilityOf(row, deps) !== query.stability) {
    return false;
  }
  if (query.createdFrom !== undefined && Date.parse(item.created_at) < Date.parse(query.createdFrom)) {
    return false;
  }
  if (query.createdTo !== undefined && Date.parse(item.created_at) > Date.parse(query.createdTo)) {
    return false;
  }
  if (query.refs !== undefined) {
    const candidateRefs = new Set([...item.input_refs, ...item.evidence_refs]);
    if (!query.refs.some((ref) => candidateRefs.has(ref))) {
      return false;
    }
  }
  if (query.integrityStatus !== undefined && item.integrity_status !== query.integrityStatus) {
    return false;
  }
  return query.source === undefined || item.source === query.source;
}

function facetValue(item: DecisionTraceItem, key: DecisionFacetKey): string | null {
  switch (key) {
    case 'dimension':
      return item.dimension;
    case 'policy_status':
      return item.policy_status;
    case 'trace_status':
      return item.trace_status;
    case 'feedback_kind':
      return item.user_feedback;
    case 'integrity_status':
      return item.integrity_status;
    case 'source':
      return item.source;
    default:
      return null;
  }
}

function computeFacets(rows: TraceRow[]): DecisionFacets {
  const facets: DecisionFacets = {
    dimension: {},
    policy_status: {},
    trace_status: {},
    feedback_kind: {},
    integrity_status: {},
    source: {},
  };
  for (const row of rows) {
    for (const key of DECISION_FACET_KEYS) {
      const value = facetValue(row.item, key);
      if (value === null) {
        continue;
      }
      facets[key] = { ...facets[key], [value]: (facets[key][value] ?? 0) + 1 };
    }
  }
  return facets;
}

function compareKeys(left: CursorKey, right: CursorKey): number {
  const timeDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  if (left.traceId !== right.traceId) {
    return left.traceId < right.traceId ? -1 : 1;
  }
  return 0;
}

function rowKey(row: TraceRow): CursorKey {
  return { createdAt: row.item.created_at, traceId: row.item.trace_id };
}

function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify([key.createdAt, key.traceId]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorKey {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new DecisionQueryInvalidError('Malformed query cursor');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2
    || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string'
    || Number.isNaN(Date.parse(decoded[0])) || decoded[1].trim() === '') {
    throw new DecisionQueryInvalidError('Malformed query cursor');
  }
  return { createdAt: decoded[0], traceId: decoded[1] };
}

function pageAfterCursor(
  ordered: TraceRow[],
  cursor: CursorKey,
  sort: DecisionSort,
): TraceRow[] {
  const cursorPosition = ordered.findIndex((row) => compareKeys(rowKey(row), cursor) === 0);
  if (cursorPosition >= 0) {
    return ordered.slice(cursorPosition + 1);
  }
  // A cursor may point at a row the current filters removed; resume from
  // the first row strictly after the cursor key in the requested direction.
  return ordered.filter((row) => (
    sort === 'created_asc'
      ? compareKeys(rowKey(row), cursor) > 0
      : compareKeys(rowKey(row), cursor) < 0
  ));
}

function paginate(
  rows: TraceRow[],
  limit: number,
  warnings: DecisionQueryWarning[],
  facets: DecisionFacets,
): DecisionProjection {
  const page = rows.slice(0, limit);
  const lastRow = page.at(-1);
  return {
    items: page.map((row) => row.item),
    facets,
    next_cursor: rows.length > page.length && lastRow !== undefined
      ? encodeCursor(rowKey(lastRow))
      : null,
    warnings,
  };
}

/**
 * Runs the unified read-only decision query. Facets cover the full filtered
 * set; pagination walks the `[created_at, trace_id]` total order (D7) with a
 * base64url cursor; diagnostics flow through `warnings`, never by dropping
 * rows (broken native objects stay in items).
 */
export async function queryDecisions(
  ctx: QueryContext,
  query: DecisionQuery,
  deps: QueryDecisionsDeps = {},
): Promise<DecisionProjection> {
  const parsedQuery = decisionQuerySchema.safeParse(query);
  if (!parsedQuery.success) {
    throw new DecisionQueryInvalidError();
  }
  const validated = parsedQuery.data;
  const cursor = validated.cursor === undefined ? null : decodeCursor(validated.cursor);
  const root = vaultRoot(ctx.root);

  const scan = await scanDecisionTrees(root);
  const detailedLedger = deps.ledgerEntries === undefined
    ? await readMigrationLedgerDetailed(root)
    : { entries: deps.ledgerEntries, unreadableLines: [] };

  const warnings: DecisionQueryWarning[] = detailedLedger.unreadableLines.map((line) => ({
    code: 'migration_ledger_entry_unreadable',
    detail: `Migration ledger line ${line.line_no} skipped (${line.reason})`,
  }));
  for (const file of scan.unparseable) {
    warnings.push({
      code: 'legacy_schema_unparseable',
      detail: `Decision document ${file.path} is not safely parseable (${file.reason}); not projected`,
    });
  }

  const policyIndex = buildPolicyIndex(scan.policies, detailedLedger.entries);
  // Legacy backlinks (frozen Task 6): every legacy projection knows both its
  // legacy_id and its deterministic native id, so migrated native rows can
  // carry the backlink. A native trace whose legacy source file no longer
  // exists has no projection and therefore no backlink.
  const legacyBacklinks = new Map<string, string>();
  for (const entry of scan.traces) {
    if (entry.source === 'legacy') {
      legacyBacklinks.set(entry.projection.native_id, entry.projection.legacy_id);
    }
  }
  const rows: TraceRow[] = [];
  for (const entry of scan.traces) {
    const row = traceRow(entry, policyIndex, detailedLedger.entries, legacyBacklinks);
    if (row !== null) {
      rows.push(row);
      warnings.push(...row.warnings);
    }
  }

  const filtered = rows.filter((row) => matchesQuery(row, validated, deps));
  const ascending = [...filtered].sort((left, right) => compareKeys(rowKey(left), rowKey(right)));
  const ordered = validated.sort === 'created_asc' ? ascending : [...ascending].reverse();
  const page = cursor === null ? ordered : pageAfterCursor(ordered, cursor, validated.sort);
  return paginate(page, validated.limit, warnings, computeFacets(filtered));
}
