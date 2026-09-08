import { ulid } from 'ulid';

import type {
  ArtifactRepository,
  AuditLog,
  ProjectRepository,
  TaskRepository,
} from '../storage/contracts.js';
import type { AcceptanceObject } from '../domain/acceptance-object.js';
import type { DecisionPolicy } from '../domain/decision-policy.js';
import type { FeedbackSample, FeedbackStability } from '../domain/decision-feedback.js';
import type { Task } from '../domain/task.js';
import {
  migrateLegacyDecisions,
  type MigrationReport,
  type MigrateLegacyDecisionsInput,
} from '../storage/decision-migration.js';
import {
  queryDecisions,
  type DecisionProjection,
  type DecisionQuery,
  type QueryDecisionsDeps,
} from './query-decisions.js';
import {
  recordDecisionFeedback,
  type RecordFeedbackResult,
} from './record-decision-feedback.js';
import {
  checkDecisionConsistency,
  type DecisionConsistencyReport,
  type CheckDecisionConsistencyParams,
} from './check-decision-consistency.js';
import {
  MarkdownDecisionFeedbackRepository,
  type DecisionFeedbackRepository,
} from '../storage/markdown-decision-feedback-repository.js';
import {
  MarkdownDecisionPolicyRepository,
  type DecisionPolicyRepository,
  type PolicyRef,
} from '../storage/markdown-decision-policy-repository.js';
import {
  MarkdownDecisionTraceRepository,
  type DecisionTraceRepository,
} from '../storage/markdown-decision-trace-repository.js';
import { vaultRoot, type VaultWriteAuthorization } from '../storage/task-paths.js';
import type { AcceptanceNotificationRecord } from './notify-acceptance.js';
import type { DecisionNotificationRecord } from './notify-decision.js';

export interface AcceptanceNotifier {
  (object: AcceptanceObject): Promise<unknown>;
  retryFailed?: () => Promise<AcceptanceNotificationRecord[]>;
}

export interface DecisionNotifier {
  (task: Task): Promise<DecisionNotificationRecord>;
}

export interface ServiceContext {
  tasks: TaskRepository;
  artifacts: ArtifactRepository;
  projects: ProjectRepository;
  audit: AuditLog;
  clock: () => Date;
  id: () => string;
  notifyAcceptance?: AcceptanceNotifier;
  notifyDecision?: DecisionNotifier;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

export function createTaskId(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Invalid task ID date');
  }
  const businessDate = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
  ].join('');
  const entropy = ulid(now.getTime()).slice(-8).toLowerCase();
  return `task-${businessDate}-${entropy}`;
}

/**
 * Decision domain service context — T4 intermediate assembly (TEP27-G4@v1.1
 * D11): the three repositories plus the record/check services share one
 * vault root and clock. T7 appends the final assembly (query service,
 * ledger reader, migration service, command factory) on top of this segment
 * without rewriting it.
 */
export interface DecisionServiceContext {
  vaultRoot: string;
  clock: () => Date;
  policies: DecisionPolicyRepository;
  traces: DecisionTraceRepository;
  feedback: DecisionFeedbackRepository;
  /** Retained so migration-level gates reuse the caller's explicit token. */
  writeAuthorization?: VaultWriteAuthorization;
}

export interface DecisionServiceContextOptions {
  clock?: () => Date;
  writeAuthorization?: VaultWriteAuthorization;
}

export function createDecisionServiceContext(
  root?: string,
  options: DecisionServiceContextOptions = {},
): DecisionServiceContext {
  const resolvedRoot = vaultRoot(root);
  const clock = options.clock ?? (() => new Date());
  const writeOptions = options.writeAuthorization === undefined
    ? {}
    : { writeAuthorization: options.writeAuthorization };
  const policies = new MarkdownDecisionPolicyRepository(resolvedRoot, writeOptions);
  const traces = new MarkdownDecisionTraceRepository(resolvedRoot, { ...writeOptions, clock });
  const feedback = new MarkdownDecisionFeedbackRepository(resolvedRoot, {
    ...writeOptions,
    // Refs reaching this resolver come from schema-validated decision
    // documents, so the `policy.<id>@vNNN` shape is already enforced.
    resolvePolicyDimension: async (policyRef) => {
      const policy = await policies.get(policyRef as PolicyRef);
      return policy === null ? null : policy.dimension;
    },
  });
  return {
    vaultRoot: resolvedRoot,
    clock,
    policies,
    traces,
    feedback,
    ...writeOptions,
  };
}

/**
 * Latest feedback stability per trace, ordered the way the domain summary
 * derivation orders samples (`created_at`, then `feedback_id`): the last
 * sample of a trace is the one whose stability the query filter sees.
 */
function latestStabilityByTrace(samples: FeedbackSample[]): Map<string, FeedbackStability> {
  const latest = new Map<string, FeedbackSample>();
  for (const sample of samples) {
    const current = latest.get(sample.trace_id);
    if (current === undefined || compareStabilitySamples(current, sample) <= 0) {
      latest.set(sample.trace_id, sample);
    }
  }
  return new Map(
    [...latest.entries()].map(([traceId, sample]) => [traceId, sample.stability]),
  );
}

function compareStabilitySamples(left: FeedbackSample, right: FeedbackSample): number {
  const timeDelta = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return left.feedback_id === right.feedback_id ? 0 : (left.feedback_id < right.feedback_id ? -1 : 1);
}

/**
 * T7 final assembly (TEP27-G4@v1.1 D11): the full decision service surface
 * the CLI commands consume. Appended below the T4 intermediate assembly
 * without rewriting it — query keeps the default ledger reader (D12), and
 * the `feedbackStabilityByTrace` seam is only wired when a query actually
 * filters on stability, so the common path pays no extra scan.
 */
export interface DecisionServices {
  vaultRoot: string;
  policies: DecisionPolicyRepository;
  traces: DecisionTraceRepository;
  feedback: DecisionFeedbackRepository;
  resolvePolicy(ref: string): Promise<DecisionPolicy | null>;
  recordFeedback(input: unknown): Promise<RecordFeedbackResult>;
  checkConsistency(
    params?: CheckDecisionConsistencyParams,
  ): Promise<DecisionConsistencyReport>;
  query(query: DecisionQuery): Promise<DecisionProjection>;
  migrateLegacy(input: MigrateLegacyDecisionsInput): Promise<MigrationReport>;
}

export function createDecisionServices(
  root?: string,
  options: DecisionServiceContextOptions = {},
): DecisionServices {
  const ctx = createDecisionServiceContext(root, options);
  return {
    vaultRoot: ctx.vaultRoot,
    policies: ctx.policies,
    traces: ctx.traces,
    feedback: ctx.feedback,
    resolvePolicy: (ref) => ctx.policies.get(ref as PolicyRef),
    recordFeedback: (input) => recordDecisionFeedback(ctx, input),
    checkConsistency: (params) => checkDecisionConsistency(ctx, params),
    query: async (query) => {
      let feedbackStabilityByTrace: QueryDecisionsDeps['feedbackStabilityByTrace'];
      if (query.stability !== undefined) {
        const stabilityByTrace = latestStabilityByTrace(
          await ctx.feedback.listForAggregation(),
        );
        feedbackStabilityByTrace = (candidate) => stabilityByTrace.get(candidate.trace_id);
      }
      return queryDecisions(
        { root: ctx.vaultRoot },
        query,
        feedbackStabilityByTrace === undefined ? {} : { feedbackStabilityByTrace },
      );
    },
    migrateLegacy: (input) => migrateLegacyDecisions(ctx, input),
  };
}
