import type { ArtifactIdentity } from '../domain/artifact-identity.js';
import type { ContextManifest } from '../domain/context-manifest.js';
import type { FeedbackSample } from '../domain/decision-feedback.js';
import type { DecisionTrace } from '../domain/decision-trace.js';
import type { PersistedRuntimePackEvidence } from '../runner/runtime-pack.js';
import type {
  ArtifactLineageEvidenceRepository,
  PersistedArtifactDecision,
} from '../services/rebuild-artifact-lineage.js';
import type { ArtifactSettlementPlan, ArtifactSettlementReceipt } from '../domain/artifact-settlement.js';
import type { ArtifactTriggerReceipt } from '../services/start-artifact-trigger.js';
import { FileArtifactChainRuntimeEvidenceRepository } from './file-artifact-chain-runtime-evidence-repository.js';
import { FileArtifactDecisionRepository } from './file-artifact-decision-repository.js';
import {
  FileArtifactProductionEvidenceRepository,
  type PersistedArtifactProductionEvidence,
} from './file-artifact-production-evidence-repository.js';
import { FileArtifactSettlementRepository } from './file-artifact-settlement-repository.js';
import { FileArtifactTriggerRepository } from './file-artifact-trigger-repository.js';
import { FileExecutionBindingRepository } from './file-execution-binding-repository.js';
import { MarkdownDecisionFeedbackRepository } from './markdown-decision-feedback-repository.js';
import { MarkdownDecisionTraceRepository } from './markdown-decision-trace-repository.js';
import { MarkdownTaskRepository } from './markdown-task-repository.js';

/**
 * Phase 0 read composition for the public lineage query. It reuses the
 * authoritative Markdown and `.atl-runtime` repositories, including the
 * immutable Artifact-to-DecisionTrace binding and durable Trigger/settlement
 * evidence. Missing evidence is represented explicitly as null rather than
 * inferred from projections.
 */
export class FileBackedArtifactLineageEvidenceRepository
implements ArtifactLineageEvidenceRepository {
  private readonly tasks: MarkdownTaskRepository;
  private readonly productions: FileArtifactProductionEvidenceRepository;
  private readonly traces: MarkdownDecisionTraceRepository;
  private readonly feedback: MarkdownDecisionFeedbackRepository;
  private readonly runtime: FileArtifactChainRuntimeEvidenceRepository;
  private readonly decisions: FileArtifactDecisionRepository;
  private readonly triggers: FileArtifactTriggerRepository;
  private readonly settlements: FileArtifactSettlementRepository;
  private readonly bindings: FileExecutionBindingRepository;

  constructor(vaultRoot: string, runtimeRoot: string) {
    this.tasks = new MarkdownTaskRepository(vaultRoot);
    this.productions = new FileArtifactProductionEvidenceRepository(vaultRoot, runtimeRoot);
    this.traces = new MarkdownDecisionTraceRepository(vaultRoot);
    this.feedback = new MarkdownDecisionFeedbackRepository(vaultRoot);
    this.runtime = new FileArtifactChainRuntimeEvidenceRepository(runtimeRoot);
    this.decisions = new FileArtifactDecisionRepository(runtimeRoot);
    this.triggers = new FileArtifactTriggerRepository(runtimeRoot);
    this.settlements = new FileArtifactSettlementRepository(runtimeRoot);
    this.bindings = new FileExecutionBindingRepository(runtimeRoot);
  }

  getArtifactProduction(artifactRef: string): Promise<PersistedArtifactProductionEvidence> {
    return this.productions.readProductionEvidence(artifactRef);
  }

  async getCurrentArtifact(taskId: string): Promise<ArtifactIdentity | null> {
    const task = await this.tasks.get(taskId);
    const artifactRef = task.artifactRefs.at(-1);
    if (artifactRef === undefined) return null;
    const production = await this.productions.readProductionEvidence(artifactRef);
    return production.identity.taskId === taskId ? production.identity : null;
  }

  getExecutionBinding(receiptId: string) {
    return this.bindings.get(receiptId);
  }

  getRuntimePack(packId: string): Promise<PersistedRuntimePackEvidence | null> {
    return this.runtime.getRuntimePack(packId);
  }

  getRuntimePackForRun(
    taskId: string,
    runId: string,
  ): Promise<PersistedRuntimePackEvidence | null> {
    return this.runtime.getRuntimePackForRun(taskId, runId);
  }

  getContextManifest(manifestId: string): Promise<ContextManifest | null> {
    return this.runtime.getContextManifest(manifestId);
  }

  async getDecision(decisionId: string): Promise<PersistedArtifactDecision | null> {
    const binding = await this.decisions.get(decisionId);
    if (binding === null) return null;
    return {
      decisionId,
      traceId: binding.traceId,
      artifactRef: binding.artifact.ref,
      artifactVersion: binding.artifact.version,
      artifactSha256: binding.artifact.sha256,
    };
  }

  getTrace(traceId: string): Promise<DecisionTrace | null> {
    return this.traces.get(traceId);
  }

  listFeedback(traceId: string): Promise<FeedbackSample[]> {
    return this.feedback.listByTrace(traceId);
  }

  getTrigger(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactTriggerReceipt | null> {
    return this.triggers.findByDecisionArtifact(decisionId, artifactRef);
  }

  getSettlementPlan(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactSettlementPlan | null> {
    return this.settlements.findPlanByDecisionArtifact(decisionId, artifactRef);
  }

  getSettlementReceipt(
    planId: string,
  ): Promise<ArtifactSettlementReceipt | null> {
    return this.settlements.getReceipt(planId);
  }
}
