import {
  artifactIdentityMatches,
  artifactNodeId,
  isValidArtifactIdentity,
  type ArtifactIdentity,
} from './artifact-identity.js';

export interface ArtifactDecisionLink {
  decisionId: string;
  traceId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
}

export interface ArtifactFeedbackLink {
  feedbackId: string;
  traceId: string;
}

export interface ArtifactTriggerLink {
  triggerId: string;
  receiptId: string;
  decisionId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
  executionTarget?: 'local' | 'multica';
  state: 'starting' | 'started' | 'unknown';
  continuationRunId: string | null;
}

export interface ArtifactContextManifestEvidence {
  manifestId: string;
  sha256: string;
  taskId: string;
  runId: string;
  status: 'ready' | 'blocked';
}

export interface ArtifactRuntimePackEvidence {
  packId: string;
  sha256: string;
  taskId: string;
  runId: string;
  continuationOfRunId: string | null;
  contextManifestId: string;
  contextManifestSha256: string;
}

export interface ArtifactLocalProductionEvidence {
  identity: ArtifactIdentity;
  runId: string;
  packId: string;
}

export interface ArtifactRemoteProductionEvidence {
  identity: ArtifactIdentity;
  runId: string;
  executionBindingReceiptId: string;
  manifestId: string;
  manifestSha256: string;
  issueId: string;
}

export type ArtifactProductionEvidence =
  | ArtifactLocalProductionEvidence
  | ArtifactRemoteProductionEvidence;

export interface ArtifactExecutionBindingEvidence {
  receiptId: string;
  taskId: string;
  dispatchAttemptId: string;
  manifestId: string;
  manifestSha256: string;
  issueId: string;
  runId: string;
}

export interface ArtifactLocalContinuationLink {
  executionTarget?: 'local';
  runId: string;
  continuationOfRunId: string;
  taskId: string;
  contextManifest: ArtifactContextManifestEvidence;
  runtimePack: ArtifactRuntimePackEvidence;
}

export interface ArtifactRemoteContinuationLink {
  executionTarget: 'multica';
  runId: string;
  continuationOfRunId: string;
  taskId: string;
  issueId: string;
}

export type ArtifactContinuationLink =
  | ArtifactLocalContinuationLink
  | ArtifactRemoteContinuationLink;

export interface ArtifactSettlementLink {
  planId: string;
  receiptId: string | null;
  decisionId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
}

export interface ArtifactLineageInput {
  taskId: string;
  sourceRunId: string;
  contextManifest: ArtifactContextManifestEvidence;
  sourceRuntimePack: ArtifactRuntimePackEvidence | null;
  sourceExecutionBinding?: ArtifactExecutionBindingEvidence | null;
  artifactProduction: ArtifactProductionEvidence;
  currentArtifact: ArtifactIdentity;
  artifact: ArtifactIdentity;
  decision: ArtifactDecisionLink;
  feedback: ArtifactFeedbackLink[];
  trigger: ArtifactTriggerLink | null;
  continuation: ArtifactContinuationLink | null;
  settlement: ArtifactSettlementLink | null;
}

export interface ArtifactLineageIssue {
  code:
    | 'invalid_reference'
    | 'context_manifest_task_mismatch'
    | 'context_manifest_run_mismatch'
    | 'source_pack_manifest_mismatch'
    | 'source_execution_binding_mismatch'
    | 'artifact_task_mismatch'
    | 'artifact_not_current'
    | 'artifact_production_mismatch'
    | 'artifact_decision_mismatch'
    | 'feedback_trace_mismatch'
    | 'trigger_decision_mismatch'
    | 'trigger_artifact_mismatch'
    | 'trigger_continuation_mismatch'
    | 'continuation_parent_mismatch'
    | 'continuation_manifest_mismatch'
    | 'continuation_pack_manifest_mismatch'
    | 'remote_continuation_mismatch'
    | 'settlement_artifact_mismatch'
    | 'settlement_decision_mismatch';
  subject: string;
}

export interface ArtifactLineageEdge {
  from: string;
  to: string;
  relation: string;
}

export interface ArtifactLineageReport {
  status: 'valid' | 'invalid';
  issues: ArtifactLineageIssue[];
  nodes: string[];
  edges: ArtifactLineageEdge[];
}

function linkedArtifact(
  taskId: string,
  link: Pick<ArtifactDecisionLink, 'artifactRef' | 'artifactVersion' | 'artifactSha256'>,
): ArtifactIdentity {
  return {
    taskId,
    ref: link.artifactRef,
    version: link.artifactVersion,
    sha256: link.artifactSha256,
  };
}

function nonEmpty(values: Array<string | null>): boolean {
  return values.every((value) => value === null || value.trim() !== '');
}

function validManifestEvidence(manifest: ArtifactContextManifestEvidence): boolean {
  return /^cm_[0-9a-f]{24}$/u.test(manifest.manifestId)
    && /^[0-9a-f]{64}$/u.test(manifest.sha256)
    && manifest.taskId.trim() !== ''
    && manifest.runId.trim() !== '';
}

function validRuntimePackEvidence(pack: ArtifactRuntimePackEvidence): boolean {
  return /^pack-[0-9a-f]{24}$/u.test(pack.packId)
    && /^[0-9a-f]{64}$/u.test(pack.sha256)
    && pack.taskId.trim() !== ''
    && pack.runId.trim() !== ''
    && (pack.continuationOfRunId === null || pack.continuationOfRunId.trim() !== '')
    && /^cm_[0-9a-f]{24}$/u.test(pack.contextManifestId)
    && /^[0-9a-f]{64}$/u.test(pack.contextManifestSha256);
}

function validExecutionBindingEvidence(
  binding: ArtifactExecutionBindingEvidence,
): boolean {
  return /^ebr_[0-9a-f]{24}$/u.test(binding.receiptId)
    && binding.taskId.trim() !== ''
    && binding.dispatchAttemptId.trim() !== ''
    && /^cm_[0-9a-f]{24}$/u.test(binding.manifestId)
    && /^[0-9a-f]{64}$/u.test(binding.manifestSha256)
    && binding.issueId.trim() !== ''
    && binding.runId.trim() !== '';
}

function isLocalProduction(
  evidence: ArtifactProductionEvidence,
): evidence is ArtifactLocalProductionEvidence {
  return 'packId' in evidence;
}

function isRemoteContinuation(
  continuation: ArtifactContinuationLink,
): continuation is ArtifactRemoteContinuationLink {
  return continuation.executionTarget === 'multica';
}

function runtimePackMatchesManifest(
  pack: ArtifactRuntimePackEvidence,
  manifest: ArtifactContextManifestEvidence,
): boolean {
  return pack.taskId === manifest.taskId
    && pack.runId === manifest.runId
    && pack.contextManifestId === manifest.manifestId
    && pack.contextManifestSha256 === manifest.sha256
    && manifest.status === 'ready';
}

function addEdge(
  edges: ArtifactLineageEdge[],
  from: string,
  to: string,
  relation: string,
): void {
  edges.push({ from, to, relation });
}

export function validateArtifactLineage(
  input: ArtifactLineageInput,
): ArtifactLineageReport {
  const issues: ArtifactLineageIssue[] = [];
  const production = input.artifactProduction;
  const localProduction = isLocalProduction(production);
  const sourceBinding = input.sourceExecutionBinding ?? null;
  if (
    !nonEmpty([
      input.taskId,
      input.sourceRunId,
      input.contextManifest.manifestId,
      input.contextManifest.taskId,
      input.contextManifest.runId,
      input.artifactProduction.runId,
      input.decision.decisionId,
      input.decision.traceId,
      ...(input.sourceRuntimePack === null ? [] : [input.sourceRuntimePack.packId]),
      ...(sourceBinding === null ? [] : [sourceBinding.receiptId]),
    ])
    || !validManifestEvidence(input.contextManifest)
    || (input.sourceRuntimePack !== null && !validRuntimePackEvidence(input.sourceRuntimePack))
    || (sourceBinding !== null && !validExecutionBindingEvidence(sourceBinding))
    || !isValidArtifactIdentity(input.artifactProduction.identity)
    || !isValidArtifactIdentity(input.artifact)
    || !isValidArtifactIdentity(input.currentArtifact)
  ) {
    issues.push({ code: 'invalid_reference', subject: input.taskId });
  }
  if (input.contextManifest.taskId !== input.taskId) {
    issues.push({ code: 'context_manifest_task_mismatch', subject: input.contextManifest.manifestId });
  }
  const expectedManifestRunId = localProduction
    ? input.sourceRunId
    : sourceBinding?.dispatchAttemptId;
  if (
    expectedManifestRunId === undefined
    || input.contextManifest.runId !== expectedManifestRunId
  ) {
    issues.push({ code: 'context_manifest_run_mismatch', subject: input.contextManifest.manifestId });
  }
  if (localProduction) {
    if (
      input.sourceRuntimePack === null
      || sourceBinding !== null
      || !runtimePackMatchesManifest(input.sourceRuntimePack, input.contextManifest)
      || input.sourceRuntimePack.taskId !== input.taskId
      || input.sourceRuntimePack.runId !== input.sourceRunId
      || input.sourceRuntimePack.continuationOfRunId !== null
    ) {
      issues.push({
        code: 'source_pack_manifest_mismatch',
        subject: input.sourceRuntimePack?.packId ?? production.packId,
      });
    }
  } else if (
    input.sourceRuntimePack !== null
    || sourceBinding === null
    || sourceBinding.taskId !== input.taskId
    || sourceBinding.manifestId !== input.contextManifest.manifestId
    || sourceBinding.manifestSha256 !== input.contextManifest.sha256
    || sourceBinding.runId !== input.sourceRunId
    || sourceBinding.receiptId !== production.executionBindingReceiptId
    || sourceBinding.manifestId !== production.manifestId
    || sourceBinding.manifestSha256 !== production.manifestSha256
    || sourceBinding.issueId !== production.issueId
  ) {
    issues.push({
      code: 'source_execution_binding_mismatch',
      subject: sourceBinding?.receiptId ?? production.executionBindingReceiptId,
    });
  }
  if (input.artifact.taskId !== input.taskId) {
    issues.push({ code: 'artifact_task_mismatch', subject: input.artifact.ref });
  }
  if (!artifactIdentityMatches(input.artifact, input.currentArtifact)) {
    issues.push({ code: 'artifact_not_current', subject: input.artifact.ref });
  }
  if (
    !artifactIdentityMatches(input.artifact, production.identity)
    || production.runId !== input.sourceRunId
    || (localProduction
      ? input.sourceRuntimePack === null
        || production.packId !== input.sourceRuntimePack.packId
      : sourceBinding === null
        || production.executionBindingReceiptId !== sourceBinding.receiptId)
  ) {
    issues.push({ code: 'artifact_production_mismatch', subject: input.artifact.ref });
  }
  if (!artifactIdentityMatches(
    input.artifact,
    linkedArtifact(input.taskId, input.decision),
  )) {
    issues.push({ code: 'artifact_decision_mismatch', subject: input.decision.decisionId });
  }
  for (const feedback of input.feedback) {
    if (feedback.traceId !== input.decision.traceId) {
      issues.push({ code: 'feedback_trace_mismatch', subject: feedback.feedbackId });
    }
  }
  if (input.trigger !== null) {
    if (input.trigger.decisionId !== input.decision.decisionId) {
      issues.push({ code: 'trigger_decision_mismatch', subject: input.trigger.triggerId });
    }
    if (!artifactIdentityMatches(
      input.artifact,
      linkedArtifact(input.taskId, input.trigger),
    )) {
      issues.push({ code: 'trigger_artifact_mismatch', subject: input.trigger.triggerId });
    }
    if (
      input.trigger.state === 'started'
      && (
        input.continuation === null
        || input.trigger.continuationRunId !== input.continuation.runId
      )
    ) {
      issues.push({ code: 'trigger_continuation_mismatch', subject: input.trigger.triggerId });
    }
    if (
      input.trigger.state !== 'started'
      && input.trigger.continuationRunId !== null
    ) {
      issues.push({ code: 'trigger_continuation_mismatch', subject: input.trigger.triggerId });
    }
  } else if (input.continuation !== null) {
    issues.push({ code: 'trigger_continuation_mismatch', subject: input.continuation.runId });
  }
  if (
    input.continuation !== null
    && (
      input.continuation.taskId !== input.taskId
      || input.continuation.continuationOfRunId !== input.sourceRunId
    )
  ) {
    issues.push({ code: 'continuation_parent_mismatch', subject: input.continuation.runId });
  }
  if (input.continuation !== null && isRemoteContinuation(input.continuation)) {
    if (
      localProduction
      || (!localProduction && input.continuation.issueId !== production.issueId)
      || input.trigger?.executionTarget !== 'multica'
    ) {
      issues.push({
        code: 'remote_continuation_mismatch',
        subject: input.continuation.runId,
      });
    }
  } else if (input.continuation !== null) {
    if (
      !validManifestEvidence(input.continuation.contextManifest)
      || input.continuation.contextManifest.status !== 'ready'
      || input.continuation.contextManifest.taskId !== input.taskId
      || input.continuation.contextManifest.runId !== input.continuation.runId
    ) {
      issues.push({
        code: 'continuation_manifest_mismatch',
        subject: input.continuation.contextManifest.manifestId,
      });
    }
    if (
      !validRuntimePackEvidence(input.continuation.runtimePack)
      || !runtimePackMatchesManifest(
        input.continuation.runtimePack,
        input.continuation.contextManifest,
      )
      || input.continuation.runtimePack.taskId !== input.taskId
      || input.continuation.runtimePack.runId !== input.continuation.runId
      || input.continuation.runtimePack.continuationOfRunId !== input.sourceRunId
    ) {
      issues.push({
        code: 'continuation_pack_manifest_mismatch',
        subject: input.continuation.runtimePack.packId,
      });
    }
  }
  if (input.settlement !== null) {
    if (!artifactIdentityMatches(
      input.artifact,
      linkedArtifact(input.taskId, input.settlement),
    )) {
      issues.push({ code: 'settlement_artifact_mismatch', subject: input.settlement.planId });
    }
    if (input.settlement.decisionId !== input.decision.decisionId) {
      issues.push({ code: 'settlement_decision_mismatch', subject: input.settlement.planId });
    }
  }

  const manifestNode = `context-manifest:${input.contextManifest.manifestId}`;
  const sourceRunNode = `run:${input.sourceRunId}`;
  const artifactNode = artifactNodeId(input.artifact);
  const decisionNode = `decision:${input.decision.decisionId}`;
  const traceNode = `trace:${input.decision.traceId}`;
  const edges: ArtifactLineageEdge[] = [];
  if (localProduction && input.sourceRuntimePack !== null) {
    const sourcePackNode = `runtime-pack:${input.sourceRuntimePack.packId}`;
    addEdge(edges, manifestNode, sourcePackNode, 'bound_to');
    addEdge(edges, sourcePackNode, sourceRunNode, 'executed_as');
  } else if (!localProduction && sourceBinding !== null) {
    const bindingNode = `execution-binding:${sourceBinding.receiptId}`;
    addEdge(edges, manifestNode, bindingNode, 'bound_to');
    addEdge(edges, bindingNode, sourceRunNode, 'executed_as');
  }
  addEdge(edges, sourceRunNode, artifactNode, 'produced');
  addEdge(edges, artifactNode, decisionNode, 'reviewed_by');
  addEdge(edges, decisionNode, traceNode, 'explained_by');
  for (const feedback of input.feedback) {
    addEdge(edges, traceNode, `feedback:${feedback.feedbackId}`, 'received');
  }
  if (input.trigger !== null) {
    const triggerNode = `trigger:${input.trigger.triggerId}`;
    addEdge(edges, decisionNode, triggerNode, 'caused');
    if (input.continuation !== null) {
      const continuationRunNode = `run:${input.continuation.runId}`;
      addEdge(edges, triggerNode, continuationRunNode, 'continued_as');
      if (!isRemoteContinuation(input.continuation)) {
        const continuationManifestNode = (
          `context-manifest:${input.continuation.contextManifest.manifestId}`
        );
        const continuationPackNode = `runtime-pack:${input.continuation.runtimePack.packId}`;
        addEdge(edges, continuationManifestNode, continuationPackNode, 'bound_to');
        addEdge(edges, continuationPackNode, continuationRunNode, 'executed_as');
        addEdge(edges, continuationRunNode, continuationManifestNode, 'consumed_context');
      }
    }
  }
  if (input.settlement !== null) {
    const planNode = `settlement-plan:${input.settlement.planId}`;
    addEdge(edges, artifactNode, planNode, 'settled_by');
    addEdge(edges, decisionNode, planNode, 'authorized_by');
    if (input.settlement.receiptId !== null) {
      addEdge(edges, planNode, `settlement-receipt:${input.settlement.receiptId}`, 'recorded_as');
    }
  }
  const nodes = [...new Set(edges.flatMap(({ from, to }) => [from, to]))];
  return {
    status: issues.length === 0 ? 'valid' : 'invalid',
    issues,
    nodes,
    edges,
  };
}

export function relatedLineageNodes(
  report: ArtifactLineageReport,
  node: string,
): string[] {
  return [...new Set(report.edges.flatMap((edge) => {
    if (edge.from === node) return [edge.to];
    if (edge.to === node) return [edge.from];
    return [];
  }))].sort((left, right) => left.localeCompare(right));
}
