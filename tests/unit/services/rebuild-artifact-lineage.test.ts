import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { artifactNodeId, type ArtifactIdentity } from '../../../src/domain/artifact-identity.js';
import {
  createArtifactSettlementPlan,
  createArtifactSettlementReceipt,
  type ArtifactSettlementPlan,
  type ArtifactSettlementReceipt,
} from '../../../src/domain/artifact-settlement.js';
import type { ContextManifest } from '../../../src/domain/context-manifest.js';
import type { FeedbackSample } from '../../../src/domain/decision-feedback.js';
import type { DecisionTrace } from '../../../src/domain/decision-trace.js';
import type { ExecutionProfile } from '../../../src/runner/execution-profile.js';
import type {
  PersistedRuntimePackEvidence,
  RuntimePack,
} from '../../../src/runner/runtime-pack.js';
import {
  ArtifactLineageEvidenceError,
  rebuildArtifactLineage,
  type ArtifactLineageEvidenceRepository,
} from '../../../src/services/rebuild-artifact-lineage.js';
import type { ArtifactTriggerReceipt } from '../../../src/services/start-artifact-trigger.js';
import { startArtifactTrigger } from '../../../src/services/start-artifact-trigger.js';

const TASK_ID = 'task-synthetic-lineage';
const SOURCE_RUN_ID = 'run-synthetic-lineage-source';
const CONTINUATION_RUN_ID = 'run-synthetic-lineage-continuation';
const DECISION_ID = 'decision-synthetic-lineage';
const TRACE_ID = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifest(runId: string, seed: string): ContextManifest {
  const unsigned = {
    schemaVersion: 1 as const,
    taskId: TASK_ID,
    runId,
    projectId: 'project-synthetic-lineage',
    asOf: '2026-08-31T10:00:00.000Z',
    status: 'ready' as const,
    projectEvidence: {
      registryProjectId: 'project-synthetic-lineage',
      canonicalRef: 'projects://synthetic-lineage/home',
      canonicalVersion: 'v1',
      canonicalSha256: seed.repeat(64),
      atlRef: 'atl-project://synthetic-lineage',
      atlSha256: seed.repeat(64),
    },
    entries: [
      {
        candidateId: 'task-current',
        kind: 'task' as const,
        category: 'task' as const,
        sourceRef: `task://${TASK_ID}`,
        version: 'v1',
        selectionReason: 'The current Task is required.',
        status: 'consumed' as const,
        blockLabel: 'task',
        readRef: `task://${TASK_ID}`,
        sha256: 'a'.repeat(64),
        reason: null,
      },
      {
        candidateId: 'project-current',
        kind: 'project' as const,
        category: 'project' as const,
        sourceRef: 'project://project-synthetic-lineage',
        version: 'v1',
        selectionReason: 'The current Project is required.',
        status: 'consumed' as const,
        blockLabel: 'project',
        readRef: 'project://project-synthetic-lineage',
        sha256: 'b'.repeat(64),
        reason: null,
      },
    ],
    issues: [],
  };
  const digest = sha256(JSON.stringify(unsigned));
  return {
    ...unsigned,
    manifestId: `cm_${digest.slice(0, 24)}`,
    sha256: digest,
  };
}

function resignRuntimePack(
  persisted: PersistedRuntimePackEvidence,
  blocks: RuntimePack['blocks'],
): void {
  const unsigned = {
    ...persisted.pack,
    blocks,
  } as Omit<RuntimePack, 'packId'> & { packId?: string };
  delete unsigned.packId;
  persisted.pack = {
    ...unsigned,
    packId: `pack-${sha256(JSON.stringify(unsigned)).slice(0, 24)}`,
  } as RuntimePack;
  persisted.sha256 = sha256(`${JSON.stringify(persisted.pack, null, 2)}\n`);
}

const executionProfile: ExecutionProfile = {
  schemaVersion: 1 as const,
  profileId: 'research_v1' as const,
  profileVersion: 1 as const,
  selectionStrategy: 'deterministic_v1' as const,
  role: {
    id: 'bounded_public_researcher' as const,
    selectionReason:
      'The task is a confirmed research task authorized only for read_only_research.',
  },
  skills: [
    {
      id: 'decision-research' as const,
      version: 1 as const,
      instructions:
        'Produce decision-ready research. Separate sourced evidence, inference, uncertainty, and recommended actions.',
    },
    {
      id: 'evidence-collection' as const,
      version: 1 as const,
      instructions:
        'Prefer primary public sources. Preserve HTTPS URLs and access times, and never use authenticated content.',
    },
  ],
  allowedTools: ['WebSearch', 'WebFetch', 'Read'],
  requiredContextKinds: ['task', 'project'],
  permissionProfile: 'read_only_research' as const,
  outputContract: 'research_result_v1' as const,
  acceptancePolicy: {
    taskCriteriaRequired: true as const,
    httpsEvidenceRequired: true as const,
    humanReviewRequired: true as const,
  },
};

function runtimePack(
  runId: string,
  contextManifest: ContextManifest,
  continuationOfRunId: string | null,
): PersistedRuntimePackEvidence {
  const unsigned = {
    schemaVersion: 2 as const,
    taskId: TASK_ID,
    runId,
    continuationOfRunId,
    stateVersion: '2026-08-31T10:00:00.000Z',
    asOf: '2026-08-31T10:00:00.000Z',
    objective: 'Prove the persisted Artifact lineage.',
    expectedArtifact: 'research_result' as const,
    acceptanceCriteria: ['Every edge comes from persisted evidence.'],
    projectContextRefs: ['project:atl-synthetic-lineage@2026-08-31T10:00:00.000Z'],
    sourceRefs: [],
    previousArtifactRefs: [],
    reviewFeedbackSha256: null,
    allowedSources: ['task', 'project', 'explicit_local_files', 'public_urls'],
    forbiddenSources: [
      'authenticated_content',
      'third_party_messages',
      'calendar_mutations',
      'configuration_writes',
    ],
    permissionProfile: 'read_only_research' as const,
    executionProfile,
    executionProfileSha256: sha256(JSON.stringify(executionProfile)),
    contextManifestId: contextManifest.manifestId,
    contextManifestSha256: contextManifest.sha256,
    contextGaps: [],
    expiresAt: '2026-08-31T11:00:00.000Z',
    blocks: [
      {
        label: 'task',
        kind: 'task' as const,
        category: 'task' as const,
        sourceRef: `task://${TASK_ID}`,
        version: 'v1',
        readRef: `task://${TASK_ID}`,
        sha256: 'a'.repeat(64),
      },
      {
        label: 'project',
        kind: 'project' as const,
        category: 'project' as const,
        sourceRef: 'project://project-synthetic-lineage',
        version: 'v1',
        readRef: 'project://project-synthetic-lineage',
        sha256: 'b'.repeat(64),
      },
    ],
  };
  const pack: RuntimePack = {
    ...unsigned,
    packId: `pack-${sha256(JSON.stringify(unsigned)).slice(0, 24)}`,
  };
  return {
    pack,
    sha256: sha256(`${JSON.stringify(pack, null, 2)}\n`),
  };
}

function receiptFor(plan: ArtifactSettlementPlan): ArtifactSettlementReceipt {
  return createArtifactSettlementReceipt(plan, {
    status: 'completed',
    writes: [{
      targetRef: plan.targetRef!,
      version: 'v1',
      sha256: 'e'.repeat(64),
      externalId: null,
      readback: 'verified',
      backlink: {
        artifactRef: plan.artifact.ref,
        artifactSha256: plan.artifact.sha256,
        decisionId: plan.decisionId,
      },
    }],
  }, '2026-08-31T10:30:00.000Z');
}

async function fixture(): Promise<{
  repository: ArtifactLineageEvidenceRepository;
  decision: NonNullable<Awaited<ReturnType<ArtifactLineageEvidenceRepository['getDecision']>>>;
  sourceManifest: ContextManifest;
  sourcePack: PersistedRuntimePackEvidence;
  settlementPlan: ArtifactSettlementPlan;
  settlementReceipt: ArtifactSettlementReceipt;
}> {
  const sourceManifest = manifest(SOURCE_RUN_ID, 'a');
  const continuationManifest = manifest(CONTINUATION_RUN_ID, 'b');
  const sourcePack = runtimePack(SOURCE_RUN_ID, sourceManifest, null);
  const continuationPack = runtimePack(
    CONTINUATION_RUN_ID,
    continuationManifest,
    SOURCE_RUN_ID,
  );
  const artifact: ArtifactIdentity = {
    taskId: TASK_ID,
    ref: `Artifacts/${TASK_ID}/attempt-001.md`,
    version: 1,
    sha256: 'c'.repeat(64),
  };
  const decision = {
    decisionId: DECISION_ID,
    traceId: TRACE_ID,
    artifactRef: artifact.ref,
    artifactVersion: artifact.version,
    artifactSha256: artifact.sha256,
  };
  const feedback: FeedbackSample = {
    feedback_id: 'fb_01j9z8w7q3v5x2m4n6p8',
    trace_id: TRACE_ID,
    kind: 'accepted',
    stability: 'confirmed_pattern',
    correction_summary: null,
    final_outcome: 'approved',
    created_at: '2026-08-31T10:10:00.000Z',
    source_ref: 'synthetic-review://lineage',
  };
  const trace: DecisionTrace = {
    trace_id: TRACE_ID,
    policy_ref: 'policy.artifact-chain.synthetic@v001',
    dimension: 'result-acceptance',
    input_refs: [
      `context-manifest:${sourceManifest.manifestId}`,
      artifactNodeId(artifact),
    ],
    decision: 'Continue with the approved option.',
    reasoning_summary: 'The persisted Artifact satisfies the bounded acceptance criteria.',
    evidence_refs: [artifactNodeId(artifact)],
    confidence: 'high',
    user_feedback: 'accepted',
    final_outcome: 'approved',
    status: 'feedback_recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 1,
    latest_feedback_at: feedback.created_at,
    created_at: '2026-08-31T10:09:00.000Z',
    updated_at: '2026-08-31T10:10:00.000Z',
    status_history: [],
  };
  let trigger: ArtifactTriggerReceipt | null = null;
  const triggerResult = await startArtifactTrigger({
    repository: {
      withLock: async <T>(_key: string, operation: () => Promise<T>) => operation(),
      get: async () => trigger,
      create: async (receipt) => { trigger = receipt; },
      save: async (receipt) => { trigger = receipt; },
    },
    clock: () => new Date('2026-08-31T10:15:00.000Z'),
    execute: async () => ({ status: 'started', runId: CONTINUATION_RUN_ID }),
  }, {
    idempotencyKey: 'synthetic-lineage-continuation',
    executionTarget: 'local',
    taskId: TASK_ID,
    sourceRunId: SOURCE_RUN_ID,
    decisionId: DECISION_ID,
    artifactRef: artifact.ref,
    artifactVersion: artifact.version,
    artifactSha256: artifact.sha256,
  });
  trigger = triggerResult.receipt;
  const settlementPlan = createArtifactSettlementPlan({
    artifact,
    decisionId: DECISION_ID,
    requestedDestination: 'project_knowledge',
    targetRef: 'projects://synthetic-lineage/decision',
    authorizedDestinations: ['project_knowledge'],
    createdAt: '2026-08-31T10:20:00.000Z',
  });
  const settlementReceipt = receiptFor(settlementPlan);
  const repository: ArtifactLineageEvidenceRepository = {
    getArtifactProduction: async (artifactRef) => artifactRef === artifact.ref
      ? { identity: artifact, runId: SOURCE_RUN_ID, packId: sourcePack.pack.packId }
      : null,
    getCurrentArtifact: async (taskId) => taskId === TASK_ID ? artifact : null,
    getExecutionBinding: async () => null,
    getRuntimePack: async (packId) => packId === sourcePack.pack.packId ? sourcePack : null,
    getRuntimePackForRun: async (taskId, runId) => (
      taskId === TASK_ID && runId === CONTINUATION_RUN_ID ? continuationPack : null
    ),
    getContextManifest: async (manifestId) => {
      if (manifestId === sourceManifest.manifestId) return sourceManifest;
      if (manifestId === continuationManifest.manifestId) return continuationManifest;
      return null;
    },
    getDecision: async (decisionId) => decisionId === DECISION_ID ? decision : null,
    getTrace: async (traceId) => traceId === TRACE_ID ? trace : null,
    listFeedback: async (traceId) => traceId === TRACE_ID ? [feedback] : [],
    getTrigger: async (decisionId, artifactRef) => (
      decisionId === DECISION_ID && artifactRef === artifact.ref ? trigger : null
    ),
    getSettlementPlan: async (decisionId, artifactRef) => (
      decisionId === DECISION_ID && artifactRef === artifact.ref ? settlementPlan : null
    ),
    getSettlementReceipt: async (planId) => (
      planId === settlementPlan.planId ? settlementReceipt : null
    ),
  };
  return {
    repository,
    decision,
    sourceManifest,
    sourcePack,
    settlementPlan,
    settlementReceipt,
  };
}

describe('rebuildArtifactLineage', () => {
  it('rebuilds a valid graph only from persisted evidence', async () => {
    const { repository, settlementPlan, settlementReceipt } = await fixture();

    const report = await rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    });

    expect(report.status).toBe('valid');
    expect(report.nodes).toContain(`settlement-receipt:${settlementReceipt.receiptId}`);
    expect(report.nodes).toContain(`settlement-plan:${settlementPlan.planId}`);
    expect(report.nodes).toContain(`run:${CONTINUATION_RUN_ID}`);
  });

  it('fails closed when the requested Decision is not persisted', async () => {
    const { repository } = await fixture();
    repository.getDecision = async () => null;

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('fails closed when persisted Runtime Pack content drifts from its stable ID', async () => {
    const { repository, sourcePack } = await fixture();
    sourcePack.pack.objective = 'Caller-mutated objective';

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('fails closed when a self-consistent Runtime Pack disagrees with Manifest consumption', async () => {
    const { repository, sourcePack } = await fixture();
    resignRuntimePack(sourcePack, sourcePack.pack.blocks.map((block) => (
      block.label === 'task'
        ? { ...block, readRef: 'task://different-readback' }
        : block
    )));

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('fails closed when a continuation Runtime Pack disagrees with its Manifest consumption', async () => {
    const { repository } = await fixture();
    const originalGetRuntimePackForRun = repository.getRuntimePackForRun;
    repository.getRuntimePackForRun = async (taskId, runId) => {
      const persisted = await originalGetRuntimePackForRun(taskId, runId);
      if (persisted === null) return null;
      resignRuntimePack(persisted, persisted.pack.blocks.slice(0, 1));
      return persisted;
    };

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('fails closed when the Decision points at a Trace that cannot be read back', async () => {
    const { repository, decision } = await fixture();
    decision.traceId = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5';

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it.each([
    ['user_feedback', 'rejected'],
    ['final_outcome', 'rejected by reviewer'],
    ['latest_feedback_at', '2026-08-31T10:11:00.000Z'],
    ['status', 'closed'],
    ['feedback_summary_status', 'stale'],
  ] as const)('fails closed when persisted Trace %s drifts from Feedback Samples', async (
    field,
    value,
  ) => {
    const { repository } = await fixture();
    const originalGetTrace = repository.getTrace;
    repository.getTrace = async (traceId) => {
      const trace = await originalGetTrace(traceId);
      return trace === null ? null : { ...trace, [field]: value };
    };

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('fails closed when a persisted Settlement receipt is not completed', async () => {
    const { repository, settlementPlan } = await fixture();
    const failedReceipt = createArtifactSettlementReceipt(settlementPlan, {
      status: 'failed',
      writes: [],
    }, '2026-08-31T10:30:00.000Z');
    repository.getSettlementReceipt = async () => failedReceipt;

    await expect(rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    })).rejects.toBeInstanceOf(ArtifactLineageEvidenceError);
  });

  it('does not infer a continuation from a starting Trigger', async () => {
    const { repository } = await fixture();
    const originalGetTrigger = repository.getTrigger;
    repository.getTrigger = async (decisionId, artifactRef) => {
      const trigger = await originalGetTrigger(decisionId, artifactRef);
      return trigger === null ? null : {
        ...trigger,
        state: 'starting',
        continuationRunId: null,
      };
    };
    const getRuntimePackForRun = vi.fn(repository.getRuntimePackForRun);
    repository.getRuntimePackForRun = getRuntimePackForRun;

    const report = await rebuildArtifactLineage({ repository }, {
      taskId: TASK_ID,
      artifactRef: `Artifacts/${TASK_ID}/attempt-001.md`,
      decisionId: DECISION_ID,
    });

    expect(report.status).toBe('valid');
    expect(report.nodes).not.toContain(`run:${CONTINUATION_RUN_ID}`);
    expect(getRuntimePackForRun).not.toHaveBeenCalled();
  });
});
