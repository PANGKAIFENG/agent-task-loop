import {
  artifactIdentityMatches,
  artifactNodeId,
  isValidArtifactIdentity,
  type ArtifactIdentity,
} from '../domain/artifact-identity.js';
import {
  validateArtifactLineage,
  type ArtifactContextManifestEvidence,
  type ArtifactLineageReport,
  type ArtifactRuntimePackEvidence,
} from '../domain/artifact-lineage.js';
import {
  isValidArtifactSettlementPlan,
  isValidArtifactSettlementReceipt,
  type ArtifactSettlementPlan,
  type ArtifactSettlementReceipt,
} from '../domain/artifact-settlement.js';
import {
  isValidContextManifest,
  type ContextManifest,
} from '../domain/context-manifest.js';
import {
  isValidExecutionBindingReceipt,
  type ExecutionBindingReceipt,
} from '../domain/execution-binding.js';
import {
  feedbackSampleSchema,
  type FeedbackSample,
} from '../domain/decision-feedback.js';
import {
  deriveFeedbackSummary,
  deriveTraceStatus,
  decisionTraceSchema,
  type DecisionTrace,
} from '../domain/decision-trace.js';
import {
  isValidRuntimePackEvidence,
  type PersistedRuntimePackEvidence,
  type RuntimePack,
} from '../runner/runtime-pack.js';
import {
  isValidArtifactTriggerReceipt,
  type ArtifactTriggerReceipt,
} from './start-artifact-trigger.js';
import type { PersistedArtifactProductionEvidence } from '../storage/file-artifact-production-evidence-repository.js';

export interface PersistedArtifactDecision {
  decisionId: string;
  traceId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
}

export interface ArtifactLineageEvidenceRepository {
  getArtifactProduction(
    artifactRef: string,
  ): Promise<PersistedArtifactProductionEvidence | null>;
  getCurrentArtifact(taskId: string): Promise<ArtifactIdentity | null>;
  getExecutionBinding(receiptId: string): Promise<ExecutionBindingReceipt | null>;
  getRuntimePack(packId: string): Promise<PersistedRuntimePackEvidence | null>;
  getRuntimePackForRun(
    taskId: string,
    runId: string,
  ): Promise<PersistedRuntimePackEvidence | null>;
  getContextManifest(manifestId: string): Promise<ContextManifest | null>;
  getDecision(decisionId: string): Promise<PersistedArtifactDecision | null>;
  getTrace(traceId: string): Promise<DecisionTrace | null>;
  listFeedback(traceId: string): Promise<FeedbackSample[]>;
  getTrigger(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactTriggerReceipt | null>;
  getSettlementPlan(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactSettlementPlan | null>;
  getSettlementReceipt(planId: string): Promise<ArtifactSettlementReceipt | null>;
}

export interface RebuildArtifactLineageDependencies {
  repository: ArtifactLineageEvidenceRepository;
}

export interface RebuildArtifactLineageInput {
  taskId: string;
  artifactRef: string;
  decisionId: string;
}

export class ArtifactLineageEvidenceError extends Error {
  readonly code = 'artifact_lineage_evidence_invalid';

  constructor() {
    super('Persisted Artifact lineage evidence is missing or invalid');
    this.name = 'ArtifactLineageEvidenceError';
  }
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isValidPersistedRuntimePack(
  evidence: PersistedRuntimePackEvidence,
): boolean {
  return isValidRuntimePackEvidence(evidence);
}

function manifestEvidence(manifest: ContextManifest): ArtifactContextManifestEvidence {
  return {
    manifestId: manifest.manifestId,
    sha256: manifest.sha256,
    taskId: manifest.taskId,
    runId: manifest.runId,
    status: manifest.status,
  };
}

function runtimePackEvidence(
  persisted: PersistedRuntimePackEvidence,
): ArtifactRuntimePackEvidence {
  const { pack } = persisted;
  return {
    packId: pack.packId,
    sha256: persisted.sha256,
    taskId: pack.taskId,
    runId: pack.runId,
    continuationOfRunId: pack.continuationOfRunId,
    contextManifestId: pack.contextManifestId!,
    contextManifestSha256: pack.contextManifestSha256!,
  };
}

function validDecision(
  decision: PersistedArtifactDecision,
  input: RebuildArtifactLineageInput,
  artifact: ArtifactIdentity,
): boolean {
  return decision.decisionId === input.decisionId
    && decision.traceId.trim() !== ''
    && artifactIdentityMatches(artifact, {
      taskId: input.taskId,
      ref: decision.artifactRef,
      version: decision.artifactVersion,
      sha256: decision.artifactSha256,
    });
}

function validTrace(
  trace: DecisionTrace,
  decision: PersistedArtifactDecision,
  manifest: ContextManifest,
  artifact: ArtifactIdentity,
): boolean {
  if (!decisionTraceSchema.safeParse(trace).success || trace.trace_id !== decision.traceId) {
    return false;
  }
  const artifactNode = artifactNodeId(artifact);
  return trace.input_refs.includes(`context-manifest:${manifest.manifestId}`)
    && trace.input_refs.includes(artifactNode)
    && trace.evidence_refs.includes(artifactNode);
}

function validFeedback(
  feedback: FeedbackSample[],
  trace: DecisionTrace,
): boolean {
  if (!unique(feedback.map(({ feedback_id: feedbackId }) => feedbackId))) return false;
  if (!feedback.every((sample) => (
    feedbackSampleSchema.safeParse(sample).success
    && sample.trace_id === trace.trace_id
  ))) return false;
  const summary = deriveFeedbackSummary(feedback, trace);
  return trace.user_feedback === summary.user_feedback
    && trace.final_outcome === summary.final_outcome
    && trace.feedback_count === summary.feedback_count
    && trace.latest_feedback_at === summary.latest_feedback_at
    && trace.status === deriveTraceStatus(feedback, trace.closed_at ?? null)
    && trace.feedback_summary_status === 'fresh';
}

function runtimePackMatchesManifest(
  pack: RuntimePack,
  manifest: ContextManifest,
): boolean {
  const consumed = manifest.entries.filter(({ status }) => status === 'consumed');
  if (pack.blocks.length !== consumed.length) return false;
  const entriesByLabel = new Map(consumed.map((entry) => [entry.blockLabel!, entry]));
  return entriesByLabel.size === consumed.length
    && pack.blocks.every((block) => {
      const entry = entriesByLabel.get(block.label);
      return entry !== undefined
        && entry.kind === block.kind
        && entry.category === block.category
        && entry.sourceRef === block.sourceRef
        && entry.version === block.version
        && entry.readRef === block.readRef
        && entry.sha256 === block.sha256;
    });
}

function validTrigger(
  trigger: ArtifactTriggerReceipt,
  input: RebuildArtifactLineageInput,
  sourceRunId: string,
  artifact: ArtifactIdentity,
  executionTarget: 'local' | 'multica',
): boolean {
  return isValidArtifactTriggerReceipt(trigger)
    && trigger.taskId === input.taskId
    && trigger.sourceRunId === sourceRunId
    && trigger.executionTarget === executionTarget
    && trigger.decisionId === input.decisionId
    && artifactIdentityMatches(artifact, {
      taskId: input.taskId,
      ref: trigger.artifactRef,
      version: trigger.artifactVersion,
      sha256: trigger.artifactSha256,
    })
    && Number.isFinite(Date.parse(trigger.createdAt))
    && Number.isFinite(Date.parse(trigger.updatedAt))
    && (
      (trigger.state === 'started'
        && trigger.continuationRunId !== null
        && trigger.continuationRunId.trim() !== '')
      || (trigger.state !== 'started' && trigger.continuationRunId === null)
    );
}

async function loadManifest(
  repository: ArtifactLineageEvidenceRepository,
  manifestId: string,
  manifestSha256: string,
  taskId: string,
  runId: string,
): Promise<ContextManifest> {
  const manifest = await repository.getContextManifest(manifestId);
  if (
    manifest === null
    || manifest.manifestId !== manifestId
    || manifest.sha256 !== manifestSha256
    || manifest.taskId !== taskId
    || manifest.runId !== runId
    || manifest.status !== 'ready'
    || !isValidContextManifest(manifest)
  ) throw new ArtifactLineageEvidenceError();
  return manifest;
}

export async function rebuildArtifactLineage(
  dependencies: RebuildArtifactLineageDependencies,
  input: RebuildArtifactLineageInput,
): Promise<ArtifactLineageReport> {
  const { repository } = dependencies;
  if (
    input.taskId.trim() === ''
    || input.artifactRef.trim() === ''
    || input.decisionId.trim() === ''
  ) throw new ArtifactLineageEvidenceError();

  const artifactProduction = await repository.getArtifactProduction(input.artifactRef);
  const currentArtifact = await repository.getCurrentArtifact(input.taskId);
  if (
    artifactProduction === null
    || currentArtifact === null
    || artifactProduction.identity.taskId !== input.taskId
    || artifactProduction.identity.ref !== input.artifactRef
    || !isValidArtifactIdentity(artifactProduction.identity)
    || !isValidArtifactIdentity(currentArtifact)
    || !artifactIdentityMatches(artifactProduction.identity, currentArtifact)
    || artifactProduction.runId.trim() === ''
  ) throw new ArtifactLineageEvidenceError();
  const artifact = artifactProduction.identity;

  const executionTarget = 'packId' in artifactProduction ? 'local' : 'multica';
  let sourcePack: PersistedRuntimePackEvidence | null = null;
  let sourceBinding: ExecutionBindingReceipt | null = null;
  let sourceManifest: ContextManifest;
  if ('packId' in artifactProduction) {
    sourcePack = await repository.getRuntimePack(artifactProduction.packId);
    if (
      sourcePack === null
      || sourcePack.pack.packId !== artifactProduction.packId
      || sourcePack.pack.taskId !== input.taskId
      || sourcePack.pack.runId !== artifactProduction.runId
      || sourcePack.pack.continuationOfRunId !== null
      || !isValidPersistedRuntimePack(sourcePack)
    ) throw new ArtifactLineageEvidenceError();
    sourceManifest = await loadManifest(
      repository,
      sourcePack.pack.contextManifestId!,
      sourcePack.pack.contextManifestSha256!,
      input.taskId,
      artifactProduction.runId,
    );
    if (!runtimePackMatchesManifest(sourcePack.pack, sourceManifest)) {
      throw new ArtifactLineageEvidenceError();
    }
  } else {
    sourceBinding = await repository.getExecutionBinding(
      artifactProduction.executionBindingReceiptId,
    );
    if (
      sourceBinding === null
      || !isValidExecutionBindingReceipt(sourceBinding)
      || sourceBinding.receiptId !== artifactProduction.executionBindingReceiptId
      || sourceBinding.taskId !== input.taskId
      || sourceBinding.manifestId !== artifactProduction.manifestId
      || sourceBinding.manifestSha256 !== artifactProduction.manifestSha256
      || sourceBinding.issueId !== artifactProduction.issueId
      || sourceBinding.run.runId !== artifactProduction.runId
    ) throw new ArtifactLineageEvidenceError();
    sourceManifest = await loadManifest(
      repository,
      sourceBinding.manifestId,
      sourceBinding.manifestSha256,
      input.taskId,
      sourceBinding.dispatchAttemptId,
    );
  }

  const decision = await repository.getDecision(input.decisionId);
  if (decision === null || !validDecision(decision, input, artifact)) {
    throw new ArtifactLineageEvidenceError();
  }
  const trace = await repository.getTrace(decision.traceId);
  if (trace === null || !validTrace(trace, decision, sourceManifest, artifact)) {
    throw new ArtifactLineageEvidenceError();
  }
  const feedback = await repository.listFeedback(trace.trace_id);
  if (!validFeedback(feedback, trace)) throw new ArtifactLineageEvidenceError();

  const trigger = await repository.getTrigger(input.decisionId, input.artifactRef);
  let continuation: Parameters<typeof validateArtifactLineage>[0]['continuation'] = null;
  if (trigger !== null) {
    if (!validTrigger(
      trigger,
      input,
      artifactProduction.runId,
      artifact,
      executionTarget,
    )) {
      throw new ArtifactLineageEvidenceError();
    }
    if (trigger.state === 'started') {
      if (executionTarget === 'multica') {
        if (sourceBinding === null) throw new ArtifactLineageEvidenceError();
        continuation = {
          executionTarget: 'multica',
          runId: trigger.continuationRunId!,
          continuationOfRunId: artifactProduction.runId,
          taskId: input.taskId,
          issueId: sourceBinding.issueId,
        };
      } else {
        const continuationPack = await repository.getRuntimePackForRun(
          input.taskId,
          trigger.continuationRunId!,
        );
        if (
          continuationPack === null
          || continuationPack.pack.taskId !== input.taskId
          || continuationPack.pack.runId !== trigger.continuationRunId
          || continuationPack.pack.continuationOfRunId !== artifactProduction.runId
          || !isValidPersistedRuntimePack(continuationPack)
        ) throw new ArtifactLineageEvidenceError();
        const continuationManifest = await loadManifest(
          repository,
          continuationPack.pack.contextManifestId!,
          continuationPack.pack.contextManifestSha256!,
          input.taskId,
          continuationPack.pack.runId,
        );
        if (!runtimePackMatchesManifest(continuationPack.pack, continuationManifest)) {
          throw new ArtifactLineageEvidenceError();
        }
        continuation = {
          executionTarget: 'local',
          runId: continuationPack.pack.runId,
          continuationOfRunId: artifactProduction.runId,
          taskId: input.taskId,
          contextManifest: manifestEvidence(continuationManifest),
          runtimePack: runtimePackEvidence(continuationPack),
        };
      }
    }
  }

  const settlementPlan = await repository.getSettlementPlan(
    input.decisionId,
    input.artifactRef,
  );
  let settlement: Parameters<typeof validateArtifactLineage>[0]['settlement'] = null;
  if (settlementPlan !== null) {
    if (
      !isValidArtifactSettlementPlan(settlementPlan)
      || settlementPlan.decisionId !== input.decisionId
      || !artifactIdentityMatches(settlementPlan.artifact, artifact)
    ) throw new ArtifactLineageEvidenceError();
    const receipt = await repository.getSettlementReceipt(settlementPlan.planId);
    if (
      receipt !== null
      && (
        receipt.status !== 'completed'
        || !isValidArtifactSettlementReceipt(receipt, settlementPlan)
      )
    ) throw new ArtifactLineageEvidenceError();
    settlement = {
      planId: settlementPlan.planId,
      receiptId: receipt?.receiptId ?? null,
      decisionId: settlementPlan.decisionId,
      artifactRef: settlementPlan.artifact.ref,
      artifactVersion: settlementPlan.artifact.version,
      artifactSha256: settlementPlan.artifact.sha256,
    };
  }

  const report = validateArtifactLineage({
    taskId: input.taskId,
    sourceRunId: artifactProduction.runId,
    contextManifest: manifestEvidence(sourceManifest),
    sourceRuntimePack: sourcePack === null ? null : runtimePackEvidence(sourcePack),
    sourceExecutionBinding: sourceBinding === null ? null : {
      receiptId: sourceBinding.receiptId,
      taskId: sourceBinding.taskId,
      dispatchAttemptId: sourceBinding.dispatchAttemptId,
      manifestId: sourceBinding.manifestId,
      manifestSha256: sourceBinding.manifestSha256,
      issueId: sourceBinding.issueId,
      runId: sourceBinding.run.runId,
    },
    artifactProduction,
    currentArtifact,
    artifact,
    decision,
    feedback: feedback.map((sample) => ({
      feedbackId: sample.feedback_id,
      traceId: sample.trace_id,
    })),
    trigger: trigger === null ? null : {
      triggerId: trigger.idempotencyKey,
      receiptId: trigger.receiptId,
      decisionId: trigger.decisionId,
      artifactRef: trigger.artifactRef,
      artifactVersion: trigger.artifactVersion,
      artifactSha256: trigger.artifactSha256,
      executionTarget: trigger.executionTarget,
      state: trigger.state,
      continuationRunId: trigger.continuationRunId,
    },
    continuation,
    settlement,
  });
  if (report.status !== 'valid') throw new ArtifactLineageEvidenceError();
  return report;
}
