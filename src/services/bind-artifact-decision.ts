import { artifactNodeId } from '../domain/artifact-identity.js';
import { createArtifactDecisionBinding } from '../domain/artifact-decision.js';
import type { TaskRepository } from '../storage/contracts.js';
import type { ArtifactProductionEvidenceReader } from '../storage/file-artifact-production-evidence-repository.js';
import type { FileArtifactDecisionRepository } from '../storage/file-artifact-decision-repository.js';
import type { DecisionTraceRepository } from '../storage/markdown-decision-trace-repository.js';

export interface BindArtifactDecisionDependencies {
  tasks: TaskRepository;
  artifacts: ArtifactProductionEvidenceReader;
  traces: DecisionTraceRepository;
  decisions: FileArtifactDecisionRepository;
  clock: () => Date;
}

export interface BindArtifactDecisionInput {
  taskId: string;
  artifactRef: string;
  traceId: string;
}

export class ArtifactDecisionBindingInvalidError extends Error {
  readonly code = 'artifact_decision_binding_invalid';

  constructor() {
    super('Artifact Decision must bind the current persisted Artifact and Trace');
    this.name = 'ArtifactDecisionBindingInvalidError';
  }
}

export async function bindArtifactDecision(
  dependencies: BindArtifactDecisionDependencies,
  input: BindArtifactDecisionInput,
) {
  if (
    input.taskId.trim() === ''
    || input.artifactRef.trim() === ''
    || input.traceId.trim() === ''
  ) throw new ArtifactDecisionBindingInvalidError();
  const [task, artifactProduction, trace] = await Promise.all([
    dependencies.tasks.get(input.taskId),
    dependencies.artifacts.readProductionEvidence(input.artifactRef),
    dependencies.traces.get(input.traceId),
  ]);
  const artifact = artifactProduction.identity;
  const artifactNode = artifactNodeId(artifact);
  if (
    trace === null
    || task.artifactRefs.at(-1) !== input.artifactRef
    || artifact.taskId !== input.taskId
    || !trace.input_refs.includes(artifactNode)
    || !trace.evidence_refs.includes(artifactNode)
    || trace.input_refs.filter((ref) => ref.startsWith('context-manifest:')).length !== 1
  ) throw new ArtifactDecisionBindingInvalidError();
  const createdAt = dependencies.clock().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new ArtifactDecisionBindingInvalidError();
  }
  return dependencies.decisions.createOrGet(createArtifactDecisionBinding({
    traceId: trace.trace_id,
    artifact,
    createdAt,
  }));
}
