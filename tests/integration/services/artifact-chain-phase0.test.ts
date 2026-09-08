import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { artifactNodeId } from '../../../src/domain/artifact-identity.js';
import {
  relatedLineageNodes,
} from '../../../src/domain/artifact-lineage.js';
import { createArtifactSettlementPlan } from '../../../src/domain/artifact-settlement.js';
import {
  type FeedbackContextRule,
} from '../../../src/domain/context-consumption-proof.js';
import type { ContextCandidate } from '../../../src/domain/context-manifest.js';
import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import type { Project } from '../../../src/domain/project.js';
import {
  projectContextSha256,
  resolveProjectContext,
  type ResolvedProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import type { Task } from '../../../src/domain/task.js';
import { buildContextBundle } from '../../../src/runner/context-bundle.js';
import { persistContextManifest } from '../../../src/runner/context-manifest-runtime.js';
import { resolveExecutionProfile } from '../../../src/runner/execution-profile.js';
import { persistRuntimePack } from '../../../src/runner/runtime-pack.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';
import { proveContextConsumption } from '../../../src/services/prove-context-consumption.js';
import { rebuildArtifactLineage } from '../../../src/services/rebuild-artifact-lineage.js';
import { recordDecisionFeedback } from '../../../src/services/record-decision-feedback.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import {
  startArtifactTrigger,
  type ArtifactTriggerReceipt,
  type ArtifactTriggerRepository,
} from '../../../src/services/start-artifact-trigger.js';
import { submitArtifact } from '../../../src/services/submit-artifact.js';
import { FileArtifactChainRuntimeEvidenceRepository } from '../../../src/storage/file-artifact-chain-runtime-evidence-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const SOURCE_RUN_ID = 'run-synthetic-96-source';
const CONTINUATION_RUN_ID = 'run-synthetic-96-continuation';
const DECISION_ID = 'decision-synthetic-96-reuse';
const TRACE_ID = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';
const POLICY_REF = 'policy.artifact-chain.synthetic@v001';
const NOW = '2026-08-31T10:00:00.000Z';

class MemoryTriggerRepository implements ArtifactTriggerRepository {
  readonly records = new Map<string, ArtifactTriggerReceipt>();

  async withLock<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async get(idempotencyKey: string): Promise<ArtifactTriggerReceipt | null> {
    return this.records.get(idempotencyKey) ?? null;
  }

  async create(receipt: ArtifactTriggerReceipt): Promise<void> {
    this.records.set(receipt.idempotencyKey, receipt);
  }

  async save(receipt: ArtifactTriggerReceipt): Promise<void> {
    this.records.set(receipt.idempotencyKey, receipt);
  }
}

function task(projectId: string): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-synthetic-96',
    title: 'Choose a reusable Skill Eval control plane',
    body: '\nSynthetic TEP-96-shaped decision task.\n',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId,
    taskType: 'research',
    objective: 'Compare reuse, buy, and build options and recommend the next decision.',
    acceptanceCriteria: [
      'Present decision-ready options and tradeoffs.',
      'Preserve the selected project and code baseline identity.',
    ],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-31',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:tep-96',
    possibleDuplicateIds: [],
    priority: 'high',
    attempts: 1,
    claim: {
      runId: SOURCE_RUN_ID,
      agent: 'synthetic-senior-assistant',
      claimedAt: NOW,
      leaseExpiresAt: '2026-08-31T10:30:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function project(): Project {
  return {
    projectId: 'atl-skill-eval',
    name: 'Synthetic Skill Eval',
    description: 'A synthetic project for evaluating reusable Skill behavior.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resolvedProject(atlProject: Project): ResolvedProjectContext {
  const result = resolveProjectContext({
    requestedProjectId: null,
    sourceSignals: [{
      value: 'Skill Eval Platform',
      sourceRef: 'source://synthetic/tep-96',
    }],
    registry: [{
      projectId: 'project-skill-eval',
      aliases: ['Skill Eval Platform'],
      verification: 'verified',
      canonicalProjectRef: 'projects://skill-eval/home',
      atlProjectId: atlProject.projectId,
      repoRefs: ['repo://personal-ai-workbench@synthetic-baseline'],
    }],
    canonicalProjects: [{
      projectId: 'project-skill-eval',
      ref: 'projects://skill-eval/home',
      atlProjectId: atlProject.projectId,
      repoRefs: ['repo://personal-ai-workbench@synthetic-baseline'],
      version: 'v3',
      sha256: 'a'.repeat(64),
    }],
    atlProjects: [{
      project: atlProject,
      ref: `atl-project://${atlProject.projectId}`,
      canonicalProjectRef: 'projects://skill-eval/home',
      repoRefs: ['repo://personal-ai-workbench@synthetic-baseline'],
      sha256: projectContextSha256(atlProject),
    }],
  });
  if (result.status !== 'resolved') {
    throw new Error(`Synthetic project did not resolve: ${result.status}`);
  }
  return result;
}

function candidate(
  bundle: Awaited<ReturnType<typeof buildContextBundle>>,
  input: {
    candidateId: string;
    category: ContextCandidate['category'];
    blockLabel: string;
    selectionReason: string;
  },
): ContextCandidate {
  const block = bundle.blocks.find(({ label }) => label === input.blockLabel);
  if (block === undefined) throw new Error(`Missing synthetic block: ${input.blockLabel}`);
  return {
    ...input,
    sourceRef: block.sourceRef,
    version: block.version,
    expectedSha256: block.sha256,
    selection: 'selected',
  };
}

const policy: DecisionPolicy = {
  policy_id: 'policy.artifact-chain.synthetic',
  version: 'v001',
  status: 'observing',
  dimension: 'result-acceptance',
  decision_question: 'Is this Artifact ready to drive the next local action?',
  inputs: [{ name: 'artifact', source: 'synthetic_artifact' }],
  sources: ['synthetic_test'],
  rules: [{ statement: 'Bind the decision to the exact Artifact version and SHA.', priority: 1 }],
  exceptions: [],
  outputs: ['A bounded local continuation decision'],
  rationale: 'Synthetic policy used only to prove the Phase 0 lineage.',
  examples: [],
  counterexamples: [],
  metrics: ['lineage_integrity'],
  next_review_at: '2026-09-30',
  created_at: NOW,
  status_history: [],
};

const contexts: TestServiceContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('Artifact Chain Phase 0', () => {
  it('proves a TEP-96-shaped chain through settlement and later-run Feedback consumption', async () => {
    const harness = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(harness);
    const atlProject = project();
    const sourceTask = task(atlProject.projectId);
    await harness.ctx.projects.save(atlProject);
    await harness.ctx.tasks.save(sourceTask);
    const resolution = resolvedProject(atlProject);

    const userContextPath = join(harness.root, 'synthetic-user-context.md');
    await writeFile(
      userContextPath,
      'Prefer an initial decision-ready comparison before implementation detail.\n',
      'utf8',
    );
    const sourceBundle = await buildContextBundle(sourceTask, atlProject, {
      allowedLocalRoots: [harness.root],
      additionalLocalContexts: [{
        label: 'user_decision_style',
        kind: 'user_context',
        path: userContextPath,
        sourceRef: 'user-context://decision-style',
        version: 'v1',
      }],
    });
    const sourceManifest = await persistContextManifest(
      join(harness.root, '.atl-runtime'),
      {
        taskId: sourceTask.taskId,
        runId: SOURCE_RUN_ID,
        asOf: NOW,
        projectResolution: resolution,
        context: sourceBundle,
        candidates: [
          candidate(sourceBundle, {
            candidateId: 'tep96-task',
            category: 'task',
            blockLabel: 'task',
            selectionReason: 'The current decision objective is required.',
          }),
          candidate(sourceBundle, {
            candidateId: 'tep96-project',
            category: 'project',
            blockLabel: 'project',
            selectionReason: 'The verified project owns the decision.',
          }),
          candidate(sourceBundle, {
            candidateId: 'tep96-user-style',
            category: 'user_context',
            blockLabel: 'user_decision_style',
            selectionReason: 'The response maturity preference applies to this decision.',
          }),
        ],
      },
    );
    expect(sourceManifest.manifest.status).toBe('ready');
    const sourceRuntimePack = await persistRuntimePack(
      join(harness.root, '.atl-runtime'),
      {
        task: sourceTask,
        project: atlProject,
        context: sourceBundle,
        executionProfile: resolveExecutionProfile(sourceTask),
        contextManifest: {
          manifestId: sourceManifest.manifest.manifestId,
          sha256: sourceManifest.manifest.sha256,
        },
        asOf: NOW,
        expiresAt: sourceTask.claim!.leaseExpiresAt,
      },
    );

    const submitted = await submitArtifact(harness.ctx, sourceTask.taskId, {
      runId: SOURCE_RUN_ID,
      result: {
        summary: 'Reuse the open-source control plane for a bounded local proof before building.',
        findings: [
          'Reuse offers the fastest validation path.',
          'Buying reduces maintenance but limits local evaluation data ownership.',
          'Building now has the highest irreversible cost.',
        ],
        evidence: [{
          title: 'Synthetic public repository assessment',
          url: 'https://example.com/synthetic-skill-eval',
          accessedAt: NOW,
        }],
        uncertainties: ['Runtime integration still requires a separate evaluation.'],
        recommendedActions: ['Run a local reuse proof with an explicit stop condition.'],
        acceptance: sourceTask.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: 'met' as const,
          note: 'Covered by the synthetic option comparison.',
        })),
      },
      packId: sourceRuntimePack.packId,
    });
    const artifactRef = submitted.artifactRefs.at(-1);
    if (artifactRef === undefined) throw new Error('Synthetic Artifact was not submitted');
    const artifactSummary = await harness.ctx.artifacts.readSummary(artifactRef);
    const artifactProduction = await harness.ctx.artifacts.readProductionEvidence(artifactRef);
    const artifact = artifactProduction.identity;

    const decisionContext = createDecisionServiceContext(harness.root, {
      clock: () => new Date('2026-08-31T10:10:00.000Z'),
    });
    await decisionContext.policies.create(policy);
    await decisionContext.traces.create({
      trace_id: TRACE_ID,
      policy_ref: POLICY_REF,
      dimension: 'result-acceptance',
      input_refs: [
        `context-manifest:${sourceManifest.manifest.manifestId}`,
        artifactNodeId(artifact),
      ],
      decision: 'Reuse the open-source option for a bounded local proof.',
      reasoning_summary: 'It is the cheapest reversible action that tests the core uncertainty.',
      evidence_refs: [artifactNodeId(artifact)],
      confidence: 'medium',
      created_at: '2026-08-31T10:09:00.000Z',
    }, {
      policyResolver: (ref) => decisionContext.policies.get(ref as `${string}@${string}`),
    });
    const feedback = await recordDecisionFeedback(decisionContext, {
      trace_id: TRACE_ID,
      kind: 'corrected',
      stability: 'confirmed_pattern',
      correction_summary: 'For this project, lead with a decision-ready option comparison.',
      final_outcome: 'reuse-proof-approved',
      source_ref: 'synthetic-review://tep-96',
      idempotency_key: 'tep96-decision-ready-v1',
    });

    const triggerRepository = new MemoryTriggerRepository();
    const trigger = await startArtifactTrigger({
      repository: triggerRepository,
      clock: () => new Date('2026-08-31T10:15:00.000Z'),
      execute: async () => ({ status: 'started', runId: CONTINUATION_RUN_ID }),
    }, {
      idempotencyKey: 'tep96-reuse-proof-v1',
      executionTarget: 'local',
      taskId: sourceTask.taskId,
      sourceRunId: SOURCE_RUN_ID,
      decisionId: DECISION_ID,
      artifactRef: artifact.ref,
      artifactVersion: artifact.version,
      artifactSha256: artifact.sha256,
    });

    const settlementPath = join(harness.root, 'synthetic-project-decision.md');
    const settlementPlan = createArtifactSettlementPlan({
      artifact,
      decisionId: DECISION_ID,
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/key-decisions/reuse-proof',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-08-31T10:20:00.000Z',
    });
    const settlement = await executeArtifactSettlement(
      settlementPlan.planId,
      {
        repository: {
          getPlan: async (planId) => (
            planId === settlementPlan.planId ? settlementPlan : null
          ),
          getAuthorization: async (planId) => planId === settlementPlan.planId
            ? {
                schemaVersion: 1,
                authorizationId: 'authorization-synthetic-96-project-knowledge',
                planId: settlementPlan.planId,
                artifactRef: artifact.ref,
                artifactSha256: artifact.sha256,
                decisionId: DECISION_ID,
                logicalDestination: 'project_knowledge',
                vaultRoot: harness.root,
                targetRef: settlementPlan.targetRef!,
                requiredPermission: settlementPlan.requiredPermission!,
                authorizedAt: '2026-08-31T10:20:30.000Z',
                readBackReceipt: 'synthetic-readback://settlement-authorization-96',
              }
            : null,
        },
        writer: async () => {
        const content = [
          '# Synthetic project decision',
          '',
          `Artifact: ${artifactNodeId(artifact)}`,
          `Decision: ${DECISION_ID}`,
          '',
        ].join('\n');
        await writeFile(settlementPath, content, 'utf8');
        const readback = await readFile(settlementPath, 'utf8');
        return {
          status: 'completed',
          writes: [{
            targetRef: 'projects://skill-eval/key-decisions/reuse-proof',
            version: 'v1',
            sha256: createHash('sha256').update(readback).digest('hex'),
            externalId: null,
            readback: 'verified',
            backlink: {
              artifactRef: artifact.ref,
              artifactSha256: artifact.sha256,
              decisionId: DECISION_ID,
            },
          }],
        };
        },
        clock: () => new Date('2026-08-31T10:21:00.000Z'),
      },
    );
    expect(settlement.receipt?.status).toBe('completed');

    const feedbackContextPath = join(harness.root, 'synthetic-feedback-context.md');
    await writeFile(
      feedbackContextPath,
      `Feedback: ${feedback.sample.feedback_id}\nLead with a decision-ready option comparison.\n`,
      'utf8',
    );
    const continuationTask: Task = {
      ...sourceTask,
      status: 'in_progress',
      attempts: 2,
      claim: {
        runId: CONTINUATION_RUN_ID,
        agent: 'synthetic-senior-assistant',
        claimedAt: '2026-08-31T10:15:00.000Z',
        leaseExpiresAt: '2026-08-31T10:45:00.000Z',
      },
      artifactRefs: [artifact.ref],
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-request-synthetic-96',
        selectedOptionId: 'reuse',
        selectedOptionLabel: 'Reuse for a bounded proof',
        responseText: null,
        responseEventId: 'synthetic-response-96',
        respondedAt: '2026-08-31T10:14:00.000Z',
        continuationRunId: CONTINUATION_RUN_ID,
        continuationOfRunId: SOURCE_RUN_ID,
        continuationStartedAt: '2026-08-31T10:15:00.000Z',
      },
      updatedAt: '2026-08-31T10:15:00.000Z',
    };
    const continuationBundle = await buildContextBundle(continuationTask, atlProject, {
      allowedLocalRoots: [harness.root],
      previousArtifact: {
        reference: artifact.ref,
        version: `v${artifact.version}`,
        summary: artifactSummary.summary,
        evidenceCount: artifactSummary.evidenceCount,
      },
      additionalLocalContexts: [{
        label: 'feedback_decision_ready',
        kind: 'feedback',
        path: feedbackContextPath,
        sourceRef: `feedback://${feedback.sample.feedback_id}`,
        version: 'v1',
      }],
    });
    const continuationManifest = await persistContextManifest(
      join(harness.root, '.atl-runtime'),
      {
        taskId: continuationTask.taskId,
        runId: CONTINUATION_RUN_ID,
        asOf: '2026-08-31T10:16:00.000Z',
        projectResolution: resolution,
        context: continuationBundle,
        candidates: [
          candidate(continuationBundle, {
            candidateId: 'tep96-continuation-task',
            category: 'task',
            blockLabel: 'task',
            selectionReason: 'The continuation objective remains required.',
          }),
          candidate(continuationBundle, {
            candidateId: 'tep96-continuation-project',
            category: 'project',
            blockLabel: 'project',
            selectionReason: 'The continuation remains inside the resolved project.',
          }),
          candidate(continuationBundle, {
            candidateId: 'tep96-previous-artifact',
            category: 'artifact',
            blockLabel: 'previous_artifact',
            selectionReason: 'The accepted option comparison constrains the next action.',
          }),
          candidate(continuationBundle, {
            candidateId: 'feedback-decision-ready',
            category: 'feedback',
            blockLabel: 'feedback_decision_ready',
            selectionReason: 'Confirmed project-scoped feedback applies to this continuation.',
          }),
        ],
      },
    );
    const continuationRuntimePack = await persistRuntimePack(
      join(harness.root, '.atl-runtime'),
      {
        task: continuationTask,
        project: atlProject,
        context: continuationBundle,
        executionProfile: resolveExecutionProfile(continuationTask),
        contextManifest: {
          manifestId: continuationManifest.manifest.manifestId,
          sha256: continuationManifest.manifest.sha256,
        },
        asOf: '2026-08-31T10:16:00.000Z',
        expiresAt: continuationTask.claim!.leaseExpiresAt,
      },
    );
    const rule: FeedbackContextRule = {
      feedbackId: feedback.sample.feedback_id,
      candidateId: 'feedback-decision-ready',
      version: 'v1',
      sha256: continuationManifest.manifest.entries.find(
        ({ candidateId }) => candidateId === 'feedback-decision-ready',
      )!.sha256!,
      stability: feedback.sample.stability,
      confidence: 'high',
      validFrom: feedback.sample.created_at,
      validUntil: null,
      scope: {
        taskIds: [continuationTask.taskId],
        taskTypes: ['research'],
        projectIds: [resolution.projectId],
        requiredTags: ['decision_input'],
        excludedTags: ['html_rendering'],
      },
    };
    const consumption = await proveContextConsumption({
      repository: {
        getManifest: async (manifestId) => (
          manifestId === continuationManifest.manifest.manifestId
            ? continuationManifest.manifest
            : null
        ),
        getTaskContext: async (taskId) => taskId === continuationTask.taskId
          ? {
              taskId,
              taskType: 'research',
              projectId: resolution.projectId,
              tags: ['decision_input'],
            }
          : null,
        getRuntimePackForRun: async (taskId, runId) => (
          taskId === continuationRuntimePack.pack.taskId
          && runId === continuationRuntimePack.pack.runId
            ? continuationRuntimePack.pack
            : null
        ),
        listFeedbackRules: async () => [rule],
      },
    }, continuationManifest.manifest.manifestId);
    expect(consumption.status).toBe('proven');

    const restartedRuntimeEvidence = new FileArtifactChainRuntimeEvidenceRepository(
      join(harness.root, '.atl-runtime'),
    );
    const lineage = await rebuildArtifactLineage({
      repository: {
        getArtifactProduction: async (candidateRef) => (
          candidateRef === artifact.ref ? artifactProduction : null
        ),
        getCurrentArtifact: async (taskId) => taskId === sourceTask.taskId
          ? artifact
          : null,
        getExecutionBinding: async () => null,
        getRuntimePack: (packId) => restartedRuntimeEvidence.getRuntimePack(packId),
        getRuntimePackForRun: (taskId, runId) => (
          restartedRuntimeEvidence.getRuntimePackForRun(taskId, runId)
        ),
        getContextManifest: (manifestId) => (
          restartedRuntimeEvidence.getContextManifest(manifestId)
        ),
        getDecision: async (decisionId) => decisionId === DECISION_ID
          ? {
              decisionId: DECISION_ID,
              traceId: TRACE_ID,
              artifactRef: artifact.ref,
              artifactVersion: artifact.version,
              artifactSha256: artifact.sha256,
            }
          : null,
        getTrace: (traceId) => decisionContext.traces.get(traceId),
        listFeedback: (traceId) => decisionContext.feedback.listByTrace(traceId),
        getTrigger: async (decisionId, artifactRef) => (
          decisionId === DECISION_ID && artifactRef === artifact.ref
            ? triggerRepository.get(trigger.receipt.idempotencyKey)
            : null
        ),
        getSettlementPlan: async (decisionId, artifactRef) => (
          decisionId === DECISION_ID && artifactRef === artifact.ref
            ? settlementPlan
            : null
        ),
        getSettlementReceipt: async (planId) => planId === settlementPlan.planId
          ? settlement.receipt
          : null,
      },
    }, {
      taskId: sourceTask.taskId,
      artifactRef: artifact.ref,
      decisionId: DECISION_ID,
    });

    expect(lineage.status).toBe('valid');
    expect(relatedLineageNodes(lineage, `run:${CONTINUATION_RUN_ID}`)).toContain(
      `context-manifest:${continuationManifest.manifest.manifestId}`,
    );
    expect(relatedLineageNodes(
      lineage,
      `settlement-plan:${settlementPlan.planId}`,
    )).toContain(`settlement-receipt:${settlement.receipt?.receiptId}`);
  });
});
