import { z } from 'zod';

import type { AuditEvent } from '../storage/contracts.js';
import type { ServiceContext } from './service-context.js';

const evalDetailsSchema = z.object({
  decision: z.enum(['approve', 'request_changes', 'block', 'cancel']),
  evalSampleId: z.string().regex(/^eval-[0-9a-f]{24}$/u),
  evalSampleType: z.literal('capability'),
  evalSampleStatus: z.literal('pending_review'),
  regressionCandidateStatus: z.enum(['not_proposed', 'pending_review']),
  packId: z.string().regex(/^pack-[0-9a-f]{24}$/u),
  packSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  executionProfileId: z.literal('research_v1'),
  executionProfileVersion: z.literal(1),
  executionProfileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  artifactRef: z.string().min(1).max(500),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  runOutcome: z.literal('artifact_submitted'),
  humanOutcome: z.enum(['approve', 'request_changes', 'block', 'cancel']),
  feedbackSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  harnessMutationAllowed: z.literal(false),
}).passthrough();

export interface CapabilityEvalSample {
  sampleId: string;
  taskId: string;
  runId: string;
  reviewedAt: string;
  pack: { id: string; sha256: string };
  profile: { id: 'research_v1'; version: 1; sha256: string };
  artifact: { ref: string; sha256: string };
  runOutcome: 'artifact_submitted';
  humanOutcome: 'approve' | 'request_changes' | 'block' | 'cancel';
  feedbackSha256: string | null;
  status: 'pending_review';
  harnessMutationAllowed: false;
}

export interface RegressionEvalCandidate {
  sampleId: string;
  taskId: string;
  runId: string;
  humanOutcome: 'request_changes' | 'block' | 'cancel';
  feedbackSha256: string;
  candidateStatus: 'pending_review';
  promoted: false;
}

export interface EvalSampleQueryResult {
  capabilitySamples: CapabilityEvalSample[];
  regressionCandidates: RegressionEvalCandidate[];
}

function capabilitySample(event: AuditEvent): CapabilityEvalSample | null {
  if (
    event.event !== 'task.reviewed'
    || event.taskId === undefined
    || event.runId === undefined
  ) {
    return null;
  }
  const parsed = evalDetailsSchema.safeParse(event.details);
  if (!parsed.success || parsed.data.decision !== parsed.data.humanOutcome) {
    return null;
  }
  return {
    sampleId: parsed.data.evalSampleId,
    taskId: event.taskId,
    runId: event.runId,
    reviewedAt: event.at,
    pack: { id: parsed.data.packId, sha256: parsed.data.packSha256 },
    profile: {
      id: parsed.data.executionProfileId,
      version: parsed.data.executionProfileVersion,
      sha256: parsed.data.executionProfileSha256,
    },
    artifact: {
      ref: parsed.data.artifactRef,
      sha256: parsed.data.artifactSha256,
    },
    runOutcome: parsed.data.runOutcome,
    humanOutcome: parsed.data.humanOutcome,
    feedbackSha256: parsed.data.feedbackSha256,
    status: parsed.data.evalSampleStatus,
    harnessMutationAllowed: parsed.data.harnessMutationAllowed,
  };
}

function compareSamples(left: CapabilityEvalSample, right: CapabilityEvalSample): number {
  return Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt)
    || left.sampleId.localeCompare(right.sampleId);
}

export async function queryEvalSamples(
  ctx: ServiceContext,
): Promise<EvalSampleQueryResult> {
  const tasks = await ctx.tasks.list();
  const events = (await Promise.all(
    tasks.map(({ taskId }) => ctx.audit.listForTask(taskId)),
  )).flat();
  const capabilitySamples = events
    .map(capabilitySample)
    .filter((sample): sample is CapabilityEvalSample => sample !== null)
    .sort(compareSamples);
  const regressionCandidates = capabilitySamples.flatMap((sample) => (
    sample.humanOutcome === 'approve' || sample.feedbackSha256 === null
      ? []
      : [{
          sampleId: sample.sampleId,
          taskId: sample.taskId,
          runId: sample.runId,
          humanOutcome: sample.humanOutcome,
          feedbackSha256: sample.feedbackSha256,
          candidateStatus: 'pending_review' as const,
          promoted: false as const,
        }]
  ));
  return { capabilitySamples, regressionCandidates };
}
