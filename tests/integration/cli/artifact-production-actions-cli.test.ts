import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { artifactNodeId } from '../../../src/domain/artifact-identity.js';
import { createArtifactSettlementPlan } from '../../../src/domain/artifact-settlement.js';
import type { ContextCandidate } from '../../../src/domain/context-manifest.js';
import type { DecisionPolicy } from '../../../src/domain/decision-policy.js';
import { projectContextSha256, resolveProjectContext } from '../../../src/domain/project-context-resolution.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { buildContextBundle } from '../../../src/runner/context-bundle.js';
import { persistContextManifest } from '../../../src/runner/context-manifest-runtime.js';
import { resolveExecutionProfile } from '../../../src/runner/execution-profile.js';
import { persistRuntimePack, readRuntimePackForRun } from '../../../src/runner/runtime-pack.js';
import { bindArtifactDecision } from '../../../src/services/bind-artifact-decision.js';
import { createDecisionServiceContext } from '../../../src/services/service-context.js';
import { FileArtifactDecisionRepository } from '../../../src/storage/file-artifact-decision-repository.js';
import { FileArtifactSettlementRepository } from '../../../src/storage/file-artifact-settlement-repository.js';
import { MarkdownArtifactRepository } from '../../../src/storage/markdown-artifact-repository.js';
import { MarkdownProjectRepository } from '../../../src/storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const tsx = join(repositoryRoot, 'node_modules', '.bin', 'tsx');
const NOW = '2026-09-01T02:00:00.000Z';
const temporaryRoots: string[] = [];

const policy: DecisionPolicy = {
  policy_id: 'policy.artifact.production-actions',
  version: 'v001',
  status: 'observing',
  dimension: 'result-acceptance',
  decision_question: 'Should this exact Artifact continue?',
  inputs: [{ name: 'artifact', source: 'synthetic_artifact' }],
  sources: ['synthetic_test'],
  rules: [{ statement: 'Bind the continuation to exact persisted evidence.', priority: 1 }],
  exceptions: [],
  outputs: ['bounded continuation'],
  rationale: 'Synthetic policy for the production CLI test.',
  examples: [],
  counterexamples: [],
  metrics: ['artifact_chain_integrity'],
  next_review_at: '2026-10-01',
  created_at: NOW,
  status_history: [],
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function project(): Project {
  return {
    projectId: 'project-artifact-production-cli',
    name: 'Artifact Production CLI',
    description: 'Synthetic project used only by the CLI integration test.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function sourceTask(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-artifact-production-cli',
    title: 'Continue one persisted Artifact',
    body: '\nSynthetic CLI fixture.\n',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: project().projectId,
    taskType: 'research',
    objective: 'Prove a stable-ID CLI can start an evidence-bound continuation.',
    acceptanceCriteria: ['Persist a second Artifact with a bound continuation Runtime Pack.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-09-01',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:artifact-production-cli',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-artifact-production-source',
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-09-01T03:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function fakeClaudeExecutable(root: string): Promise<string> {
  const executable = join(root, 'claude-synthetic.mjs');
  const help = [
    '--print',
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode <mode> (choices: dontAsk)',
    '--tools <tools>',
    '--output-format <format>',
    '--json-schema <schema>',
    '--max-budget-usd <amount>',
  ].join('\n');
  const result = {
    summary: 'The persisted Artifact was continued through the production CLI.',
    findings: ['The continuation consumed the previous Artifact.'],
    evidence: [{
      title: 'Synthetic continuation evidence',
      url: 'https://example.com/artifact-production-cli',
      accessedAt: NOW,
    }],
    uncertainties: [],
    recommendedActions: ['Inspect the persisted continuation Runtime Pack.'],
    acceptance: [{
      criterion: 'Persist a second Artifact with a bound continuation Runtime Pack.',
      status: 'met',
      note: 'The second Artifact and Runtime Pack are persisted.',
    }],
  };
  await writeFile(executable, [
    '#!/usr/bin/env node',
    `const help = ${JSON.stringify(help)};`,
    `const result = ${JSON.stringify(result)};`,
    'if (process.argv.includes("--help")) process.stdout.write(help);',
    'else process.stdout.write(JSON.stringify({ structured_output: result }));',
    '',
  ].join('\n'), 'utf8');
  await chmod(executable, 0o700);
  return executable;
}

async function prepareTriggerFixture(vaultRoot: string) {
  const runtimeRoot = join(vaultRoot, '.atl-runtime');
  const atlProject = project();
  const task = sourceTask();
  const tasks = new MarkdownTaskRepository(vaultRoot);
  const artifacts = new MarkdownArtifactRepository(vaultRoot);
  await new MarkdownProjectRepository(vaultRoot).save(atlProject);
  await tasks.save(task);
  const resolution = resolveProjectContext({
    requestedProjectId: atlProject.projectId,
    sourceSignals: [],
    registry: [{
      projectId: atlProject.projectId,
      aliases: [],
      verification: 'verified',
      canonicalProjectRef: 'projects://artifact-production-cli/home',
      atlProjectId: atlProject.projectId,
      repoRefs: [],
    }],
    canonicalProjects: [{
      projectId: atlProject.projectId,
      ref: 'projects://artifact-production-cli/home',
      atlProjectId: atlProject.projectId,
      repoRefs: [],
      version: 'v1',
      sha256: 'a'.repeat(64),
    }],
    atlProjects: [{
      project: atlProject,
      ref: `atl-project://${atlProject.projectId}`,
      canonicalProjectRef: 'projects://artifact-production-cli/home',
      repoRefs: [],
      sha256: projectContextSha256(atlProject),
    }],
  });
  if (resolution.status !== 'resolved') throw new Error('Synthetic project did not resolve');
  const context = await buildContextBundle(task, atlProject, { allowedLocalRoots: [] });
  const candidates: ContextCandidate[] = context.blocks.map((block) => ({
    candidateId: `candidate-${block.label}`,
    category: block.category,
    sourceRef: block.sourceRef,
    version: block.version,
    expectedSha256: block.sha256,
    selection: 'selected',
    selectionReason: 'Required by the synthetic production CLI fixture.',
    blockLabel: block.label,
  }));
  const manifest = await persistContextManifest(runtimeRoot, {
    taskId: task.taskId,
    runId: task.claim!.runId,
    asOf: NOW,
    projectResolution: resolution,
    context,
    candidates,
  });
  const pack = await persistRuntimePack(runtimeRoot, {
    task,
    project: atlProject,
    context,
    executionProfile: resolveExecutionProfile(task),
    contextManifest: {
      manifestId: manifest.manifest.manifestId,
      sha256: manifest.manifest.sha256,
    },
    asOf: NOW,
    expiresAt: task.claim!.leaseExpiresAt,
  });
  const written = await artifacts.write({
    task,
    runId: task.claim!.runId,
    agent: 'synthetic-agent',
    createdAt: '2026-09-01T02:05:00.000Z',
    packId: pack.packId,
    result: {
      summary: 'The source Artifact is ready for one bounded continuation.',
      findings: ['Every source evidence object is persisted.'],
      evidence: [{
        title: 'Synthetic source evidence',
        url: 'https://example.com/artifact-production-source',
        accessedAt: NOW,
      }],
      uncertainties: [],
      recommendedActions: ['Continue from this exact Artifact.'],
      acceptance: [{
        criterion: task.acceptanceCriteria[0]!,
        status: 'partial',
        note: 'The continuation remains to be executed.',
      }],
    },
  });
  const artifact = await artifacts.readProductionEvidence(written.ref);
  await tasks.save({
    ...task,
    status: 'agent_executable',
    claim: null,
    artifactRefs: [written.ref],
    reviewFeedback: 'Continue the approved direction.',
    updatedAt: '2026-09-01T02:06:00.000Z',
  });
  const decisions = createDecisionServiceContext(vaultRoot, {
    clock: () => new Date('2026-09-01T02:07:00.000Z'),
  });
  await decisions.policies.create(policy);
  const traceId = 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V7';
  await decisions.traces.create({
    trace_id: traceId,
    policy_ref: 'policy.artifact.production-actions@v001',
    dimension: 'result-acceptance',
    input_refs: [
      `context-manifest:${manifest.manifest.manifestId}`,
      artifactNodeId(artifact.identity),
    ],
    decision: 'Continue this exact Artifact once.',
    reasoning_summary: 'The source Artifact and context are persisted and auditable.',
    evidence_refs: [artifactNodeId(artifact.identity)],
    confidence: 'high',
    created_at: '2026-09-01T02:07:00.000Z',
  }, {
    policyResolver: (ref) => decisions.policies.get(ref as `${string}@${string}`),
  });
  const bound = await bindArtifactDecision({
    tasks,
    artifacts,
    traces: decisions.traces,
    decisions: new FileArtifactDecisionRepository(runtimeRoot),
    clock: () => new Date('2026-09-01T02:08:00.000Z'),
  }, {
    taskId: task.taskId,
    artifactRef: written.ref,
    traceId,
  });
  return { runtimeRoot, taskId: task.taskId, artifactRef: written.ref, decisionId: bound.binding.decisionId };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe('Artifact production action CLI', () => {
  it('starts and replays an evidence-derived Artifact continuation across fresh processes', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-trigger-cli-'));
    const executionRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-trigger-cwd-'));
    temporaryRoots.push(vaultRoot, executionRoot);
    const fixture = await prepareTriggerFixture(vaultRoot);
    const claude = await fakeClaudeExecutable(executionRoot);
    const args = [
      cli,
      'artifact', 'trigger', 'start',
      '--task-id', fixture.taskId,
      '--artifact-ref', fixture.artifactRef,
      '--decision-id', fixture.decisionId,
      '--driver', 'claude',
      '--json',
    ];
    const first = await execa(tsx, args, {
      cwd: executionRoot,
      env: { ATL_VAULT_ROOT: vaultRoot, ATL_CLAUDE_BIN: claude },
      reject: false,
    });
    expect(first.exitCode, first.stderr).toBe(0);
    const created = JSON.parse(first.stdout) as {
      started: boolean;
      receipt: { state: string; continuationRunId: string };
    };
    expect(created).toMatchObject({
      started: true,
      receipt: {
        state: 'started',
        continuationRunId: expect.stringMatching(/^run-artifact-[0-9a-f]{24}$/u),
      },
    });
    const continuationPack = await readRuntimePackForRun(
      fixture.runtimeRoot,
      fixture.taskId,
      created.receipt.continuationRunId,
    );
    expect(continuationPack?.pack.continuationOfRunId)
      .toBe('run-artifact-production-source');

    const replay = await execa(tsx, args, {
      cwd: executionRoot,
      env: { ATL_VAULT_ROOT: vaultRoot, ATL_CLAUDE_BIN: '/usr/bin/false' },
      reject: false,
    });
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      started: false,
      receipt: {
        state: 'started',
        continuationRunId: created.receipt.continuationRunId,
      },
    });
    expect((await new MarkdownTaskRepository(vaultRoot).get(fixture.taskId)).artifactRefs)
      .toHaveLength(2);
  });

  it('executes one authorized settlement and replays it without a second write', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-settlement-cli-'));
    const executionRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-settlement-cwd-'));
    temporaryRoots.push(vaultRoot, executionRoot);
    const runtimeRoot = join(vaultRoot, '.atl-runtime');
    const artifactRef = 'Artifacts/task-settlement-cli/attempt-001.md';
    const artifactPath = join(vaultRoot, '10_Tasks', artifactRef);
    await mkdir(join(vaultRoot, '10_Tasks', 'Artifacts', 'task-settlement-cli'), {
      recursive: true,
    });
    const artifactContent = 'Synthetic settlement source.\n';
    await writeFile(artifactPath, artifactContent, 'utf8');
    const plan = createArtifactSettlementPlan({
      artifact: {
        taskId: 'task-settlement-cli',
        ref: artifactRef,
        version: 1,
        sha256: sha256(artifactContent),
      },
      decisionId: 'ad_111111111111111111111111',
      requestedDestination: 'personal_knowledge',
      targetRef: 'vault-file:///Research/Settled/result.md',
      authorizedDestinations: ['personal_knowledge'],
      createdAt: NOW,
    });
    const repository = new FileArtifactSettlementRepository(runtimeRoot);
    await repository.createPlan(plan);
    await repository.createAuthorization({
      schemaVersion: 1,
      authorizationId: `authorization-${plan.planId}`,
      planId: plan.planId,
      artifactRef: plan.artifact.ref,
      artifactSha256: plan.artifact.sha256,
      decisionId: plan.decisionId,
      logicalDestination: 'personal_knowledge',
      vaultRoot,
      targetRef: plan.targetRef!,
      requiredPermission: plan.requiredPermission!,
      authorizedAt: '2026-09-01T02:10:00.000Z',
      readBackReceipt: `synthetic-readback://${plan.planId}`,
    });
    const args = [
      cli,
      'artifact', 'settlement', 'execute',
      '--plan-id', plan.planId,
      '--json',
    ];
    const first = await execa(tsx, args, {
      cwd: executionRoot,
      env: { ATL_VAULT_ROOT: vaultRoot },
      reject: false,
    });
    expect(first.exitCode, first.stderr).toBe(0);
    const executed = JSON.parse(first.stdout) as {
      executed: boolean;
      receipt: { receiptId: string; status: string };
    };
    expect(executed).toMatchObject({
      executed: true,
      receipt: { status: 'completed' },
    });
    const targetPath = join(vaultRoot, 'Research', 'Settled', 'result.md');
    const settled = await readFile(targetPath, 'utf8');

    const replay = await execa(tsx, args, {
      cwd: executionRoot,
      env: { ATL_VAULT_ROOT: vaultRoot },
      reject: false,
    });
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      executed: false,
      receipt: { receiptId: executed.receipt.receiptId, status: 'completed' },
    });
    expect(await readFile(targetPath, 'utf8')).toBe(settled);
  });

  it('performs no settlement write without persisted authorization', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-settlement-no-auth-'));
    const executionRoot = await mkdtemp(join(tmpdir(), 'atl-artifact-settlement-no-auth-cwd-'));
    temporaryRoots.push(vaultRoot, executionRoot);
    const artifactRef = 'Artifacts/task-settlement-no-auth/attempt-001.md';
    const artifactPath = join(vaultRoot, '10_Tasks', artifactRef);
    await mkdir(join(vaultRoot, '10_Tasks', 'Artifacts', 'task-settlement-no-auth'), {
      recursive: true,
    });
    const artifactContent = 'Synthetic unauthorized settlement source.\n';
    await writeFile(artifactPath, artifactContent, 'utf8');
    const plan = createArtifactSettlementPlan({
      artifact: {
        taskId: 'task-settlement-no-auth',
        ref: artifactRef,
        version: 1,
        sha256: sha256(artifactContent),
      },
      decisionId: 'ad_222222222222222222222222',
      requestedDestination: 'personal_knowledge',
      targetRef: 'vault-file:///Research/Settled/no-auth.md',
      authorizedDestinations: ['personal_knowledge'],
      createdAt: NOW,
    });
    await new FileArtifactSettlementRepository(join(vaultRoot, '.atl-runtime'))
      .createPlan(plan);
    const result = await execa(tsx, [
      cli,
      'artifact', 'settlement', 'execute',
      '--plan-id', plan.planId,
      '--json',
    ], {
      cwd: executionRoot,
      env: { ATL_VAULT_ROOT: vaultRoot },
      reject: false,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ executed: false, receipt: null });
    await expect(readFile(join(vaultRoot, 'Research', 'Settled', 'no-auth.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
