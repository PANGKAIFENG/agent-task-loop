import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';

import { z } from 'zod';

import {
  DECISION_DIMENSIONS,
  POLICY_STATUSES,
  decisionPolicySchema,
  type DecisionDimension,
  type DecisionPolicy,
  type PolicyStatus,
} from '../domain/decision-policy.js';
import {
  decisionPolicyRefSchema,
  decisionTraceIdSchema,
  decisionTraceSchema,
  type DecisionTrace,
  type UserFeedback,
} from '../domain/decision-trace.js';
import { listSafeRegularFiles, readSafeTextFile, type StorageReadBoundary } from './file-io.js';
import { parseTaskDocument } from './frontmatter.js';
import { vaultRoot } from './task-paths.js';

/**
 * Read-only legacy projection surface (PRD migration compatibility). The
 * adapter scans the two existing decision subtrees and classifies every file
 * by format: native schema first, legacy harness format second — the format
 * that parses is the native/legacy discriminator. It exposes no write
 * method and never mutates a byte.
 */
export const LEGACY_CREATED_AT_SENTINEL = '1970-01-01T00:00:00.000Z';

const LEGACY_TRACE_TYPE = 'decision_trace';
const LEGACY_POLICY_TYPE = 'decision_policy';
const LEGACY_NONE_FEEDBACK = 'none';

/** Native-only trace zone fields; their presence marks a file native-shaped. */
const NATIVE_TRACE_MARKERS = [
  'status',
  'feedback_summary_status',
  'feedback_count',
  'status_history',
] as const;

export interface LegacyPolicyProjection {
  policy_id: string;
  version: string;
  status: PolicyStatus;
  dimension: DecisionDimension;
  decision_question: string;
  sources: string[];
  next_review_at: string | null;
  source_path: string;
}

export interface LegacyTraceProjection {
  legacy_id: string;
  /** Deterministic migration id (D8): `dt_<sha20(legacy_id)>`. */
  native_id: string;
  policy_ref: string;
  dimension: DecisionDimension;
  /** `null` marks a missing list so queries can warn without fabricating. */
  input_refs: string[] | null;
  decision: string;
  reasoning_summary: string;
  evidence_refs: string[];
  confidence: 'high' | 'medium' | 'low' | null;
  user_feedback: UserFeedback;
  final_outcome: string;
  created_at: string;
  history: string[];
  source_path: string;
}

export interface BrokenNativeTraceDocument {
  /** Best-effort identity: frontmatter value or the `<trace_id>.md` stem. */
  trace_id: string;
  policy_ref: string | null;
  dimension: DecisionDimension | null;
  input_refs: string[];
  decision: string;
  created_at: string;
  reason: string;
  source_path: string;
}

export type ScannedPolicyDocument =
  | { path: string; source: 'native'; policy: DecisionPolicy }
  | { path: string; source: 'legacy'; projection: LegacyPolicyProjection };

export type ScannedTraceDocument =
  | { path: string; source: 'native'; trace: DecisionTrace }
  | { path: string; source: 'legacy'; projection: LegacyTraceProjection }
  | { path: string; source: 'native_broken'; broken: BrokenNativeTraceDocument };

export interface DecisionUnparseableFile {
  path: string;
  reason: string;
}

export interface DecisionTreeScan {
  policies: ScannedPolicyDocument[];
  traces: ScannedTraceDocument[];
  unparseable: DecisionUnparseableFile[];
}

/** Deterministic native id for a legacy trace (D8): `dt_` + 20 hex chars. */
export function deriveLegacyTraceNativeId(legacyId: string): string {
  return `dt_${createHash('sha256').update(legacyId).digest('hex').slice(0, 20)}`;
}

function isDecisionDimension(value: unknown): value is DecisionDimension {
  return typeof value === 'string' && (DECISION_DIMENSIONS as readonly string[]).includes(value);
}

function isPolicyStatus(value: unknown): value is PolicyStatus {
  return typeof value === 'string' && (POLICY_STATUSES as readonly string[]).includes(value);
}

function isUserFeedback(value: unknown): value is UserFeedback {
  return value === 'unreviewed' || value === 'accepted' || value === 'corrected'
    || value === 'rejected' || value === 'deferred';
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return items.length === value.length ? items : null;
}

function sentinelOrIso(value: unknown): string {
  if (typeof value !== 'string') {
    return LEGACY_CREATED_AT_SENTINEL;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? LEGACY_CREATED_AT_SENTINEL : value;
}

/**
 * Parses a legacy harness trace document (blueprint:
 * `run-v0.2-synthetic-loop.mjs` traceDocument). Missing `input_refs` and
 * `confidence` project as `null` (warned by the query layer, never
 * fabricated); `user_feedback: none` maps to `unreviewed` (M8); a missing or
 * unparseable `created_at` falls back to the sentinel (D7).
 */
export function parseLegacyTraceDocument(data: Record<string, unknown>): LegacyTraceProjection | null {
  if (data.type !== LEGACY_TRACE_TYPE) {
    return null;
  }
  const legacyId = data.trace_id;
  const policyRef = data.policy_ref;
  const decision = data.decision;
  if (typeof legacyId !== 'string' || legacyId.trim() === '' || legacyId.length > 200) {
    return null;
  }
  if (typeof policyRef !== 'string' || !decisionPolicyRefSchema.safeParse(policyRef).success) {
    return null;
  }
  if (typeof decision !== 'string' || decision.trim() === '' || decision.length > 500) {
    return null;
  }
  if (!isDecisionDimension(data.dimension)) {
    return null;
  }
  const rawFeedback = data.user_feedback ?? LEGACY_NONE_FEEDBACK;
  if (rawFeedback !== LEGACY_NONE_FEEDBACK && !isUserFeedback(rawFeedback)) {
    return null;
  }
  const rawConfidence = data.confidence;
  if (rawConfidence !== undefined && rawConfidence !== null
    && !['high', 'medium', 'low'].includes(rawConfidence as string)) {
    return null;
  }
  const reasoning = data.reasoning_summary;
  if (reasoning !== undefined && reasoning !== null && typeof reasoning !== 'string') {
    return null;
  }
  const finalOutcome = data.final_outcome;
  if (finalOutcome !== undefined && finalOutcome !== null && typeof finalOutcome !== 'string') {
    return null;
  }
  const inputRefs = stringList(data.input_refs);
  const evidenceRefs = stringList(data.evidence_refs);
  return {
    legacy_id: legacyId,
    native_id: deriveLegacyTraceNativeId(legacyId),
    policy_ref: policyRef,
    dimension: data.dimension,
    input_refs: inputRefs !== null && inputRefs.length > 0 ? inputRefs : null,
    decision,
    reasoning_summary: typeof reasoning === 'string' ? reasoning : '',
    evidence_refs: evidenceRefs ?? [],
    confidence: rawConfidence === undefined || rawConfidence === null
      ? null
      : rawConfidence as 'high' | 'medium' | 'low',
    user_feedback: rawFeedback === LEGACY_NONE_FEEDBACK ? 'unreviewed' : rawFeedback,
    final_outcome: typeof finalOutcome === 'string' ? finalOutcome : 'pending',
    created_at: sentinelOrIso(data.created_at),
    history: stringList(data.history) ?? [],
    source_path: '',
  };
}

/**
 * Parses a legacy harness policy document. Identity fields (`policy_id`,
 * `version`), a frozen `status` and a valid `dimension` are required for a
 * projection; everything else is tolerated as missing.
 */
export function parseLegacyPolicyDocument(data: Record<string, unknown>): LegacyPolicyProjection | null {
  if (data.type !== LEGACY_POLICY_TYPE) {
    return null;
  }
  const policyId = data.policy_id;
  const version = data.version;
  if (typeof policyId !== 'string' || policyId.trim() === '' || policyId.length > 300) {
    return null;
  }
  if (typeof version !== 'string' || !/^v\d{3}$/u.test(version)) {
    return null;
  }
  if (!isPolicyStatus(data.status) || !isDecisionDimension(data.dimension)) {
    return null;
  }
  const question = data.decision_question;
  if (typeof question !== 'string' || question.trim() === '') {
    return null;
  }
  const nextReview = data.next_review_at;
  if (nextReview !== undefined && nextReview !== null && typeof nextReview !== 'string') {
    return null;
  }
  return {
    policy_id: policyId,
    version,
    status: data.status,
    dimension: data.dimension,
    decision_question: question,
    sources: stringList(data.sources) ?? [],
    next_review_at: typeof nextReview === 'string' ? nextReview : null,
    source_path: '',
  };
}

function hasAnyMarker(data: Record<string, unknown>, markers: readonly string[]): boolean {
  return markers.some((marker) => data[marker] !== undefined);
}

function parseableCreatedAt(data: Record<string, unknown>): string | null {
  const value = data.created_at;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return value;
}

function brokenNativeTrace(
  data: Record<string, unknown>,
  path: string,
  failure: z.ZodError<DecisionTrace>,
): BrokenNativeTraceDocument {
  const fromFrontmatter = typeof data.trace_id === 'string' && data.trace_id.trim() !== ''
    ? data.trace_id
    : null;
  const firstIssue = failure.issues[0];
  const issuePath = firstIssue === undefined
    ? 'unknown'
    : firstIssue.path.map((segment) => String(segment)).join('.');
  return {
    trace_id: fromFrontmatter ?? basename(path).replace(/\.md$/u, ''),
    policy_ref: typeof data.policy_ref === 'string' ? data.policy_ref : null,
    dimension: isDecisionDimension(data.dimension) ? data.dimension : null,
    input_refs: stringList(data.input_refs) ?? [],
    decision: typeof data.decision === 'string' ? data.decision : '',
    created_at: parseableCreatedAt(data) ?? LEGACY_CREATED_AT_SENTINEL,
    reason: `native_schema_unparseable:${issuePath}`,
    source_path: path,
  };
}

function classifyTraceDocument(
  data: Record<string, unknown>,
  path: string,
): ScannedTraceDocument | DecisionUnparseableFile {
  const native = decisionTraceSchema.safeParse(data);
  if (native.success) {
    return { path, source: 'native', trace: native.data };
  }
  // A native-shaped file (native id or native zone fields) that fails the
  // schema is a broken native object: kept in items by the query layer (M1).
  const nativeShaped = decisionTraceIdSchema.safeParse(data.trace_id).success
    || hasAnyMarker(data, NATIVE_TRACE_MARKERS);
  if (nativeShaped) {
    return { path, source: 'native_broken', broken: brokenNativeTrace(data, path, native.error) };
  }
  const legacy = parseLegacyTraceDocument(data);
  if (legacy !== null) {
    return { path, source: 'legacy', projection: { ...legacy, source_path: path } };
  }
  return { path, reason: 'legacy_schema_unparseable' };
}

function classifyPolicyDocument(
  data: Record<string, unknown>,
  path: string,
): ScannedPolicyDocument | DecisionUnparseableFile {
  const native = decisionPolicySchema.safeParse(data);
  if (native.success) {
    return { path, source: 'native', policy: native.data };
  }
  const legacy = parseLegacyPolicyDocument(data);
  if (legacy !== null) {
    return { path, source: 'legacy', projection: { ...legacy, source_path: path } };
  }
  return { path, reason: 'legacy_schema_unparseable' };
}

function decisionLogicDirectory(root: string): string {
  return join(root, '07_System', 'Rules', 'Decision_Logic');
}

function decisionTracesDirectory(root: string): string {
  return join(root, '07_System', 'Logs', 'Decision_Traces');
}

function readBoundary(root: string, subtree: string): StorageReadBoundary {
  return {
    vaultRoot: root,
    tasksRoot: join(root, '07_System'),
    subtree,
  };
}

async function readFrontmatterOrNull(
  absolutePath: string,
  boundary: StorageReadBoundary,
): Promise<Record<string, unknown> | null> {
  // Unreadable-by-safety files (symlinks, foreign entries) are silently
  // skipped bystanders, mirroring the repositories' read behaviour; a null
  // frontmatter marks a file whose body is not a decision document at all.
  const raw = await readSafeTextFile(absolutePath, boundary);
  if (raw === null) {
    return null;
  }
  try {
    return parseTaskDocument(raw).data;
  } catch {
    return {};
  }
}

async function scanTree<T>(
  root: string,
  directory: string,
  classify: (data: Record<string, unknown>, vaultRelativePath: string) => T,
): Promise<T[]> {
  const boundary = readBoundary(root, directory);
  const paths = await listSafeRegularFiles(boundary, '**/*.md');
  const classified: T[] = [];
  for (const absolutePath of paths) {
    const data = await readFrontmatterOrNull(absolutePath, boundary);
    if (data === null) {
      continue;
    }
    classified.push(classify(data, relative(root, absolutePath)));
  }
  return classified;
}

/**
 * Scans both decision subtrees read-only: every Markdown file under
 * `07_System/Rules/Decision_Logic` (policies) and under
 * `07_System/Logs/Decision_Traces` (traces). Vault-relative POSIX paths
 * keep warnings and projections portable across machines.
 */
export async function scanDecisionTrees(configuredRoot?: string): Promise<DecisionTreeScan> {
  const root = vaultRoot(configuredRoot);
  const policyEntries = await scanTree(root, decisionLogicDirectory(root), classifyPolicyDocument);
  const traceEntries = await scanTree(root, decisionTracesDirectory(root), classifyTraceDocument);
  const scan: DecisionTreeScan = { policies: [], traces: [], unparseable: [] };
  for (const entry of policyEntries) {
    if ('source' in entry) {
      scan.policies.push(entry);
    } else {
      scan.unparseable.push(entry);
    }
  }
  for (const entry of traceEntries) {
    if ('source' in entry) {
      scan.traces.push(entry);
    } else {
      scan.unparseable.push(entry);
    }
  }
  return scan;
}
