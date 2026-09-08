import { join } from 'node:path';

import type { FeedbackSample } from '../domain/decision-feedback.js';
import {
  decisionTraceSchema,
  deriveFeedbackSummary,
  deriveTraceStatus,
  type DecisionTrace,
  type DerivedFeedbackSummary,
  type TraceStatus,
} from '../domain/decision-trace.js';
import { parseDecisionDocument } from '../storage/decision-document.js';
import {
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from '../storage/file-io.js';
import type { DecisionServiceContext } from './service-context.js';

export type DecisionConsistencyIssueCode =
  | 'feedback_summary_stale'
  | 'feedback_summary_mismatch'
  | 'decision_consistency_violation';

export interface DecisionConsistencyIssue {
  trace_id: string;
  issue: DecisionConsistencyIssueCode;
  action: 'rebuilt' | 'reported';
  detail: string;
}

export interface DecisionConsistencyReport {
  checked_traces: number;
  issues: DecisionConsistencyIssue[];
}

export interface CheckDecisionConsistencyParams {
  repair?: boolean;
}

function systemRoot(root: string): string {
  return join(root, '07_System');
}

function decisionTracesRoot(root: string): string {
  return join(root, '07_System', 'Logs', 'Decision_Traces');
}

function readBoundary(root: string): StorageReadBoundary {
  return {
    vaultRoot: root,
    tasksRoot: systemRoot(root),
    subtree: decisionTracesRoot(root),
  };
}

function parseNativeTrace(raw: string): DecisionTrace | null {
  let document: ReturnType<typeof parseDecisionDocument>;
  try {
    document = parseDecisionDocument(raw);
  } catch {
    return null;
  }
  const parsed = decisionTraceSchema.safeParse(document.data);
  return parsed.success ? parsed.data : null;
}

/**
 * Native traces only: legacy harness documents are read-only bystanders with
 * no native feedback samples, so they are skipped, never parsed into state.
 */
async function listNativeTraces(root: string): Promise<DecisionTrace[]> {
  const boundary = readBoundary(root);
  const paths = await listSafeRegularFiles(boundary, '**/*.md');
  const traces: DecisionTrace[] = [];
  for (const path of paths) {
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      continue;
    }
    const trace = parseNativeTrace(raw);
    if (trace !== null) {
      traces.push(trace);
    }
  }
  return traces.sort((left, right) => {
    const delta = Date.parse(left.created_at) - Date.parse(right.created_at);
    if (delta !== 0) {
      return delta;
    }
    return left.trace_id < right.trace_id ? -1 : 1;
  });
}

/** The summary claims feedback that no persisted sample backs (data loss). */
function summaryAheadOfSamples(trace: DecisionTrace): boolean {
  return trace.feedback_count !== 0
    || trace.latest_feedback_at !== null
    || trace.user_feedback !== 'unreviewed'
    || trace.final_outcome !== 'pending';
}

function fieldMismatches(
  trace: DecisionTrace,
  derived: DerivedFeedbackSummary,
  expectedStatus: TraceStatus,
): string[] {
  const mismatches: string[] = [];
  if (trace.user_feedback !== derived.user_feedback) {
    mismatches.push(`user_feedback=${trace.user_feedback} -> ${derived.user_feedback}`);
  }
  if (trace.final_outcome !== derived.final_outcome) {
    mismatches.push(`final_outcome=${trace.final_outcome} -> ${derived.final_outcome}`);
  }
  if (trace.feedback_count !== derived.feedback_count) {
    mismatches.push(`feedback_count=${trace.feedback_count} -> ${derived.feedback_count}`);
  }
  if (trace.latest_feedback_at !== derived.latest_feedback_at) {
    mismatches.push(
      `latest_feedback_at=${trace.latest_feedback_at ?? 'null'} -> ${derived.latest_feedback_at ?? 'null'}`,
    );
  }
  if (trace.status !== expectedStatus) {
    mismatches.push(`status=${trace.status} -> ${expectedStatus}`);
  }
  if (trace.feedback_summary_status === 'stale') {
    mismatches.push('feedback_summary_status=stale -> fresh');
  }
  return mismatches;
}

function groupSamplesByTrace(samples: FeedbackSample[]): Map<string, FeedbackSample[]> {
  const groups = new Map<string, FeedbackSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.trace_id);
    if (group === undefined) {
      groups.set(sample.trace_id, [sample]);
    } else {
      group.push(sample);
    }
  }
  return groups;
}

interface TraceFinding {
  code: DecisionConsistencyIssueCode;
  detail: string;
  derived?: DerivedFeedbackSummary;
}

/**
 * Classifies one trace against its sample set: `null` when consistent, a
 * violation when the summary claims feedback no sample backs (never masked by
 * repair), otherwise a rebuildable stale/mismatch finding.
 */
function evaluateTrace(trace: DecisionTrace, samples: FeedbackSample[]): TraceFinding | null {
  if (samples.length === 0 && summaryAheadOfSamples(trace)) {
    return {
      code: 'decision_consistency_violation',
      detail: `summary ahead of samples with none persisted: feedback_count=${trace.feedback_count}, user_feedback=${trace.user_feedback}, latest_feedback_at=${trace.latest_feedback_at ?? 'null'}`,
    };
  }
  const derived = deriveFeedbackSummary(samples, trace);
  const expectedStatus = deriveTraceStatus(samples, trace.closed_at ?? null);
  const mismatches = fieldMismatches(trace, derived, expectedStatus);
  if (mismatches.length === 0) {
    return null;
  }
  const lagging = trace.feedback_count < samples.length
    || trace.feedback_summary_status === 'stale';
  return {
    code: lagging ? 'feedback_summary_stale' : 'feedback_summary_mismatch',
    detail: mismatches.join('; '),
    derived,
  };
}

/**
 * Consistency check (PRD acceptance 4): samples are the immutable source of
 * truth, trace summaries are rebuildable projections. Repair rebuilds only
 * summaries via CAS and never rewrites samples; structural violations (orphan
 * samples, summaries ahead of their samples) are reported, never masked.
 */
export async function checkDecisionConsistency(
  ctx: DecisionServiceContext,
  params: CheckDecisionConsistencyParams = {},
): Promise<DecisionConsistencyReport> {
  const traces = await listNativeTraces(ctx.vaultRoot);
  const allSamples = await ctx.feedback.listForAggregation();
  const samplesByTrace = groupSamplesByTrace(allSamples);
  const nativeTraceIds = new Set(traces.map((trace) => trace.trace_id));
  const issues: DecisionConsistencyIssue[] = [];

  for (const trace of traces) {
    const finding = evaluateTrace(trace, samplesByTrace.get(trace.trace_id) ?? []);
    if (finding === null) {
      continue;
    }
    if (params.repair === true && finding.derived !== undefined) {
      await ctx.traces.updateFeedbackSummary(trace.trace_id, finding.derived);
    }
    issues.push({
      trace_id: trace.trace_id,
      issue: finding.code,
      action: params.repair === true && finding.derived !== undefined ? 'rebuilt' : 'reported',
      detail: finding.detail,
    });
  }

  const orphanTraceIds = [...samplesByTrace.keys()]
    .filter((traceId) => !nativeTraceIds.has(traceId))
    .sort();
  for (const traceId of orphanTraceIds) {
    const orphans = samplesByTrace.get(traceId) ?? [];
    issues.push({
      trace_id: traceId,
      issue: 'decision_consistency_violation',
      action: 'reported',
      detail: `orphan samples reference a missing native trace: ${orphans
        .map((sample) => sample.feedback_id)
        .sort()
        .join(', ')}`,
    });
  }

  return { checked_traces: traces.length, issues };
}
