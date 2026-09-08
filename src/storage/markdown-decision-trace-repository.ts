import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { DecisionPolicy } from '../domain/decision-policy.js';
import {
  decisionPolicyRefSchema,
  decisionTraceIdSchema,
  decisionTraceSchema,
  type DecisionTrace,
  type DerivedFeedbackSummary,
  type TraceStatus,
} from '../domain/decision-trace.js';
import {
  acquireSafeFileLock,
  atomicCreateTextFile,
  atomicReplaceSafeTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  vaultRoot,
  type VaultWriteAuthorization,
} from './task-paths.js';

/**
 * Judgment-subject fields of a trace. They are immutable after create: only
 * the feedback summary zone, status bookkeeping and `updated_at` may ever
 * change on an existing document (compare-and-swap guarded).
 */
const TRACE_SUBJECT_KEYS = [
  'policy_ref',
  'dimension',
  'input_refs',
  'decision',
  'reasoning_summary',
  'evidence_refs',
  'confidence',
  'created_at',
] as const;

const SUMMARY_ACTOR = 'system';

const TRACE_LOCK_ATTEMPTS = 3_100;
const TRACE_LOCK_RETRY_MS = 10;
const TRACE_LOCK_LEASE_MS = 60_000;

/** Create input omits the summary zone: the repository initializes it (M8). */
const traceCreateInputSchema = decisionTraceSchema.omit({
  status: true,
  feedback_summary_status: true,
  feedback_count: true,
  latest_feedback_at: true,
  status_history: true,
  closed_at: true,
  updated_at: true,
  user_feedback: true,
  final_outcome: true,
});

export type DecisionPolicyResolver = (ref: string) => Promise<DecisionPolicy | null>;

export interface DecisionTraceRepository {
  create(
    trace: unknown,
    options: { policyResolver: DecisionPolicyResolver },
  ): Promise<DecisionTrace>;
  get(traceId: string): Promise<DecisionTrace | null>;
  listByPolicyRef(ref: string): Promise<DecisionTrace[]>;
  updateFeedbackSummary(
    traceId: string,
    derived: DerivedFeedbackSummary,
    closedAt?: string | null,
  ): Promise<DecisionTrace>;
  close(traceId: string, actor: string): Promise<DecisionTrace>;
  reopen(traceId: string, actor: string): Promise<DecisionTrace>;
}

export interface DecisionTraceRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
  clock?: () => Date;
}

export class DecisionTraceInvalidError extends Error {
  readonly code = 'decision_trace_invalid';

  constructor() {
    super('Invalid decision trace');
    this.name = 'DecisionTraceInvalidError';
  }
}

export class DecisionTraceNotFoundError extends Error {
  readonly code = 'decision_trace_not_found';

  constructor() {
    super('Decision trace not found');
    this.name = 'DecisionTraceNotFoundError';
  }
}

export class DecisionTraceConflictError extends Error {
  readonly code = 'decision_trace_conflict';

  constructor() {
    super('Decision trace conflict');
    this.name = 'DecisionTraceConflictError';
  }
}

export class DecisionPolicyRefUnresolvedError extends Error {
  readonly code = 'decision_policy_ref_unresolved';

  constructor() {
    super('Decision policy reference unresolved');
    this.name = 'DecisionPolicyRefUnresolvedError';
  }
}

export class DecisionTraceLockTimeoutError extends Error {
  readonly code = 'decision_trace_lock_timeout';

  constructor() {
    super('Decision trace lock timed out');
    this.name = 'DecisionTraceLockTimeoutError';
  }
}

function systemRoot(root: string): string {
  return join(root, '07_System');
}

function decisionTracesRoot(root: string): string {
  return join(root, '07_System', 'Logs', 'Decision_Traces');
}

function decisionLocksRoot(root: string): string {
  return join(root, '07_System', '.atl', 'decision-locks');
}

interface YearMonthSegments {
  year: string;
  month: string;
}

function yearMonthSegments(createdAt: string): YearMonthSegments | null {
  const match = /^(\d{4})-(\d{2})-/.exec(createdAt);
  if (match === null) {
    return null;
  }
  const segments: YearMonthSegments = {
    year: match[1] ?? '',
    month: match[2] ?? '',
  };
  if (!isSafePathSegment(segments.year) || !isSafePathSegment(segments.month)) {
    return null;
  }
  return segments;
}

function renderTraceBody(trace: DecisionTrace): string {
  const inputRefs = trace.input_refs.map((ref) => `- ${ref}`).join('\n');
  const evidenceRefs = trace.evidence_refs.map((ref) => `- ${ref}`).join('\n');
  return `
# ${trace.trace_id}

## Decision

${trace.decision}

## Reasoning summary

${trace.reasoning_summary}

## Inputs

${inputRefs}

## Evidence

${evidenceRefs}

## Policy

- Reference: ${trace.policy_ref}
- Dimension: ${trace.dimension}
- Confidence: ${trace.confidence}
`;
}

/**
 * Frontmatter is the single source of truth; the body is a deterministic
 * human-readable projection of the frontmatter and is never parsed back.
 */
function serializeTraceDocument(trace: DecisionTrace): string {
  return serializeTaskDocument({
    trace_id: trace.trace_id,
    policy_ref: trace.policy_ref,
    dimension: trace.dimension,
    input_refs: trace.input_refs,
    decision: trace.decision,
    reasoning_summary: trace.reasoning_summary,
    evidence_refs: trace.evidence_refs,
    confidence: trace.confidence,
    user_feedback: trace.user_feedback,
    final_outcome: trace.final_outcome,
    status: trace.status,
    feedback_summary_status: trace.feedback_summary_status,
    feedback_count: trace.feedback_count,
    latest_feedback_at: trace.latest_feedback_at,
    created_at: trace.created_at,
    closed_at: trace.closed_at ?? null,
    updated_at: trace.updated_at ?? null,
    status_history: trace.status_history,
  }, renderTraceBody(trace));
}

/**
 * Returns the trace when the raw document is a native decision trace, and
 * `null` for anything else (legacy harness documents, foreign or corrupt
 * files). Legacy files are read-only bystanders: never parsed, returned or
 * mutated by this repository.
 */
function parseNativeTraceDocument(raw: string): DecisionTrace | null {
  let document: ReturnType<typeof parseTaskDocument>;
  try {
    document = parseTaskDocument(raw);
  } catch {
    return null;
  }
  const parsed = decisionTraceSchema.safeParse(document.data);
  return parsed.success ? parsed.data : null;
}

function subjectSignature(trace: DecisionTrace): string {
  return JSON.stringify(TRACE_SUBJECT_KEYS.map((key) => trace[key]));
}

function assertSubjectUnchanged(previous: DecisionTrace, next: DecisionTrace): void {
  if (subjectSignature(previous) !== subjectSignature(next)) {
    throw new DecisionTraceInvalidError();
  }
}

function appendStatusHistory(
  trace: DecisionTrace,
  status: TraceStatus,
  at: string,
  actor: string,
): DecisionTrace['status_history'] {
  if (trace.status === status) {
    return trace.status_history;
  }
  return [...trace.status_history, { status, at, actor }];
}

function derivedTraceStatus(
  feedbackCount: number,
  closedAt: string | null,
): TraceStatus {
  if (closedAt !== null) {
    return 'closed';
  }
  return feedbackCount >= 1 ? 'feedback_recorded' : 'recorded';
}

function compareTraces(left: DecisionTrace, right: DecisionTrace): number {
  const delta = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (delta !== 0) {
    return delta;
  }
  if (left.trace_id !== right.trace_id) {
    return left.trace_id < right.trace_id ? -1 : 1;
  }
  return 0;
}

export class MarkdownDecisionTraceRepository implements DecisionTraceRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;
  private readonly clock: () => Date;

  constructor(root?: string, options: DecisionTraceRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
    this.clock = options.clock ?? (() => new Date());
  }

  async create(
    trace: unknown,
    options: { policyResolver: DecisionPolicyResolver },
  ): Promise<DecisionTrace> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    if (typeof options?.policyResolver !== 'function') {
      throw new DecisionTraceInvalidError();
    }
    const parsedInput = traceCreateInputSchema.safeParse(trace);
    if (!parsedInput.success || !isSafePathSegment(parsedInput.data.trace_id)) {
      throw new DecisionTraceInvalidError();
    }
    const segments = yearMonthSegments(parsedInput.data.created_at);
    if (segments === null) {
      throw new DecisionTraceInvalidError();
    }
    const resolvedPolicy = await options.policyResolver(parsedInput.data.policy_ref);
    if (resolvedPolicy === null || resolvedPolicy === undefined) {
      throw new DecisionPolicyRefUnresolvedError();
    }
    const initialized: DecisionTrace = {
      ...parsedInput.data,
      user_feedback: 'unreviewed',
      final_outcome: 'pending',
      status: 'recorded',
      feedback_summary_status: 'fresh',
      feedback_count: 0,
      latest_feedback_at: null,
      closed_at: null,
      updated_at: null,
      status_history: [{
        status: 'recorded',
        at: parsedInput.data.created_at,
        actor: SUMMARY_ACTOR,
      }],
    };
    const validated = decisionTraceSchema.safeParse(initialized);
    if (!validated.success) {
      throw new DecisionTraceInvalidError();
    }
    const monthDirectory = join(
      decisionTracesRoot(this.root),
      segments.year,
      segments.month,
    );
    const created = await atomicCreateTextFile(
      join(monthDirectory, `${validated.data.trace_id}.md`),
      serializeTraceDocument(validated.data),
      this.boundary(monthDirectory),
    );
    if (!created) {
      throw new DecisionTraceConflictError();
    }
    return validated.data;
  }

  async get(traceId: string): Promise<DecisionTrace | null> {
    if (!decisionTraceIdSchema.safeParse(traceId).success) {
      throw new DecisionTraceInvalidError();
    }
    const boundary = this.boundary(decisionTracesRoot(this.root));
    const paths = await listSafeRegularFiles(boundary, `**/${traceId}.md`);
    if (paths.length === 0) {
      return null;
    }
    if (paths.length > 1) {
      throw new DecisionTraceInvalidError();
    }
    const raw = await readSafeTextFile(paths[0] ?? '', boundary);
    if (raw === null) {
      return null;
    }
    const trace = parseNativeTraceDocument(raw);
    if (trace === null || trace.trace_id !== traceId) {
      throw new DecisionTraceInvalidError();
    }
    return trace;
  }

  async listByPolicyRef(ref: string): Promise<DecisionTrace[]> {
    if (!decisionPolicyRefSchema.safeParse(ref).success) {
      throw new DecisionTraceInvalidError();
    }
    const boundary = this.boundary(decisionTracesRoot(this.root));
    const paths = await listSafeRegularFiles(boundary, '**/*.md');
    const matches: DecisionTrace[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) {
        continue;
      }
      const trace = parseNativeTraceDocument(raw);
      if (trace === null || trace.policy_ref !== ref) {
        continue;
      }
      matches.push(trace);
    }
    return matches.sort(compareTraces);
  }

  async updateFeedbackSummary(
    traceId: string,
    derived: DerivedFeedbackSummary,
    closedAt?: string | null,
  ): Promise<DecisionTrace> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const { path, raw, trace } = await this.loadTraceDocument(traceId);
    const effectiveClosedAt = closedAt !== undefined ? closedAt : (trace.closed_at ?? null);
    const nextStatus = derivedTraceStatus(derived.feedback_count, effectiveClosedAt);
    const now = this.clock().toISOString();
    const next: DecisionTrace = {
      ...trace,
      user_feedback: derived.user_feedback,
      final_outcome: derived.final_outcome,
      feedback_count: derived.feedback_count,
      latest_feedback_at: derived.latest_feedback_at,
      feedback_summary_status: 'fresh',
      status: nextStatus,
      closed_at: effectiveClosedAt,
      updated_at: now,
      status_history: appendStatusHistory(trace, nextStatus, now, SUMMARY_ACTOR),
    };
    assertSubjectUnchanged(trace, next);
    return this.replaceTraceDocument(path, raw, next);
  }

  async close(traceId: string, actor: string): Promise<DecisionTrace> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new DecisionTraceInvalidError();
    }
    const { path, raw, trace } = await this.loadTraceDocument(traceId);
    if (trace.status === 'closed') {
      throw new DecisionTraceInvalidError();
    }
    const now = this.clock().toISOString();
    const next: DecisionTrace = {
      ...trace,
      status: 'closed',
      closed_at: now,
      updated_at: now,
      status_history: appendStatusHistory(trace, 'closed', now, actor.trim()),
    };
    assertSubjectUnchanged(trace, next);
    return this.replaceTraceDocument(path, raw, next);
  }

  async reopen(traceId: string, actor: string): Promise<DecisionTrace> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    if (typeof actor !== 'string' || actor.trim() === '') {
      throw new DecisionTraceInvalidError();
    }
    const { path, raw, trace } = await this.loadTraceDocument(traceId);
    if (trace.status !== 'closed') {
      throw new DecisionTraceInvalidError();
    }
    const now = this.clock().toISOString();
    const nextStatus = derivedTraceStatus(trace.feedback_count, null);
    const next: DecisionTrace = {
      ...trace,
      status: nextStatus,
      closed_at: null,
      updated_at: now,
      status_history: appendStatusHistory(trace, nextStatus, now, actor.trim()),
    };
    assertSubjectUnchanged(trace, next);
    return this.replaceTraceDocument(path, raw, next);
  }

  private boundary(subtree: string): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: systemRoot(this.root),
      subtree,
    };
  }

  private async loadTraceDocument(
    traceId: string,
  ): Promise<{ path: string; raw: string; trace: DecisionTrace }> {
    if (!decisionTraceIdSchema.safeParse(traceId).success) {
      throw new DecisionTraceInvalidError();
    }
    const boundary = this.boundary(decisionTracesRoot(this.root));
    const paths = await listSafeRegularFiles(boundary, `**/${traceId}.md`);
    if (paths.length === 0) {
      throw new DecisionTraceNotFoundError();
    }
    if (paths.length > 1) {
      throw new DecisionTraceInvalidError();
    }
    const path = paths[0] ?? '';
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      throw new DecisionTraceNotFoundError();
    }
    const trace = parseNativeTraceDocument(raw);
    if (trace === null || trace.trace_id !== traceId) {
      throw new DecisionTraceInvalidError();
    }
    return { path, raw, trace };
  }

  private async replaceTraceDocument(
    path: string,
    expectedRaw: string,
    next: DecisionTrace,
  ): Promise<DecisionTrace> {
    const validated = decisionTraceSchema.safeParse(next);
    if (!validated.success) {
      throw new DecisionTraceInvalidError();
    }
    const replaced = await atomicReplaceSafeTextFile(
      path,
      expectedRaw,
      serializeTraceDocument(validated.data),
      this.boundary(dirname(path)),
    );
    if (!replaced) {
      throw new DecisionTraceConflictError();
    }
    return validated.data;
  }
}

export interface DecisionTraceLockOptions {
  attempts?: number;
  retryMs?: number;
  leaseMs?: number;
  clock?: () => Date;
  /**
   * Explicit vault token for the lock's write gate. Without it a real
   * (non-temporary) root is refused exactly like any other unauthorized
   * write; with it the caller's own authorization — the same token the
   * repositories already carry — admits lock acquisition.
   */
  writeAuthorization?: VaultWriteAuthorization;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Per-trace lease lock (D5) around sample/summary double writes. Callers own
 * the critical section; repository CAS methods stay non-locking so they can
 * run inside an already-held lock without self-deadlock. Acquiring the lock
 * is itself a vault write, so it passes through the same write gate as the
 * repositories — forward the caller's explicit token via
 * `options.writeAuthorization`; omitting it keeps real roots locked out.
 */
export async function withDecisionTraceLock<T>(
  root: string | undefined,
  traceId: string,
  operation: () => Promise<T>,
  options: DecisionTraceLockOptions = {},
): Promise<T> {
  const resolvedRoot = vaultRoot(root);
  assertVaultWriteAllowed(resolvedRoot, options.writeAuthorization);
  if (!decisionTraceIdSchema.safeParse(traceId).success) {
    throw new DecisionTraceInvalidError();
  }
  const attempts = positiveIntegerOrDefault(options.attempts, TRACE_LOCK_ATTEMPTS);
  const retryMs = positiveIntegerOrDefault(options.retryMs, TRACE_LOCK_RETRY_MS);
  const leaseMs = positiveIntegerOrDefault(options.leaseMs, TRACE_LOCK_LEASE_MS);
  const clock = options.clock ?? (() => new Date());
  const lockRoot = decisionLocksRoot(resolvedRoot);
  const lockKey = createHash('sha256').update(traceId).digest('hex');
  const lockPath = join(lockRoot, `${lockKey}.lock`);
  const boundary: StorageReadBoundary = {
    vaultRoot: resolvedRoot,
    tasksRoot: systemRoot(resolvedRoot),
    subtree: lockRoot,
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let lock = await acquireSafeFileLock(lockPath, boundary, {
      acquiredAt: clock(),
      leaseMs,
    });
    if (lock === null) {
      const reclaimed = await reclaimExpiredSafeFileLock(lockPath, boundary, clock());
      if (reclaimed) {
        lock = await acquireSafeFileLock(lockPath, boundary, {
          acquiredAt: clock(),
          leaseMs,
        });
      }
      if (lock === null) {
        if (attempt + 1 < attempts) {
          await delay(retryMs);
        }
        continue;
      }
    }
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }
  throw new DecisionTraceLockTimeoutError();
}
