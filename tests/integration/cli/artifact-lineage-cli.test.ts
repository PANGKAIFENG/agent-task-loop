import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { artifactNodeId } from '../../../src/domain/artifact-identity.js';
import {
  createArtifactSettlementPlan,
  createArtifactSettlementReceipt,
} from '../../../src/domain/artifact-settlement.js';
import type { ContextCandidate } from '../../../src/domain/context-manifest.js';
import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import {
  projectContextSha256,
  resolveProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { buildContextBundle } from '../../../src/runner/context-bundle.js';
import { persistContextManifest } from '../../../src/runner/context-manifest-runtime.js';
import { resolveExecutionProfile } from '../../../src/runner/execution-profile.js';
import { persistRuntimePack } from '../../../src/runner/runtime-pack.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import { startArtifactTrigger } from '../../../src/services/start-artifact-trigger.js';
import { FileArtifactSettlementRepository } from '../../../src/storage/file-artifact-settlement-repository.js';
import { FileArtifactTriggerRepository } from '../../../src/storage/file-artifact-trigger-repository.js';
import { MarkdownArtifactRepository } from '../../../src/storage/markdown-artifact-repository.js';
import { MarkdownProjectRepository } from '../../../src/storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const tsx = join(repositoryRoot, 'node_modules', '.bin', 'tsx');
const NOW = '2026-09-01T01:00:00.000Z';
const TASK_ID = 'task-synthetic-lineage-cli';
const RUN_ID = 'run-synthetic-lineage-cli';
const TRACE_ID = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V6';
const POLICY_REF = 'policy.artifact-chain.cli@v001';
const temporaryRoots: string[] = [];

function task(projectId: string): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Rebuild one synthetic Artifact lineage from disk',
    body: '\nSynthetic CLI lineage fixture.\n',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId,
    taskType: 'research',
    objective: 'Prove that a fresh process can rebuild persisted lineage.',
    acceptanceCriteria: ['Read every lineage node from its authoritative repository.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-09-01',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:artifact-lineage-cli',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: RUN_ID,
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-09-01T02:00:00.000Z',
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
    projectId: 'project-synthetic-lineage-cli',
    name: 'Synthetic Lineage CLI',
    description: 'Synthetic project used only by the CLI integration test.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const policy: DecisionPolicy = {
  policy_id: 'policy.artifact-chain.cli',
  version: 'v001',
  status: 'observing',
  dimension: 'result-acceptance',
  decision_question: 'Is the exact Artifact ready for the next bounded action?',
  inputs: [{ name: 'artifact', source: 'synthetic_artifact' }],
  sources: ['synthetic_test'],
  rules: [{ statement: 'Bind the decision to the exact Artifact identity.', priority: 1 }],
  exceptions: [],
  outputs: ['bounded continuation'],
  rationale: 'Synthetic policy for a fresh-process lineage read.',
  examples: [],
  counterexamples: [],
  metrics: ['lineage_integrity'],
  next_review_at: '2026-10-01',
  created_at: NOW,
  status_history: [],
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe('artifact lineage CLI', () => {
  it('rebuilds lineage in a fresh process from persisted Task, Artifact, Trace, Manifest and Pack evidence', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-lineage-cli-vault-'));
    const executionRoot = await mkdtemp(join(tmpdir(), 'atl-lineage-cli-runtime-'));
    temporaryRoots.push(vaultRoot, executionRoot);
    const runtimeRoot = join(vaultRoot, '.atl-runtime');
    const atlProject = project();
    const sourceTask = task(atlProject.projectId);
    const tasks = new MarkdownTaskRepository(vaultRoot);
    const artifacts = new MarkdownArtifactRepository(vaultRoot);
    await new MarkdownProjectRepository(vaultRoot).save(atlProject);
    await tasks.save(sourceTask);

    const resolution = resolveProjectContext({
      requestedProjectId: atlProject.projectId,
      sourceSignals: [],
      registry: [{
        projectId: atlProject.projectId,
        aliases: [],
        verification: 'verified',
        canonicalProjectRef: 'projects://synthetic-lineage-cli/home',
        atlProjectId: atlProject.projectId,
        repoRefs: [],
      }],
      canonicalProjects: [{
        projectId: atlProject.projectId,
        ref: 'projects://synthetic-lineage-cli/home',
        atlProjectId: atlProject.projectId,
        repoRefs: [],
        version: 'v1',
        sha256: 'a'.repeat(64),
      }],
      atlProjects: [{
        project: atlProject,
        ref: `atl-project://${atlProject.projectId}`,
        canonicalProjectRef: 'projects://synthetic-lineage-cli/home',
        repoRefs: [],
        sha256: projectContextSha256(atlProject),
      }],
    });
    if (resolution.status !== 'resolved') throw new Error('Synthetic project did not resolve');
    const bundle = await buildContextBundle(sourceTask, atlProject, {
      allowedLocalRoots: [],
    });
    const candidates: ContextCandidate[] = bundle.blocks.map((block) => ({
      candidateId: `candidate-${block.label}`,
      category: block.category,
      sourceRef: block.sourceRef,
      version: block.version,
      expectedSha256: block.sha256,
      selection: 'selected',
      selectionReason: 'Required by the synthetic lineage CLI fixture.',
      blockLabel: block.label,
    }));
    const manifest = await persistContextManifest(runtimeRoot, {
      taskId: TASK_ID,
      runId: RUN_ID,
      asOf: NOW,
      projectResolution: resolution,
      context: bundle,
      candidates,
    });
    const pack = await persistRuntimePack(runtimeRoot, {
      task: sourceTask,
      project: atlProject,
      context: bundle,
      executionProfile: resolveExecutionProfile(sourceTask),
      contextManifest: {
        manifestId: manifest.manifest.manifestId,
        sha256: manifest.manifest.sha256,
      },
      asOf: NOW,
      expiresAt: sourceTask.claim!.leaseExpiresAt,
    });
    const written = await artifacts.write({
      task: sourceTask,
      runId: RUN_ID,
      agent: 'synthetic-agent',
      createdAt: '2026-09-01T01:10:00.000Z',
      packId: pack.packId,
      result: {
        summary: 'A fresh process must rebuild this Artifact lineage from disk.',
        findings: ['Every required Phase 0 evidence object is persisted.'],
        evidence: [{
          title: 'Synthetic evidence',
          url: 'https://example.com/synthetic-lineage-cli',
          accessedAt: NOW,
        }],
        uncertainties: [],
        recommendedActions: ['Read the lineage through the public CLI.'],
        acceptance: [{
          criterion: sourceTask.acceptanceCriteria[0]!,
          status: 'met',
          note: 'Covered by the fresh-process CLI assertion.',
        }],
      },
    });
    await tasks.save({
      ...sourceTask,
      status: 'review',
      claim: null,
      artifactRefs: [written.ref],
      updatedAt: '2026-09-01T01:10:00.000Z',
    });
    const decision = createDecisionServiceContext(vaultRoot, {
      clock: () => new Date('2026-09-01T01:11:00.000Z'),
    });
    await decision.policies.create(policy);
    const artifact = await artifacts.readProductionEvidence(written.ref);
    await decision.traces.create({
      trace_id: TRACE_ID,
      policy_ref: POLICY_REF,
      dimension: 'result-acceptance',
      input_refs: [
        `context-manifest:${manifest.manifest.manifestId}`,
        artifactNodeId(artifact.identity),
      ],
      decision: 'Use the persisted Artifact as the reviewed Phase 0 result.',
      reasoning_summary: 'The exact Artifact and Context Manifest are persisted and auditable.',
      evidence_refs: [artifactNodeId(artifact.identity)],
      confidence: 'high',
      created_at: '2026-09-01T01:11:00.000Z',
    }, {
      policyResolver: (ref) => decision.policies.get(ref as `${string}@${string}`),
    });

    const bindingResult = await execa(tsx, [
      cli,
      'artifact',
      'decision',
      'bind',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--trace-id', TRACE_ID,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });
    expect(bindingResult.exitCode, bindingResult.stderr).toBe(0);
    const binding = JSON.parse(bindingResult.stdout) as {
      decisionId: string;
      traceId: string;
    };
    expect(binding).toMatchObject({
      decisionId: expect.stringMatching(/^ad_[0-9a-f]{24}$/u),
      traceId: TRACE_ID,
    });
    const trigger = await startArtifactTrigger({
      repository: new FileArtifactTriggerRepository(runtimeRoot),
      clock: () => new Date('2026-09-01T01:11:30.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, {
      idempotencyKey: 'artifact-trigger-synthetic-lineage-cli',
      executionTarget: 'local',
      taskId: TASK_ID,
      sourceRunId: RUN_ID,
      decisionId: binding.decisionId,
      artifactRef: artifact.identity.ref,
      artifactVersion: artifact.identity.version,
      artifactSha256: artifact.identity.sha256,
    });
    const settlementRepository = new FileArtifactSettlementRepository(runtimeRoot);
    const settlementPlan = createArtifactSettlementPlan({
      artifact: artifact.identity,
      decisionId: binding.decisionId,
      requestedDestination: 'task_only',
      targetRef: `vault-file://${artifact.identity.ref}`,
      authorizedDestinations: ['task_only'],
      createdAt: '2026-09-01T01:12:00.000Z',
    });
    await settlementRepository.createPlan(settlementPlan);
    const settlementReceipt = createArtifactSettlementReceipt(settlementPlan, {
      status: 'completed',
      writes: [{
        targetRef: settlementPlan.targetRef!,
        version: '1',
        sha256: artifact.identity.sha256,
        externalId: null,
        readback: 'verified',
        backlink: {
          artifactRef: artifact.identity.ref,
          artifactSha256: artifact.identity.sha256,
          decisionId: binding.decisionId,
        },
      }],
    }, '2026-09-01T01:12:30.000Z');
    await settlementRepository.createReceipt(settlementReceipt);
    const replayResult = await execa(tsx, [
      cli,
      'artifact',
      'decision',
      'bind',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--trace-id', TRACE_ID,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });
    expect(replayResult.exitCode, replayResult.stderr).toBe(0);
    expect(JSON.parse(replayResult.stdout)).toMatchObject({
      decisionId: binding.decisionId,
      created: false,
    });

    const result = await execa(tsx, [
      cli,
      'artifact',
      'lineage',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--decision-id', binding.decisionId,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      status: string;
      nodes: string[];
    };
    expect(report.status).toBe('valid');
    expect(report.nodes).toContain(artifactNodeId(artifact.identity));
    expect(report.nodes).toContain(`context-manifest:${manifest.manifest.manifestId}`);
    expect(report.nodes).toContain(`runtime-pack:${pack.packId}`);
    expect(report.nodes).toContain(`decision:${binding.decisionId}`);
    expect(report.nodes).toContain(`trigger:${trigger.receipt.idempotencyKey}`);
    expect(report.nodes).toContain(`settlement-plan:${settlementPlan.planId}`);
    expect(report.nodes).toContain(`settlement-receipt:${settlementReceipt.receiptId}`);

    const bindingPath = join(
      runtimeRoot,
      'artifact-decisions',
      `${binding.decisionId}.json`,
    );
    const originalBinding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
      createdAt: string;
      artifact: { sha256: string };
    };
    const timeCorruptedBinding = structuredClone(originalBinding);
    timeCorruptedBinding.createdAt = '2026-09-01T01:12:00.000Z';
    await writeFile(bindingPath, `${JSON.stringify(timeCorruptedBinding, null, 2)}\n`, 'utf8');
    const timeCorruptedResult = await execa(tsx, [
      cli,
      'artifact',
      'lineage',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--decision-id', binding.decisionId,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });
    expect(timeCorruptedResult.exitCode).toBe(1);
    expect(JSON.parse(timeCorruptedResult.stdout)).toMatchObject({
      ok: false,
      error: { code: 'artifact_decision_evidence_invalid' },
    });

    const decisionInjectedBinding = {
      ...originalBinding,
      decision: 'approved',
    };
    await writeFile(
      bindingPath,
      `${JSON.stringify(decisionInjectedBinding, null, 2)}\n`,
      'utf8',
    );
    const decisionInjectedResult = await execa(tsx, [
      cli,
      'artifact',
      'lineage',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--decision-id', binding.decisionId,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });
    expect(decisionInjectedResult.exitCode).toBe(1);
    expect(JSON.parse(decisionInjectedResult.stdout)).toMatchObject({
      ok: false,
      error: { code: 'artifact_decision_evidence_invalid' },
    });

    await writeFile(bindingPath, `${JSON.stringify(originalBinding, null, 2)}\n`, 'utf8');
    const corruptedBinding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
      artifact: { sha256: string };
    };
    corruptedBinding.artifact.sha256 = 'f'.repeat(64);
    await writeFile(bindingPath, `${JSON.stringify(corruptedBinding, null, 2)}\n`, 'utf8');
    const corruptedResult = await execa(tsx, [
      cli,
      'artifact',
      'lineage',
      '--task-id', TASK_ID,
      '--artifact-ref', written.ref,
      '--decision-id', binding.decisionId,
      '--json',
    ], {
      cwd: executionRoot,
      env: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });
    expect(corruptedResult.exitCode).toBe(1);
    expect(JSON.parse(corruptedResult.stdout)).toMatchObject({
      ok: false,
      error: { code: 'artifact_decision_evidence_invalid' },
    });
  });
});
