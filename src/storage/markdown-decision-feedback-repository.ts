import { join } from 'node:path';

import type { DecisionDimension } from '../domain/decision-policy.js';
import {
  FEEDBACK_KINDS,
  FEEDBACK_STABILITY,
  feedbackSampleSchema,
  type FeedbackKind,
  type FeedbackSample,
  type FeedbackStability,
} from '../domain/decision-feedback.js';
import { DECISION_DIMENSIONS } from '../domain/decision-policy.js';
import { decisionTraceIdSchema } from '../domain/decision-trace.js';
import {
  parseDecisionDocument,
  renderFeedbackBody,
  serializeDecisionDocument,
} from './decision-document.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  vaultRoot,
  type VaultWriteAuthorization,
} from './task-paths.js';

/** Aggregation filters for review/weekly projections (PRD query contract). */
export interface FeedbackAggregationFilter {
  dimension?: DecisionDimension;
  kind?: FeedbackKind;
  stability?: FeedbackStability;
  /** Inclusive ISO8601 bounds on `created_at`. */
  from?: string;
  to?: string;
}

export interface DecisionFeedbackRepository {
  /** Idempotent create-only persistence (D3): same id reads back `created:false`. */
  createOrGet(sample: unknown): Promise<{ sample: FeedbackSample; created: boolean }>;
  listByTrace(traceId: string): Promise<FeedbackSample[]>;
  listForAggregation(filter?: FeedbackAggregationFilter): Promise<FeedbackSample[]>;
}

export class DecisionFeedbackInvalidError extends Error {
  readonly code = 'decision_feedback_invalid';

  constructor() {
    super('Invalid decision feedback sample');
    this.name = 'DecisionFeedbackInvalidError';
  }
}

export class DecisionFeedbackDuplicateConflictError extends Error {
  readonly code = 'decision_feedback_duplicate_conflict';

  constructor() {
    super('Decision feedback id is already taken by a different sample');
    this.name = 'DecisionFeedbackDuplicateConflictError';
  }
}

export interface MarkdownDecisionFeedbackRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
  /** Resolves `policy_ref` to its dimension for `dimension` aggregation filters. */
  resolvePolicyDimension?: (policyRef: string) => Promise<DecisionDimension | null>;
}

interface YearMonthSegments {
  year: string;
  month: string;
}

function systemRoot(root: string): string {
  return join(root, '07_System');
}

function decisionFeedbackRoot(root: string): string {
  return join(root, '07_System', 'Logs', 'Decision_Feedback');
}

function yearMonthSegments(createdAt: string): YearMonthSegments | null {
  const match = /^(\d{4})-(\d{2})-/.exec(createdAt);
  if (match === null) {
    return null;
  }
  const segments: YearMonthSegments = { year: match[1] ?? '', month: match[2] ?? '' };
  if (!isSafePathSegment(segments.year) || !isSafePathSegment(segments.month)) {
    return null;
  }
  return segments;
}

/**
 * Frontmatter is the single source of truth; the body is a deterministic
 * human-readable projection (renderFeedbackBody) and is never parsed back.
 */
function serializeSampleDocument(sample: FeedbackSample): string {
  return serializeDecisionDocument({
    feedback_id: sample.feedback_id,
    trace_id: sample.trace_id,
    kind: sample.kind,
    stability: sample.stability,
    correction_summary: sample.correction_summary,
    final_outcome: sample.final_outcome,
    created_at: sample.created_at,
    source_ref: sample.source_ref,
    ...(sample.idempotency_key === undefined ? {} : { idempotency_key: sample.idempotency_key }),
    ...(sample.policy_ref === undefined ? {} : { policy_ref: sample.policy_ref }),
  }, renderFeedbackBody(sample));
}

/** Native sample, or `null` for anything else (foreign or corrupt files). */
function parseSampleDocument(raw: string): FeedbackSample | null {
  let document: ReturnType<typeof parseDecisionDocument>;
  try {
    document = parseDecisionDocument(raw);
  } catch {
    return null;
  }
  const parsed = feedbackSampleSchema.safeParse(document.data);
  return parsed.success ? parsed.data : null;
}

function compareSamples(left: FeedbackSample, right: FeedbackSample): number {
  const delta = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (delta !== 0) {
    return delta;
  }
  if (left.feedback_id !== right.feedback_id) {
    return left.feedback_id < right.feedback_id ? -1 : 1;
  }
  return 0;
}

function isTimestamp(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

export class MarkdownDecisionFeedbackRepository implements DecisionFeedbackRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;
  private readonly resolvePolicyDimension:
    | ((policyRef: string) => Promise<DecisionDimension | null>)
    | undefined;

  constructor(root?: string, options: MarkdownDecisionFeedbackRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
    this.resolvePolicyDimension = options.resolvePolicyDimension;
  }

  async createOrGet(sample: unknown): Promise<{ sample: FeedbackSample; created: boolean }> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = feedbackSampleSchema.safeParse(sample);
    if (!parsed.success
      || !isSafePathSegment(parsed.data.feedback_id)
      || !isSafePathSegment(parsed.data.trace_id)) {
      throw new DecisionFeedbackInvalidError();
    }
    const segments = yearMonthSegments(parsed.data.created_at);
    if (segments === null) {
      throw new DecisionFeedbackInvalidError();
    }
    const monthDirectory = join(
      decisionFeedbackRoot(this.root),
      segments.year,
      segments.month,
    );
    const created = await atomicCreateTextFile(
      join(monthDirectory, `${parsed.data.feedback_id}.md`),
      serializeSampleDocument(parsed.data),
      this.boundary(monthDirectory),
    );
    if (created) {
      return { sample: parsed.data, created: true };
    }
    // Create-only miss: deterministic ids replay, anything else is a conflict.
    const existing = await this.readSample(parsed.data.feedback_id);
    if (existing === null
      || existing.trace_id !== parsed.data.trace_id
      || existing.kind !== parsed.data.kind
      || existing.idempotency_key !== parsed.data.idempotency_key) {
      throw new DecisionFeedbackDuplicateConflictError();
    }
    return { sample: existing, created: false };
  }

  async listByTrace(traceId: string): Promise<FeedbackSample[]> {
    if (!decisionTraceIdSchema.safeParse(traceId).success) {
      throw new DecisionFeedbackInvalidError();
    }
    const samples = await this.listAllSamples();
    return samples
      .filter((sample) => sample.trace_id === traceId)
      .sort(compareSamples);
  }

  async listForAggregation(filter: FeedbackAggregationFilter = {}): Promise<FeedbackSample[]> {
    if (filter.kind !== undefined && !FEEDBACK_KINDS.includes(filter.kind)) {
      throw new DecisionFeedbackInvalidError();
    }
    if (filter.stability !== undefined && !FEEDBACK_STABILITY.includes(filter.stability)) {
      throw new DecisionFeedbackInvalidError();
    }
    if (filter.dimension !== undefined && !DECISION_DIMENSIONS.includes(filter.dimension)) {
      throw new DecisionFeedbackInvalidError();
    }
    if ((filter.from !== undefined && !isTimestamp(filter.from))
      || (filter.to !== undefined && !isTimestamp(filter.to))) {
      throw new DecisionFeedbackInvalidError();
    }
    if (filter.dimension !== undefined && this.resolvePolicyDimension === undefined) {
      throw new DecisionFeedbackInvalidError();
    }
    let samples = await this.listAllSamples();
    if (filter.kind !== undefined) {
      samples = samples.filter((sample) => sample.kind === filter.kind);
    }
    if (filter.stability !== undefined) {
      samples = samples.filter((sample) => sample.stability === filter.stability);
    }
    if (filter.from !== undefined) {
      const from = Date.parse(filter.from);
      samples = samples.filter((sample) => Date.parse(sample.created_at) >= from);
    }
    if (filter.to !== undefined) {
      const to = Date.parse(filter.to);
      samples = samples.filter((sample) => Date.parse(sample.created_at) <= to);
    }
    if (filter.dimension !== undefined && this.resolvePolicyDimension !== undefined) {
      const resolve = this.resolvePolicyDimension;
      const wantedDimension = filter.dimension;
      const matched: FeedbackSample[] = [];
      for (const sample of samples) {
        if (sample.policy_ref === undefined) {
          continue;
        }
        if (await resolve(sample.policy_ref) === wantedDimension) {
          matched.push(sample);
        }
      }
      samples = matched;
    }
    return samples.sort(compareSamples);
  }

  private boundary(subtree: string): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: systemRoot(this.root),
      subtree,
    };
  }

  private async readSample(feedbackId: string): Promise<FeedbackSample | null> {
    const boundary = this.boundary(decisionFeedbackRoot(this.root));
    const paths = await listSafeRegularFiles(boundary, `**/${feedbackId}.md`);
    if (paths.length !== 1) {
      return null;
    }
    const raw = await readSafeTextFile(paths[0] ?? '', boundary);
    if (raw === null) {
      return null;
    }
    const sample = parseSampleDocument(raw);
    if (sample === null || sample.feedback_id !== feedbackId) {
      return null;
    }
    return sample;
  }

  private async listAllSamples(): Promise<FeedbackSample[]> {
    const boundary = this.boundary(decisionFeedbackRoot(this.root));
    const paths = await listSafeRegularFiles(boundary, '**/*.md');
    const samples: FeedbackSample[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) {
        continue;
      }
      const sample = parseSampleDocument(raw);
      if (sample !== null) {
        samples.push(sample);
      }
    }
    return samples;
  }
}
