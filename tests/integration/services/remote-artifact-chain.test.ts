import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { artifactNodeId } from '../../../src/domain/artifact-identity.js';
import {
  createArtifactSettlementPlan,
} from '../../../src/domain/artifact-settlement.js';
import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { readContextManifestById } from '../../../src/runner/context-manifest-runtime.js';
import { authorizeResearchTask } from '../../../src/services/authorize-research-task.js';
import { bindArtifactDecision } from '../../../src/services/bind-artifact-decision.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';
import { readResearchArtifacts } from '../../../src/services/read-research-artifacts.js';
import { rebuildArtifactLineage } from '../../../src/services/rebuild-artifact-lineage.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import { startArtifactTrigger } from '../../../src/services/start-artifact-trigger.js';
import { FileArtifactDecisionRepository } from '../../../src/storage/file-artifact-decision-repository.js';
import { FileArtifactProductionEvidenceRepository } from '../../../src/storage/file-artifact-production-evidence-repository.js';
import { FileArtifactSettlementRepository } from '../../../src/storage/file-artifact-settlement-repository.js';
import { FileArtifactTriggerRepository } from '../../../src/storage/file-artifact-trigger-repository.js';
import { FileBackedArtifactLineageEvidenceRepository } from '../../../src/storage/file-backed-artifact-lineage-evidence-repository.js';
import { FileExecutionBindingRepository } from '../../../src/storage/file-execution-binding-repository.js';
import { RemoteArtifactSettlementSourceResolver } from '../../../src/storage/remote-artifact-settlement-source-resolver.js';
import { AuthorizedVaultArtifactSettlementWriter } from '../../../src/storage/authorized-vault-artifact-settlement-writer.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T11:00:00.000Z';
const TASK_ID = 'task-20260901-remote-chain';
const SOURCE_RUN_ID = 'run-remote-chain-source';
const CONTINUATION_RUN_ID = 'run-remote-chain-continuation';
const ISSUE_ID = '01a03d19-bd5f-7263-a069-6f0cfde75b8e';
const contexts: TestServiceContext[] = [];

const policy: DecisionPolicy = {
  policy_id: 'policy.remote.artifact-chain',
  version: 'v001',
  status: 'observing',
  dimension: 'result-acceptance',
  decision_question: 'Should the accepted remote Artifact continue and settle?',
  inputs: [{ name: 'artifact', source: 'synthetic_remote_artifact' }],
  sources: ['synthetic_test'],
  rules: [{ statement: 'Bind every action to persisted remote evidence.', priority: 1 }],
  exceptions: [],
  outputs: ['bounded continuation'],
  rationale: 'Synthetic policy for the remote Artifact Chain integration test.',
  examples: [],
  counterexamples: [],
  metrics: ['remote_artifact_chain_integrity'],
  next_review_at: '2026-10-01',
  created_at: NOW,
  status_history: [],
};

function project(): Project {
  return {
    projectId: 'project-remote-chain',
    name: 'Remote Artifact Chain',
    description: 'Synthetic remote chain project.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Prove a remote Artifact Chain',
    body: '\nSynthetic remote chain fixture.\n',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: project().projectId,
    taskType: 'research',
    objective: 'Rebuild the remote chain from file-backed evidence.',
    acceptanceCriteria: ['Prove Decision, Trigger, continuation, and settlement.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    executionTarget: 'multica',
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:remote-artifact-chain',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function singleJsonPath(runtimeRoot: string, directory: string): Promise<string> {
  const root = join(runtimeRoot, directory);
  const files = (await readdir(root)).filter((file) => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  return join(root, files[0]!);
}

async function replacePersistedValue(
  path: string,
  current: string,
  replacement: string,
): Promise<void> {
  const raw = await readFile(path, 'utf8');
  const tampered = raw.replaceAll(current, replacement);
  expect(tampered).not.toBe(raw);
  await writeFile(path, tampered, 'utf8');
}

async function setupReviewedRemoteArtifact(options: { attachmentOnly?: boolean } = {}) {
  const harness = await createTestServiceContext({ now: new Date(NOW) });
  contexts.push(harness);
  const runtimeRoot = `${harness.root}/.atl-runtime`;
  const atlProject = project();
  const sourceTask = task();
  await harness.ctx.projects.create(atlProject);
  await harness.ctx.tasks.createIfSourceKeyAbsent(sourceTask);
  const workspaceId = '89440e05-518e-4c7e-aa80-0afa2be21196';
  const multicaProjectId = 'b70aeddc-4a32-47ed-a288-571f5475634a';
  const agentId = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
  const runtimeId = '5f282aa0-e717-421d-ab84-d1f0d4aab551';
  const connector = {
    ensureIssue: async () => ({
      status: 'linked' as const,
      ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-999' },
      recovered: false,
      activation: {
        assigneeId: agentId,
        runId: SOURCE_RUN_ID,
        runStatus: 'in_progress',
        runAgentId: agentId,
        runRuntimeId: runtimeId,
        recovered: false,
        agent: {
          agentId,
          workspaceId,
          model: 'gpt-5.6-sol',
          maxConcurrentTasks: 10,
          runtimeId,
          status: 'idle',
        },
      },
    }),
    inspect: async () => ({
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-999',
      status: 'in_progress',
      workspaceId,
      projectId: multicaProjectId,
      assigneeId: agentId,
      assigneeType: 'agent',
    }),
    runs: async () => [{
      runId: SOURCE_RUN_ID,
      issueId: ISSUE_ID,
      agentId,
      runtimeId,
      status: 'completed',
      output: options.attachmentOnly ? null : 'Synthetic remote chain result.',
      createdAt: NOW,
      startedAt: NOW,
      completedAt: '2026-09-01T11:05:00.000Z',
      deliveredCommentIds: [],
      triggerCommentId: null,
    }],
    listComments: async () => ({
      comments: options.attachmentOnly ? [{
        commentId: 'comment-attachment-only',
        parentCommentId: null,
        body: `[ATL_ARTIFACT_RUN:${SOURCE_RUN_ID}]`,
        createdAt: '2026-09-01T11:05:00.000Z',
        authorType: 'agent' as const,
        attachments: [{
          attachmentId: 'attachment-metadata-only',
          commentId: 'comment-attachment-only',
          issueId: ISSUE_ID,
          workspaceId,
          runId: SOURCE_RUN_ID,
          filename: 'synthetic-result.md',
          contentType: 'text/markdown',
          sizeBytes: 256,
          downloadUrl: 'https://multica.invalid/attachments/metadata-only',
          markdownUrl: null,
          url: null,
          uploaderId: agentId,
          uploaderType: 'agent' as const,
        }],
      }] : [],
    }),
  };
  const dispatch = await authorizeResearchTask(harness.ctx, {
    connector,
    target: { workspaceId, projectId: multicaProjectId },
    runtimeRoot,
    allowedContextRoots: [],
    discoverContext: async ({ task: currentTask, project: currentProject }) => ({
      additionalLocalContexts: [],
      candidates: [
        {
          candidateId: 'task-current',
          category: 'task',
          sourceRef: `task://${currentTask.taskId}`,
          version: currentTask.updatedAt,
          expectedSha256: null,
          selection: 'selected',
          selectionReason: 'The Task is required.',
          blockLabel: 'task',
        },
        {
          candidateId: 'project-current',
          category: 'project',
          sourceRef: `atl-project://${currentProject.projectId}`,
          version: currentProject.updatedAt,
          expectedSha256: null,
          selection: 'selected',
          selectionReason: 'The Project is required.',
          blockLabel: 'project',
        },
      ],
    }),
  }, TASK_ID);
  expect(dispatch.dispatch.status).toBe('linked');
  if (dispatch.dispatch.status !== 'linked') throw new Error('Expected linked dispatch');
  const artifact = await readResearchArtifacts(harness.ctx, {
    connector,
    runtimeRoot,
  }, TASK_ID);
  const artifactRef = `remote-artifact://${artifact.receiptId}`;
  const manifestReceipt = await readContextManifestById(
    runtimeRoot,
    dispatch.dispatch.manifestId,
  );
  if (manifestReceipt === null) throw new Error('Expected persisted Context Manifest');
  const manifest = {
    manifest: manifestReceipt,
    absolutePath: await singleJsonPath(runtimeRoot, 'context-manifests'),
  };
  const persistedBinding = await new FileExecutionBindingRepository(runtimeRoot)
    .get(dispatch.dispatch.executionBindingReceiptId);
  if (persistedBinding === null) throw new Error('Expected persisted execution binding');
  const binding = { receipt: persistedBinding };
  const productionRepository = new FileArtifactProductionEvidenceRepository(
    harness.root,
    runtimeRoot,
  );
  const production = await productionRepository.readProductionEvidence(artifactRef);
  const decisions = createDecisionServiceContext(harness.root, {
    clock: () => new Date('2026-09-01T11:06:00.000Z'),
  });
  await decisions.policies.create(policy);
  const trace = await decisions.traces.create({
    trace_id: 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V7',
    policy_ref: 'policy.remote.artifact-chain@v001',
    dimension: 'result-acceptance',
    input_refs: [
      `context-manifest:${manifest.manifest.manifestId}`,
      artifactNodeId(production.identity),
    ],
    decision: 'Continue and settle this exact remote Artifact.',
    reasoning_summary: 'All production identities are persisted and reviewable.',
    evidence_refs: [artifactNodeId(production.identity)],
    confidence: 'high',
    created_at: '2026-09-01T11:06:00.000Z',
  }, {
    policyResolver: (ref) => decisions.policies.get(ref as `${string}@${string}`),
  });
  const decision = await bindArtifactDecision({
    tasks: harness.ctx.tasks,
    artifacts: productionRepository,
    traces: decisions.traces,
    decisions: new FileArtifactDecisionRepository(runtimeRoot),
    clock: () => new Date('2026-09-01T11:07:00.000Z'),
  }, {
    taskId: TASK_ID,
    artifactRef,
    traceId: trace.trace_id,
  });

  return {
    harness,
    runtimeRoot,
    manifest,
    binding,
    artifactRef,
    production,
    decision,
  };
}

function rebuildFixtureLineage(
  fixture: Awaited<ReturnType<typeof setupReviewedRemoteArtifact>>,
) {
  return rebuildArtifactLineage({
    repository: new FileBackedArtifactLineageEvidenceRepository(
      fixture.harness.root,
      fixture.runtimeRoot,
    ),
  }, {
    taskId: TASK_ID,
    artifactRef: fixture.artifactRef,
    decisionId: fixture.decision.binding.decisionId,
  });
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('remote Artifact Chain synthesis', () => {
  it('rebuilds Decision -> Trigger -> Multica continuation -> settlement from disk', async () => {
    const fixture = await setupReviewedRemoteArtifact();
    const { artifactRef, binding, decision, manifest, production, runtimeRoot } = fixture;
    const trigger = await startArtifactTrigger({
      repository: new FileArtifactTriggerRepository(runtimeRoot),
      clock: () => new Date('2026-09-01T11:08:00.000Z'),
      execute: async () => ({ status: 'started', runId: CONTINUATION_RUN_ID }),
    }, {
      idempotencyKey: 'remote-artifact-chain-continuation',
      executionTarget: 'multica',
      taskId: TASK_ID,
      sourceRunId: SOURCE_RUN_ID,
      decisionId: decision.binding.decisionId,
      artifactRef,
      artifactVersion: production.identity.version,
      artifactSha256: production.identity.sha256,
    });
    const plan = createArtifactSettlementPlan({
      artifact: production.identity,
      decisionId: decision.binding.decisionId,
      requestedDestination: 'project_knowledge',
      targetRef: 'vault-file:///Projects/Synthetic/remote-chain.md',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-09-01T11:09:00.000Z',
    });
    const settlements = new FileArtifactSettlementRepository(runtimeRoot);
    await settlements.createPlan(plan);
    await settlements.createAuthorization({
      schemaVersion: 1,
      authorizationId: `authorization-${plan.planId}`,
      planId: plan.planId,
      artifactRef,
      artifactSha256: production.identity.sha256,
      decisionId: decision.binding.decisionId,
      logicalDestination: 'project_knowledge',
      vaultRoot: fixture.harness.root,
      targetRef: plan.targetRef!,
      requiredPermission: plan.requiredPermission!,
      authorizedAt: '2026-09-01T11:09:30.000Z',
      readBackReceipt: `synthetic-readback://${plan.planId}`,
    });
    const writer = new AuthorizedVaultArtifactSettlementWriter(
      fixture.harness.root,
      new RemoteArtifactSettlementSourceResolver(runtimeRoot),
    );
    const settlement = await executeArtifactSettlement(plan.planId, {
      repository: settlements,
      writer: (currentPlan, authorization) => writer.write(currentPlan, authorization),
      recoverUnknown: (currentPlan, receipt, authorization) => (
        writer.recoverUnknown(currentPlan, receipt, authorization)
      ),
      clock: () => new Date('2026-09-01T11:10:00.000Z'),
    });
    expect(settlement.executed).toBe(true);
    expect(settlement.receipt?.status).toBe('completed');
    expect(await readFile(
      join(fixture.harness.root, 'Projects', 'Synthetic', 'remote-chain.md'),
      'utf8',
    )).toContain('Synthetic remote chain result.');
    const receipt = settlement.receipt!;

    const report = await rebuildFixtureLineage(fixture);

    expect(report.status).toBe('valid');
    expect(report.issues).toEqual([]);
    expect(report.edges).toEqual(expect.arrayContaining([
      {
        from: `context-manifest:${manifest.manifest.manifestId}`,
        to: `execution-binding:${binding.receipt.receiptId}`,
        relation: 'bound_to',
      },
      {
        from: `trigger:${trigger.receipt.idempotencyKey}`,
        to: `run:${CONTINUATION_RUN_ID}`,
        relation: 'continued_as',
      },
      {
        from: `settlement-plan:${plan.planId}`,
        to: `settlement-receipt:${receipt.receiptId}`,
        relation: 'recorded_as',
      },
    ]));
    expect(report.nodes.some((node) => node.startsWith('runtime-pack:'))).toBe(false);
  });

  it('does not settle attachment metadata as Remote Artifact content', async () => {
    const fixture = await setupReviewedRemoteArtifact({ attachmentOnly: true });
    const plan = createArtifactSettlementPlan({
      artifact: fixture.production.identity,
      decisionId: fixture.decision.binding.decisionId,
      requestedDestination: 'project_knowledge',
      targetRef: 'vault-file:///Projects/Synthetic/attachment-only.md',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-09-01T11:09:00.000Z',
    });
    const settlements = new FileArtifactSettlementRepository(fixture.runtimeRoot);
    await settlements.createPlan(plan);
    await settlements.createAuthorization({
      schemaVersion: 1,
      authorizationId: `authorization-${plan.planId}`,
      planId: plan.planId,
      artifactRef: plan.artifact.ref,
      artifactSha256: plan.artifact.sha256,
      decisionId: plan.decisionId,
      logicalDestination: 'project_knowledge',
      vaultRoot: fixture.harness.root,
      targetRef: plan.targetRef!,
      requiredPermission: plan.requiredPermission!,
      authorizedAt: '2026-09-01T11:09:30.000Z',
      readBackReceipt: `synthetic-readback://${plan.planId}`,
    });
    const writer = new AuthorizedVaultArtifactSettlementWriter(
      fixture.harness.root,
      new RemoteArtifactSettlementSourceResolver(fixture.runtimeRoot),
    );

    const result = await executeArtifactSettlement(plan.planId, {
      repository: settlements,
      writer: (currentPlan, authorization) => writer.write(currentPlan, authorization),
      recoverUnknown: (currentPlan, receipt, authorization) => (
        writer.recoverUnknown(currentPlan, receipt, authorization)
      ),
      clock: () => new Date('2026-09-01T11:10:00.000Z'),
    });

    expect(result.receipt?.status).toBe('failed');
    await expect(readFile(
      join(fixture.harness.root, 'Projects', 'Synthetic', 'attachment-only.md'),
      'utf8',
    )).rejects.toThrow();
  });

  it('fails closed when the execution binding is tampered on disk', async () => {
    const fixture = await setupReviewedRemoteArtifact();
    await replacePersistedValue(
      await singleJsonPath(fixture.runtimeRoot, 'execution-bindings'),
      'gpt-5.6-sol',
      'gpt-5.5',
    );

    await expect(rebuildFixtureLineage(fixture)).rejects.toMatchObject({
      code: 'execution_binding_repository_invalid',
    });
  });

  it('fails closed when the persisted Manifest SHA is tampered', async () => {
    const fixture = await setupReviewedRemoteArtifact();
    await replacePersistedValue(
      fixture.manifest.absolutePath,
      fixture.manifest.manifest.sha256,
      'b'.repeat(64),
    );

    await expect(rebuildFixtureLineage(fixture)).rejects.toMatchObject({
      code: 'context_manifest_runtime_evidence_invalid',
    });
  });

  it('fails closed when the Remote Artifact source Run ID is tampered', async () => {
    const fixture = await setupReviewedRemoteArtifact();
    await replacePersistedValue(
      await singleJsonPath(fixture.runtimeRoot, 'remote-artifacts'),
      SOURCE_RUN_ID,
      'run-remote-chain-tampered',
    );

    await expect(rebuildFixtureLineage(fixture)).rejects.toMatchObject({
      code: 'remote_artifact_repository_invalid',
    });
  });

  it('fails closed when the Decision-bound Remote Artifact SHA is tampered', async () => {
    const fixture = await setupReviewedRemoteArtifact();
    await replacePersistedValue(
      join(
        fixture.runtimeRoot,
        'artifact-decisions',
        `${fixture.decision.binding.decisionId}.json`,
      ),
      fixture.production.identity.sha256,
      'd'.repeat(64),
    );

    await expect(rebuildFixtureLineage(fixture)).rejects.toMatchObject({
      code: 'artifact_decision_evidence_invalid',
    });
  });
});
