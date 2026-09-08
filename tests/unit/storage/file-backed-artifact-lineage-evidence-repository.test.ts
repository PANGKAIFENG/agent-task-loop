import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactSettlementPlan,
  createArtifactSettlementReceipt,
} from '../../../src/domain/artifact-settlement.js';
import { runOutputSource } from '../../../src/domain/remote-artifact.js';
import type { Task } from '../../../src/domain/task.js';
import { startArtifactTrigger } from '../../../src/services/start-artifact-trigger.js';
import { FileArtifactSettlementRepository } from '../../../src/storage/file-artifact-settlement-repository.js';
import { FileArtifactTriggerRepository } from '../../../src/storage/file-artifact-trigger-repository.js';
import { FileBackedArtifactLineageEvidenceRepository } from '../../../src/storage/file-backed-artifact-lineage-evidence-repository.js';
import { FileExecutionBindingRepository } from '../../../src/storage/file-execution-binding-repository.js';
import { FileRemoteArtifactRepository } from '../../../src/storage/file-remote-artifact-repository.js';
import { MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('FileBackedArtifactLineageEvidenceRepository', () => {
  it('recovers Trigger and settlement evidence from disk in a fresh repository instance', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-lineage-evidence-'));
    roots.push(vaultRoot);
    const runtimeRoot = join(vaultRoot, '.atl-runtime');
    const artifact = {
      taskId: 'task-synthetic-lineage',
      ref: 'Artifacts/task-synthetic-lineage/attempt-001.md',
      version: 1,
      sha256: 'a'.repeat(64),
    };
    const decisionId = 'decision-synthetic-lineage';
    const trigger = await startArtifactTrigger({
      repository: new FileArtifactTriggerRepository(runtimeRoot),
      clock: () => new Date('2026-09-01T09:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, {
      idempotencyKey: 'trigger-synthetic-lineage',
      executionTarget: 'local',
      taskId: artifact.taskId,
      sourceRunId: 'run-synthetic-lineage',
      decisionId,
      artifactRef: artifact.ref,
      artifactVersion: artifact.version,
      artifactSha256: artifact.sha256,
    });
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId,
      requestedDestination: 'project_knowledge',
      targetRef: 'vault-file:///Projects/Synthetic/lineage.md',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-09-01T09:01:00.000Z',
    });
    const receipt = createArtifactSettlementReceipt(plan, {
      status: 'completed',
      writes: [{
        targetRef: plan.targetRef!,
        version: null,
        sha256: 'b'.repeat(64),
        externalId: null,
        readback: 'verified',
        backlink: {
          artifactRef: artifact.ref,
          artifactSha256: artifact.sha256,
          decisionId,
        },
      }],
    }, '2026-09-01T09:02:00.000Z');
    const settlements = new FileArtifactSettlementRepository(runtimeRoot);
    await settlements.createPlan(plan);
    await settlements.createReceipt(receipt);

    const fresh = new FileBackedArtifactLineageEvidenceRepository(
      vaultRoot,
      runtimeRoot,
    );

    await expect(fresh.getTrigger(decisionId, artifact.ref))
      .resolves.toEqual(trigger.receipt);
    await expect(fresh.getSettlementPlan(decisionId, artifact.ref))
      .resolves.toEqual(plan);
    await expect(fresh.getSettlementReceipt(plan.planId))
      .resolves.toEqual(receipt);
  });

  it('recovers Remote Artifact production and its execution binding without reading a Markdown Artifact', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-remote-lineage-evidence-'));
    roots.push(vaultRoot);
    const runtimeRoot = join(vaultRoot, '.atl-runtime');
    const taskId = 'task-20260901-remote-lineage';
    const manifestId = 'cm_1234567890abcdef12345678';
    const manifestSha256 = 'b'.repeat(64);
    const issueId = '01a03d19-bd5f-7263-a069-6f0cfde75b8e';
    const runId = '01a057ce-1767-7c10-a6c8-8c966cc66ea7';
    const binding = await new FileExecutionBindingRepository(runtimeRoot).createOrGet({
      taskId,
      taskContextVersion: '2026-09-01T09:00:00.000Z',
      taskContentSha256: 'e'.repeat(64),
      projectContextSha256: 'f'.repeat(64),
      vaultIdentity: `vault_${'d'.repeat(64)}`,
      dispatchAttemptId: 'dispatch_1234567890abcdef12345678',
      manifestId,
      manifestSha256,
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      issueId,
      issueIdentifier: 'TEP-999',
      assigneeType: 'agent',
      agent: {
        agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        model: 'gpt-5.6-sol',
        maxConcurrentTasks: 10,
        runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
        status: 'idle',
      },
      run: {
        runId,
        agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
        status: 'completed',
        runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
      },
      createdAt: '2026-09-01T09:00:00.000Z',
    });
    const remote = await new FileRemoteArtifactRepository(runtimeRoot).createOrGet({
      taskId,
      executionBindingReceiptId: binding.receipt.receiptId,
      workspaceId: binding.receipt.workspaceId,
      projectId: binding.receipt.projectId,
      issueId,
      issueIdentifier: binding.receipt.issueIdentifier,
      run: {
        runId,
        agentId: binding.receipt.agent.agentId,
        runtimeId: binding.receipt.agent.runtimeId,
        status: 'completed',
        createdAt: '2026-09-01T09:00:00.000Z',
        startedAt: '2026-09-01T09:00:01.000Z',
        completedAt: '2026-09-01T09:05:00.000Z',
      },
      sources: [runOutputSource(runId, 'Synthetic remote research result.')],
      createdAt: '2026-09-01T09:05:01.000Z',
    });
    const artifactRef = `remote-artifact://${remote.receipt.receiptId}`;
    const task: Task = {
      schemaVersion: 1,
      taskId,
      title: 'Synthetic remote lineage',
      body: '',
      status: 'agent_executable',
      reviewState: 'confirmed',
      projectId: 'project-remote-lineage',
      taskType: 'research',
      objective: 'Verify remote lineage evidence.',
      acceptanceCriteria: ['Use the persisted remote identity.'],
      autoExecutable: true,
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
      origin: 'synthetic_test',
      sourceDate: null,
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:remote-lineage',
      possibleDuplicateIds: [],
      priority: 'normal',
      attempts: 0,
      claim: null,
      artifactRefs: [artifactRef],
      reviewFeedback: null,
      readyAt: '2026-09-01T09:00:00.000Z',
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:05:01.000Z',
    };
    await new MarkdownTaskRepository(vaultRoot).createIfSourceKeyAbsent(task);

    const fresh = new FileBackedArtifactLineageEvidenceRepository(vaultRoot, runtimeRoot);

    await expect(fresh.getArtifactProduction(artifactRef)).resolves.toMatchObject({
      runId,
      executionBindingReceiptId: binding.receipt.receiptId,
      manifestId,
      manifestSha256,
      issueId,
    });
    await expect(fresh.getCurrentArtifact(taskId)).resolves.toMatchObject({ ref: artifactRef });
    await expect(fresh.getExecutionBinding(binding.receipt.receiptId))
      .resolves.toEqual(binding.receipt);
  });
});
