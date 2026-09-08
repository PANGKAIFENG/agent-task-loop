import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import {
  projectContextSha256,
  type ResolvedProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import type { Task } from '../../../src/domain/task.js';
import type { AcceptanceObject } from '../../../src/domain/acceptance-object.js';
import { ClaudeDriverError } from '../../../src/runner/claude-driver.js';
import { createArtifactChainContextPlanner } from '../../../src/runner/artifact-chain-runtime.js';
import type { ResearchDriver } from '../../../src/runner/research-driver.js';
import {
  createRunnerController,
  getRunnerStatus,
  RunnerBusyError,
} from '../../../src/runner/runner-controller.js';
import type { ResearchResult } from '../../../src/runner/result-contract.js';
import { recordDecision } from '../../../src/services/record-decision.js';
import { bindCodexTask } from '../../../src/services/bind-codex-task.js';
import {
  queryCodexFeedbackCandidates,
  selectCodexFeedbackContext,
} from '../../../src/services/select-codex-feedback-context.js';
import { settleCodexFeedback } from '../../../src/services/settle-codex-feedback.js';
import { snapshotCodexArtifact } from '../../../src/services/snapshot-codex-artifact.js';
import { queryEvalSamples } from '../../../src/services/query-eval-samples.js';
import { reviewArtifactFromExternalReply } from '../../../src/services/review-artifact-from-external-reply.js';
import { reviewTask } from '../../../src/services/review-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';
import { FileCodexFeedbackStateRepository } from '../../../src/storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../../../src/storage/markdown-codex-feedback-repository.js';

const NOW = '2026-07-15T00:00:00.000Z';
const contexts: TestServiceContext[] = [];

function project(): Project {
  return {
    projectId: 'project-runner',
    name: 'Synthetic runner project',
    description: 'Research only public sources.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentExecutableTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-runner-default',
    title: 'Synthetic public research task',
    body: '\nPRIVATE_BODY_SENTINEL_MUST_NOT_ENTER_AUDIT\n',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: 'project-runner',
    taskType: 'research',
    objective: 'Compare public product limits.',
    acceptanceCriteria: ['Cite one official HTTPS source.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_runner_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:runner-default',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function result(status: 'met' | 'partial' = 'met'): ResearchResult {
  return {
    summary: 'The public limit was verified.',
    findings: ['The documented limit is synthetic.'],
    evidence: [{
      title: 'Official documentation',
      url: 'https://example.com/docs',
      accessedAt: NOW,
    }],
    uncertainties: status === 'partial' ? ['One secondary detail is unclear.'] : [],
    recommendedActions: [],
    acceptance: [{
      criterion: 'Cite one official HTTPS source.',
      status,
      note: status === 'partial' ? 'Partially supported.' : 'Supported.',
    }],
  };
}

function fakeDriver(execute: ResearchDriver['execute']): ResearchDriver {
  return { name: 'synthetic-driver', execute };
}

async function setup(
  tasks: Task[] = [agentExecutableTask()],
): Promise<TestServiceContext> {
  const context = await createTestServiceContext({
    now: new Date(NOW),
  });
  contexts.push(context);
  await context.ctx.projects.create(project());
  for (const task of tasks) {
    await context.ctx.tasks.save(task);
  }
  return context;
}

function controller(
  context: TestServiceContext,
  driver: ResearchDriver,
  runIds: string[] = ['run-runner-001'],
  options: {
    allowedLocalRoots?: string[];
    artifactChainContextPlanner?: Parameters<typeof createRunnerController>[0]['artifactChainContextPlanner'];
  } = {},
) {
  let nextRun = 0;
  return createRunnerController({
    ctx: context.ctx,
    driver,
    runtimeRoot: join(context.root, '.atl-runtime'),
    allowedLocalRoots: options.allowedLocalRoots ?? [],
    ...(options.artifactChainContextPlanner === undefined
      ? {}
      : { artifactChainContextPlanner: options.artifactChainContextPlanner }),
    leaseMinutes: 60,
    timeoutMs: 30 * 60 * 1000,
    agent: 'synthetic-runner',
    runId: () => {
      const runId = runIds[nextRun];
      if (runId === undefined) throw new Error('Run ID sequence exhausted');
      nextRun += 1;
      return runId;
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('bounded run-once orchestration', () => {
  it('reports empty runner status without initializing or changing storage', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);

    await expect(getRunnerStatus(context.ctx)).resolves.toEqual({
      latestRun: null,
      blockedTasks: [],
      nextEligibleTask: null,
    });
    await expect(stat(join(context.root, '10_Tasks')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('claims, builds context, executes and submits one eligible task', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    const outcome = await controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    });

    expect(outcome).toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      artifactRef: 'Artifacts/task-runner-default/attempt-001.md',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      task: { taskId: 'task-runner-default', status: 'in_progress', attempts: 1 },
      context: { taskId: 'task-runner-default' },
      profile: {
        profileId: 'research_v1',
        profileVersion: 1,
        allowedTools: ['WebSearch', 'WebFetch', 'Read'],
      },
      timeoutMs: 30 * 60 * 1000,
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
      claim: null,
      artifactRefs: ['Artifacts/task-runner-default/attempt-001.md'],
    });
    await expect(getRunnerStatus(context.ctx)).resolves
      .toMatchObject({
        latestRun: {
          event: 'artifact.submitted',
          taskId: 'task-runner-default',
          runId: 'run-runner-001',
        },
      });
    await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a research result that does not answer every task acceptance criterion', async () => {
    const context = await setup([agentExecutableTask({
      acceptanceCriteria: [
        'Cite one official HTTPS source.',
        'State the remaining uncertainty.',
      ],
    })]);
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: 'invalid_research_result',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'agent_executable',
      artifactRefs: [],
    });
  });

  it('freezes one Runtime Pack before execution and binds it to the Artifact and audit', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockImplementation(async () => {
      const files = await readdir(join(context.root, '.atl-runtime', 'context-packs'));
      expect(files).toEqual([expect.stringMatching(/^rpr_[0-9a-f]{24}\.json$/)]);
      return result();
    });

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({ status: 'submitted' });

    const bundle = execute.mock.calls[0]?.[0].context;
    expect(bundle?.packId).toMatch(/^pack-[0-9a-f]{24}$/);
    const artifact = await readFile(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      'task-runner-default',
      'attempt-001.md',
    ), 'utf8');
    expect(artifact).toContain(`pack_id: ${bundle?.packId}`);
    await expect(context.ctx.audit.listForTask('task-runner-default')).resolves
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'context_pack.frozen',
          runId: 'run-runner-001',
          details: expect.objectContaining({
            packId: bundle?.packId,
            blockCount: 2,
            permissionProfile: 'read_only_research',
            executionProfileId: 'research_v1',
            executionProfileVersion: 1,
          }),
        }),
        expect.objectContaining({
          event: 'artifact.submitted',
          details: expect.objectContaining({ packId: bundle?.packId }),
        }),
      ]));
  });

  it('freezes actual selected context in a Manifest before the driver starts', async () => {
    const context = await setup();
    const assistantContextRoot = join(context.root, 'synthetic-assistant-context');
    const feedbackPath = join(assistantContextRoot, 'confirmed-feedback.md');
    await mkdir(assistantContextRoot);
    await writeFile(
      feedbackPath,
      'Produce a decision-ready first artifact before requesting refinement.\n',
    );
    const resolvedProject: ResolvedProjectContext = {
      status: 'resolved',
      projectId: 'project-runner',
      match: {
        kind: 'explicit_project_id',
        value: 'project-runner',
        sourceRef: null,
      },
      registry: {
        projectId: 'project-runner',
        aliases: ['synthetic runner'],
        verification: 'verified',
        canonicalProjectRef: 'projects://synthetic/runner',
        atlProjectId: 'project-runner',
        repoRefs: ['repo://personal-ai-workbench'],
      },
      canonical: {
        projectId: 'project-runner',
        ref: 'projects://synthetic/runner',
        atlProjectId: 'project-runner',
        repoRefs: ['repo://personal-ai-workbench'],
        version: 'v1',
        sha256: 'a'.repeat(64),
      },
      atl: {
        project: project(),
        ref: 'atl-project://project-runner',
        canonicalProjectRef: 'projects://synthetic/runner',
        repoRefs: ['repo://personal-ai-workbench'],
        sha256: projectContextSha256(project()),
      },
    };
    const execute = vi.fn<ResearchDriver['execute']>().mockImplementation(async ({ context: bundle }) => {
      expect(bundle.blocks).toContainEqual(expect.objectContaining({
        label: 'feedback_decision_ready',
        kind: 'feedback',
        content: expect.stringContaining('decision-ready first artifact'),
      }));
      const manifestFiles = await readdir(join(
        context.root,
        '.atl-runtime',
        'context-manifests',
      ));
      expect(manifestFiles).toHaveLength(1);
      return result();
    });

    const outcome = await controller(
      context,
      fakeDriver(execute),
      ['run-runner-manifest-001'],
      {
        allowedLocalRoots: [assistantContextRoot],
        artifactChainContextPlanner: async ({ task, project: currentProject }) => ({
          projectContext: {
            requestedProjectId: resolvedProject.projectId,
            sourceSignals: [],
            registry: [resolvedProject.registry],
            canonicalProjects: [resolvedProject.canonical],
            atlProjects: [resolvedProject.atl],
          },
          additionalLocalContexts: [{
            label: 'feedback_decision_ready',
            kind: 'feedback',
            path: feedbackPath,
            sourceRef: 'feedback://synthetic/decision-ready',
            version: 'v1',
          }],
          candidates: [
            {
              candidateId: 'task-current',
              category: 'task',
              sourceRef: `task://${task.taskId}`,
              version: task.updatedAt,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'The claimed task defines the current objective.',
              blockLabel: 'task',
            },
            {
              candidateId: 'project-current',
              category: 'project',
              sourceRef: `atl-project://${currentProject.projectId}`,
              version: currentProject.updatedAt,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'The resolved ATL project owns this task.',
              blockLabel: 'project',
            },
            {
              candidateId: 'feedback-decision-ready',
              category: 'feedback',
              sourceRef: 'feedback://synthetic/decision-ready',
              version: 'v1',
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'Confirmed feedback applies to decision-input research.',
              blockLabel: 'feedback_decision_ready',
            },
          ],
        }),
      },
    ).runAndWait({ mode: 'automatic' });

    expect(outcome).toMatchObject({ status: 'submitted' });
    const [packFile] = await readdir(join(context.root, '.atl-runtime', 'context-packs'));
    const pack = JSON.parse(await readFile(join(
      context.root,
      '.atl-runtime',
      'context-packs',
      packFile!,
    ), 'utf8')) as Record<string, unknown>;
    expect(pack).toMatchObject({
      contextManifestId: expect.stringMatching(/^cm_[0-9a-f]{24}$/),
      contextManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await expect(context.ctx.audit.listForTask('task-runner-default')).resolves
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'context_manifest.frozen',
          runId: 'run-runner-manifest-001',
          details: expect.objectContaining({
            status: 'ready',
            consumedCount: 3,
          }),
        }),
    ]));
  });

  it.each(['selected', 'excluded'] as const)(
    'injects only the active %s selection through the production planner', async (finalDecision) => {
    const context = await setup();
    const feedbackState = new FileCodexFeedbackStateRepository(
      join(context.root, '.atl-runtime', 'codex-feedback'),
    );
    const feedbackVisible = new MarkdownCodexFeedbackRepository(context.root);
    const sourceRoot = join(context.root, 'codex-feedback-fixtures');
    const sourcePath = join(sourceRoot, 'source-artifact.md');
    const targetPath = join(sourceRoot, 'target-artifact.md');
    const sourceNotePath = join(context.root, '笔记同步助手', '2026-09-07', 'source.md');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(sourceNotePath, '..'), { recursive: true });
    await writeFile(sourcePath, '# Source artifact\n', 'utf8');
    await writeFile(targetPath, '# Target artifact\n', 'utf8');
    await writeFile(sourceNotePath, '# Source note\n', 'utf8');

    const sourceBinding = (await bindCodexTask({
      repository: feedbackState,
      clock: () => new Date(NOW),
    }, {
      threadId: 'thread-feedback-source',
      taskId: 'task-feedback-source',
      sourceRef: '笔记同步助手/2026-09-07/source.md#feedback',
      sourceSha256: createHash('sha256').update('# Source note\n').digest('hex'),
      artifactRoot: sourceRoot,
      artifactPath: sourcePath,
      experimentId: 'experiment-production-feedback',
    })).binding;
    await snapshotCodexArtifact({ repository: feedbackState, clock: () => new Date(NOW) }, {
      bindingId: sourceBinding.bindingId,
      artifactVersion: 1,
    });
    await settleCodexFeedback({
      stateRepository: feedbackState,
      visibleRepository: feedbackVisible,
      clock: () => new Date(NOW),
    }, {
      bindingId: sourceBinding.bindingId,
      messageId: 'message-production-feedback',
      messageContent: 'Make the report decision-oriented.',
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Lead with the decision and make trade-offs explicit.',
      applicabilityLabels: ['research_report'],
      guidance: 'Put evidence after the decision and trade-offs.',
      captureMode: 'automatic',
    });

    const targetBinding = (await bindCodexTask({
      repository: feedbackState,
      clock: () => new Date(NOW),
    }, {
      threadId: 'thread-task-runner-default',
      taskId: 'task-runner-default',
      sourceRef: '笔记同步助手/2026-09-07/source.md#target',
      sourceSha256: createHash('sha256').update('# Source note\n').digest('hex'),
      artifactRoot: sourceRoot,
      artifactPath: targetPath,
      experimentId: 'experiment-production-feedback',
    })).binding;
    await snapshotCodexArtifact({ repository: feedbackState, clock: () => new Date(NOW) }, {
      bindingId: targetBinding.bindingId,
      artifactVersion: 1,
    });
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: feedbackState,
      visibleRepository: feedbackVisible,
    }, { targetBindingId: targetBinding.bindingId });
    const exclusions = candidates.map((candidate) => ({
      feedbackId: candidate.feedbackId,
      expectedDocumentSha256: candidate.documentSha256,
      decision: 'excluded' as const,
      reason: 'Not applicable to this research report.',
    }));
    await selectCodexFeedbackContext({
      stateRepository: feedbackState,
      visibleRepository: feedbackVisible,
      clock: () => new Date(NOW),
    }, { targetBindingId: targetBinding.bindingId, decisions: exclusions });
    await selectCodexFeedbackContext({
      stateRepository: feedbackState,
      visibleRepository: feedbackVisible,
      clock: () => new Date(NOW),
    }, {
      targetBindingId: targetBinding.bindingId,
      decisions: candidates.map((candidate) => ({
        feedbackId: candidate.feedbackId,
        expectedDocumentSha256: candidate.documentSha256,
        decision: 'selected' as const,
        reason: 'Confirmed correction applies to this research report.',
      })),
    });

    if (finalDecision === 'excluded') {
      await selectCodexFeedbackContext({
        stateRepository: feedbackState,
        visibleRepository: feedbackVisible,
        clock: () => new Date(NOW),
      }, { targetBindingId: targetBinding.bindingId, decisions: exclusions });
    }

    const execute = vi.fn<ResearchDriver['execute']>().mockImplementation(async ({ context: bundle }) => {
      const feedbackBlocks = bundle.blocks.filter((block) => block.kind === 'feedback');
      if (finalDecision === 'selected') {
        expect(feedbackBlocks).toEqual([expect.objectContaining({
          content: expect.stringContaining('Lead with the decision'),
        })]);
      } else {
        expect(feedbackBlocks).toEqual([]);
      }
      return result();
    });
    await expect(controller(
      context,
      fakeDriver(execute),
      ['run-production-feedback-001'],
      {
        allowedLocalRoots: [context.root],
        artifactChainContextPlanner: createArtifactChainContextPlanner({
          vaultRoot: context.root,
        }),
      },
    ).runAndWait({ mode: 'automatic' })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-production-feedback-001',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('blocks a Run before driver execution when selected context lacks read evidence', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());
    const currentProject = project();
    const resolvedProject: ResolvedProjectContext = {
      status: 'resolved',
      projectId: currentProject.projectId,
      match: {
        kind: 'explicit_project_id',
        value: currentProject.projectId,
        sourceRef: null,
      },
      registry: {
        projectId: currentProject.projectId,
        aliases: [],
        verification: 'verified',
        canonicalProjectRef: 'projects://synthetic/runner',
        atlProjectId: currentProject.projectId,
        repoRefs: [],
      },
      canonical: {
        projectId: currentProject.projectId,
        ref: 'projects://synthetic/runner',
        atlProjectId: currentProject.projectId,
        repoRefs: [],
        version: 'v1',
        sha256: 'a'.repeat(64),
      },
      atl: {
        project: currentProject,
        ref: `atl-project://${currentProject.projectId}`,
        canonicalProjectRef: 'projects://synthetic/runner',
        repoRefs: [],
        sha256: projectContextSha256(currentProject),
      },
    };

    const outcome = await controller(
      context,
      fakeDriver(execute),
      ['run-runner-manifest-blocked'],
      {
        artifactChainContextPlanner: async () => ({
          projectContext: {
            requestedProjectId: resolvedProject.projectId,
            sourceSignals: [],
            registry: [resolvedProject.registry],
            canonicalProjects: [resolvedProject.canonical],
            atlProjects: [resolvedProject.atl],
          },
          additionalLocalContexts: [],
          candidates: [
            {
              candidateId: 'task-current',
              category: 'task',
              sourceRef: 'task://task-runner-default',
              version: NOW,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'Current task.',
              blockLabel: 'task',
            },
            {
              candidateId: 'project-current',
              category: 'project',
              sourceRef: 'atl-project://project-runner',
              version: NOW,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'Current project.',
              blockLabel: 'project',
            },
            {
              candidateId: 'feedback-required',
              category: 'feedback',
              sourceRef: 'feedback://synthetic/required',
              version: 'v1',
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'Confirmed feedback applies.',
              blockLabel: 'feedback_required',
            },
          ],
        }),
      },
    ).runAndWait({ mode: 'automatic' });

    expect(outcome).toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-manifest-blocked',
      errorCode: 'context_manifest_blocked',
    });
    expect(execute).not.toHaveBeenCalled();
    const files = await readdir(join(context.root, '.atl-runtime', 'context-manifests'));
    expect(files).toHaveLength(1);
  });

  it('rejects Planner project evidence that does not match the persisted Project readback', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());
    const forgedProject = {
      ...project(),
      description: 'Planner-only content that was never persisted.',
    };

    const outcome = await controller(
      context,
      fakeDriver(execute),
      ['run-runner-project-readback-conflict'],
      {
        artifactChainContextPlanner: async ({ task, project: persistedProject }) => {
          expect(projectContextSha256(persistedProject))
            .not.toBe(projectContextSha256(forgedProject));
          return {
            projectContext: {
            requestedProjectId: 'project-runner',
            sourceSignals: [],
            registry: [{
              projectId: 'project-runner',
              aliases: [],
              verification: 'verified',
              canonicalProjectRef: 'projects://synthetic/runner',
              atlProjectId: 'project-runner',
              repoRefs: [],
            }],
            canonicalProjects: [{
              projectId: 'project-runner',
              ref: 'projects://synthetic/runner',
              atlProjectId: 'project-runner',
              repoRefs: [],
              version: 'v1',
              sha256: 'a'.repeat(64),
            }],
            atlProjects: [{
              project: forgedProject,
              ref: 'atl-project://project-runner',
              canonicalProjectRef: 'projects://synthetic/runner',
              repoRefs: [],
              sha256: projectContextSha256(forgedProject),
            }],
          },
          additionalLocalContexts: [],
            candidates: [{
            candidateId: 'task-current',
            category: 'task',
            sourceRef: `task://${task.taskId}`,
            version: task.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'Current task.',
            blockLabel: 'task',
            }],
          };
        },
      },
    ).runAndWait({ mode: 'automatic' });

    expect(outcome).toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-project-readback-conflict',
      errorCode: 'invalid_runner_input',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects cross-project reuse of a stable project identity before driver execution', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());
    const currentProject = project();

    const outcome = await controller(
      context,
      fakeDriver(execute),
      ['run-runner-cross-project-identity'],
      {
        artifactChainContextPlanner: async ({ task }) => ({
          projectContext: {
            requestedProjectId: currentProject.projectId,
            sourceSignals: [],
            registry: [
              {
                projectId: currentProject.projectId,
                aliases: [],
                verification: 'verified',
                canonicalProjectRef: 'projects://synthetic/runner',
                atlProjectId: currentProject.projectId,
                repoRefs: [],
              },
              {
                projectId: 'project-other',
                aliases: [],
                verification: 'verified',
                canonicalProjectRef: 'projects://synthetic/runner',
                atlProjectId: 'project-other',
                repoRefs: [],
              },
            ],
            canonicalProjects: [{
              projectId: currentProject.projectId,
              ref: 'projects://synthetic/runner',
              atlProjectId: currentProject.projectId,
              repoRefs: [],
              version: 'v1',
              sha256: 'a'.repeat(64),
            }],
            atlProjects: [{
              project: currentProject,
              ref: `atl-project://${currentProject.projectId}`,
              canonicalProjectRef: 'projects://synthetic/runner',
              repoRefs: [],
              sha256: projectContextSha256(currentProject),
            }],
          },
          additionalLocalContexts: [],
          candidates: [{
            candidateId: 'task-current',
            category: 'task',
            sourceRef: `task://${task.taskId}`,
            version: task.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'Current task.',
            blockLabel: 'task',
          }],
        }),
      },
    ).runAndWait({ mode: 'automatic' });

    expect(outcome).toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-cross-project-identity',
      errorCode: 'invalid_runner_input',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a pending capability Eval sample when a frozen run is approved', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await controller(context, fakeDriver(execute)).runAndWait({ mode: 'automatic' });
    await reviewTask(context.ctx, 'task-runner-default', { decision: 'approve' });

    const events = await context.ctx.audit.listForTask('task-runner-default');
    const frozen = events.find(({ event }) => event === 'context_pack.frozen');
    const submitted = events.find(({ event }) => event === 'artifact.submitted');
    expect(events).toContainEqual(expect.objectContaining({
      event: 'task.reviewed',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      details: expect.objectContaining({
        decision: 'approve',
        evalSampleId: expect.stringMatching(/^eval-[0-9a-f]{24}$/),
        evalSampleType: 'capability',
        evalSampleStatus: 'pending_review',
        regressionCandidateStatus: 'not_proposed',
        packId: frozen?.details?.packId,
        executionProfileId: 'research_v1',
        executionProfileVersion: 1,
        executionProfileSha256: frozen?.details?.executionProfileSha256,
        artifactRef: submitted?.details?.artifactRef,
        artifactSha256: submitted?.details?.artifactSha256,
        runOutcome: 'artifact_submitted',
        humanOutcome: 'approve',
        feedbackSha256: null,
        harnessMutationAllowed: false,
      }),
    }));
    await expect(queryEvalSamples(context.ctx)).resolves.toMatchObject({
      capabilitySamples: [expect.objectContaining({
        sampleId: expect.stringMatching(/^eval-[0-9a-f]{24}$/),
        taskId: 'task-runner-default',
        runId: 'run-runner-001',
        profile: expect.objectContaining({ id: 'research_v1', version: 1 }),
        humanOutcome: 'approve',
        status: 'pending_review',
      })],
      regressionCandidates: [],
    });
  });

  it('reworks a DingTalk-reviewed Artifact into a new version and sends it for acceptance again', async () => {
    const context = await setup();
    const notifications: AcceptanceObject[] = [];
    context.ctx.notifyAcceptance = async (object) => {
      notifications.push(object);
    };
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async ({ context: bundle }) => {
        expect(bundle.blocks[0]?.content).toContain('补充真实用户证据');
        expect(bundle.blocks).toContainEqual(expect.objectContaining({
          label: 'previous_artifact',
          kind: 'artifact_review',
          content: expect.stringContaining('Summary: The public limit was verified.'),
        }));
        return {
          ...result(),
          summary: 'The public limit and user evidence were verified.',
        };
      });
    const runner = controller(context, fakeDriver(execute), [
      'run-artifact-v1',
      'run-artifact-v2',
    ]);

    await runner.runAndWait({ mode: 'automatic' });
    await reviewArtifactFromExternalReply(context.ctx, 'task-runner-default', {
      artifactVersion: 1,
      responseEventId: 'dingtalk-artifact-rework-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      decision: 'request_changes',
      feedback: '补充真实用户证据。',
    });
    const firstReview = (await context.ctx.audit.listForTask('task-runner-default'))
      .find(({ event }) => event === 'task.reviewed');
    expect(firstReview).toMatchObject({
      runId: 'run-artifact-v1',
      details: {
        humanOutcome: 'request_changes',
        regressionCandidateStatus: 'pending_review',
        feedbackSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        harnessMutationAllowed: false,
      },
    });
    expect(JSON.stringify(firstReview)).not.toContain('补充真实用户证据');
    await expect(queryEvalSamples(context.ctx)).resolves.toMatchObject({
      capabilitySamples: [expect.objectContaining({
        runId: 'run-artifact-v1',
        humanOutcome: 'request_changes',
      })],
      regressionCandidates: [expect.objectContaining({
        runId: 'run-artifact-v1',
        candidateStatus: 'pending_review',
        promoted: false,
      })],
    });
    await expect(runner.runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-artifact-v2',
      artifactRef: 'Artifacts/task-runner-default/attempt-002.md',
    });

    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 2,
      artifactRefs: [
        'Artifacts/task-runner-default/attempt-001.md',
        'Artifacts/task-runner-default/attempt-002.md',
      ],
      reviewFeedback: null,
    });
    const reworkPackIds = execute.mock.calls.map((call) => call[0].context.packId);
    expect(reworkPackIds[0]).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(reworkPackIds[1]).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(reworkPackIds[1]).not.toBe(reworkPackIds[0]);
    const secondArtifact = await readFile(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      'task-runner-default',
      'attempt-002.md',
    ), 'utf8');
    expect(secondArtifact).toContain(`pack_id: ${reworkPackIds[1]}`);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({
      artifact: {
        reference: 'task-runner-default@v2',
        summary: 'The public limit and user evidence were verified.',
        evidenceCount: 1,
      },
    });
  });

  it('returns no_task without calling the driver when nothing is eligible', async () => {
    const context = await setup([]);
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'no_task' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps claiming eligible tasks regardless of earlier claims that day', async () => {
    const context = await setup();
    for (let index = 0; index < 3; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-15T00:00:0${index}.000Z`,
        taskId: `task-already-${index}`,
        runId: `run-already-${index}`,
        details: { mode: 'automatic' },
      });
    }
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
    });
    expect(execute).toHaveBeenCalledOnce();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
      claim: null,
    });
  });

  it('pauses a task when the driver requests a user decision', async () => {
    const context = await setup();
    const notifyDecision = vi.fn().mockResolvedValue({ status: 'sent' });
    context.ctx.notifyDecision = notifyDecision;
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue({
      kind: 'decision_request',
      decisionRequestId: 'decision-runner-001',
      question: 'Which direction should continue?',
      options: [
        { id: 'option-a', label: 'Option A' },
        { id: 'option-b', label: 'Option B' },
      ],
    } as never);

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'waiting_for_decision',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      decisionRequestId: 'decision-runner-001',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves
      .toMatchObject({
        status: 'waiting_for_decision',
        claim: null,
        pendingDecision: { requestId: 'decision-runner-001' },
      });
    expect(notifyDecision).toHaveBeenCalledOnce();
    expect(notifyDecision).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-runner-default',
      status: 'waiting_for_decision',
      pendingDecision: expect.objectContaining({ requestId: 'decision-runner-001' }),
    }));
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claimed',
      'context_pack.frozen',
      'decision.requested',
    ]);
  });

  it('keeps the durable decision state when DingTalk notification fails', async () => {
    const context = await setup();
    context.ctx.notifyDecision = vi.fn().mockRejectedValue(
      new Error('synthetic notification failure'),
    );
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue({
      kind: 'decision_request',
      decisionRequestId: 'decision-runner-notify-failure',
      question: 'Which direction should continue?',
      options: [{ id: 'option-a', label: 'Option A' }],
    } as never);

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({
      status: 'waiting_for_decision',
      decisionRequestId: 'decision-runner-notify-failure',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves
      .toMatchObject({
        status: 'waiting_for_decision',
        pendingDecision: { requestId: 'decision-runner-notify-failure' },
      });
  });

  it('continues the same task with a new run after one exact decision event', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-continuation-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockResolvedValueOnce(result());
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-continuation',
    ]);

    await expect(runner.runAndWait({ mode: 'automatic' })).resolves.toMatchObject({
      status: 'waiting_for_decision',
      runId: 'run-initial',
    });
    const decisionEvent = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-continuation-001',
      responseEventId: 'dingtalk-message-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use option B and continue.',
    };

    await expect(runner.continueAfterDecision(decisionEvent)).resolves.toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-continuation',
      artifactRef: 'Artifacts/task-runner-default/attempt-002.md',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const initialPackId = execute.mock.calls[0]?.[0].context.packId;
    const continuationPackId = execute.mock.calls[1]?.[0].context.packId;
    expect(initialPackId).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(continuationPackId).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(continuationPackId).not.toBe(initialPackId);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      task: {
        taskId: 'task-runner-default',
        attempts: 2,
        claim: { runId: 'run-continuation' },
        lastDecision: {
          requestId: 'decision-continuation-001',
          responseEventId: 'dingtalk-message-001',
          senderUserId: 'trusted-user-001',
          conversationId: 'trusted-conversation-001',
        },
      },
      context: {
        blocks: [expect.objectContaining({
          content: expect.stringContaining('Use option B and continue.'),
        }), expect.anything()],
      },
    });

    await expect(runner.continueAfterDecision(decisionEvent)).resolves.toEqual({
      status: 'duplicate_decision',
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-continuation-001',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resumes an exact event replay when the decision committed before a crash', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-recovery-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockResolvedValueOnce(result());
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-recovered',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-recovery-001',
      responseEventId: 'dingtalk-message-recovery-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use option B and continue.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    const { taskId, ...decision } = event;
    await expect(recordDecision(context.ctx, taskId, decision))
      .resolves.toMatchObject({ accepted: true });
    await expect(runner.continueAfterDecision(event)).resolves.toMatchObject({
      status: 'submitted',
      runId: 'run-recovered',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('starts only one continuation when the same reply arrives concurrently', async () => {
    const context = await setup();
    let releaseContinuation: (() => void) | undefined;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-concurrent-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockImplementationOnce(async () => {
        await continuationGate;
        return result();
      });
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-continuation',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-concurrent-001',
      responseEventId: 'dingtalk-message-concurrent-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    const first = runner.continueAfterDecision(event);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const second = runner.continueAfterDecision(event);
    releaseContinuation?.();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.filter(({ status }) => status === 'submitted')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.filter(({ event: name }) => name === 'decision.continuation_started'))
      .toHaveLength(1);
  });

  it('does not execute a failed continuation again when its reply event is replayed', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-failed-continuation-001',
        question: 'Which direction should continue?',
        options: [{ id: 'option-a', label: 'Option A' }],
      })
      .mockRejectedValueOnce(new ClaudeDriverError('claude_timeout'));
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-failed-continuation',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-failed-continuation-001',
      responseEventId: 'dingtalk-message-failed-continuation-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    await expect(runner.continueAfterDecision(event)).resolves.toMatchObject({
      status: 'blocked',
      runId: 'run-failed-continuation',
    });
    await expect(runner.continueAfterDecision(event)).resolves.toEqual({
      status: 'duplicate_decision',
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-failed-continuation-001',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resumes a recorded decision on the next automatic cycle without an event replay', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-scheduled-recovery-001',
        question: 'Which direction should continue?',
        options: [{ id: 'option-a', label: 'Option A' }],
      })
      .mockResolvedValueOnce(result());
    const initialRunner = controller(context, fakeDriver(execute), ['run-initial']);
    await initialRunner.runAndWait({ mode: 'automatic' });
    await recordDecision(context.ctx, 'task-runner-default', {
      decisionRequestId: 'decision-scheduled-recovery-001',
      responseEventId: 'dingtalk-message-scheduled-recovery-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    });

    await expect(controller(
      context,
      fakeDriver(execute),
      ['run-scheduled-recovery'],
    ).runAndWait({ mode: 'automatic' })).resolves.toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-scheduled-recovery',
      artifactRef: 'Artifacts/task-runner-default/attempt-002.md',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 2,
      lastDecision: { continuationRunId: 'run-scheduled-recovery' },
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.filter(({ event }) => event === 'task.claimed')).toHaveLength(1);
    expect(audit).toContainEqual(expect.objectContaining({
      event: 'decision.continuation_started',
      runId: 'run-scheduled-recovery',
      details: expect.objectContaining({ mode: 'automatic' }),
    }));
  });

  it('does not rerun a continuation whose expired claim was recovered', async () => {
    const context = await setup([agentExecutableTask({
      status: 'in_progress',
      attempts: 2,
      claim: {
        runId: 'run-expired-continuation',
        agent: 'synthetic-runner',
        claimedAt: '2026-07-14T22:00:00.000Z',
        leaseExpiresAt: '2026-07-14T23:00:00.000Z',
      },
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-recovered-continuation-001',
        selectedOptionId: 'option-a',
        selectedOptionLabel: 'Option A',
        responseText: 'Use option A.',
        responseEventId: 'dingtalk-message-recovered-continuation-001',
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        respondedAt: NOW,
        continuationRunId: 'run-expired-continuation',
        continuationOfRunId: 'run-initial',
        continuationStartedAt: NOW,
      },
    })]);
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'no_task' });
    expect(execute).not.toHaveBeenCalled();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 2,
      claim: null,
      lastDecision: { continuationRunId: 'run-expired-continuation' },
    });
  });

  it('requeues the first typed driver failure with only a sanitized audit code', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockRejectedValue(new ClaudeDriverError('claude_timeout'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: 'claude_timeout',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'agent_executable',
      attempts: 1,
      claim: null,
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claimed',
      'context_pack.frozen',
      'runner.failed',
    ]);
    expect(audit).toContainEqual(expect.objectContaining({
      event: 'runner.failed',
      runId: 'run-runner-001',
      details: {
        errorCode: 'claude_timeout',
        attempt: 1,
        mode: 'automatic',
        outcome: 'requeued',
      },
    }));
    expect(JSON.stringify(audit)).not.toContain('PRIVATE_BODY_SENTINEL');
  });

  it('blocks the second typed driver failure', async () => {
    const context = await setup([agentExecutableTask({ attempts: 1 })]);
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockRejectedValue(new ClaudeDriverError('claude_timeout'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({
      status: 'blocked',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: 'claude_timeout',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 2,
      claim: null,
    });
  });

  it.each([
    'execution_profile_not_supported',
    'execution_profile_context_missing',
  ])('blocks deterministic Profile failure %s without retrying', async (code) => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockRejectedValue(
      Object.assign(new Error('sanitized deterministic failure'), { code }),
    );

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'blocked',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: code,
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 1,
      claim: null,
    });
    await expect(context.ctx.audit.listForTask('task-runner-default')).resolves
      .toContainEqual(expect.objectContaining({
        event: 'runner.failed',
        details: expect.objectContaining({ errorCode: code, outcome: 'blocked' }),
      }));
  });

  it('lets a named manual run proceed regardless of earlier automatic claims', async () => {
    const context = await setup();
    for (let index = 0; index < 3; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-15T00:00:0${index}.000Z`,
        taskId: `task-already-${index}`,
        details: { mode: 'automatic' },
      });
    }

    await expect(controller(
      context,
      fakeDriver(async () => result()),
    ).runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
    });
  });

  it('submits a partial result to Review without retrying', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValue(result('partial'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({ status: 'submitted' });
    expect(execute).toHaveBeenCalledOnce();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
    });
  });

  it('recovers an expired claim before selecting and running the task', async () => {
    const context = await setup([agentExecutableTask({
      status: 'in_progress',
      attempts: 1,
      claim: {
        runId: 'run-expired',
        agent: 'old-runner',
        claimedAt: '2026-07-14T22:00:00.000Z',
        leaseExpiresAt: '2026-07-14T23:00:00.000Z',
      },
    })]);
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 2,
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claim_expired',
      'task.claimed',
      'context_pack.frozen',
      'artifact.submitted',
    ]);
  });

  it('returns runner_busy to a second controller without claiming its waiting task', async () => {
    let releaseDriver!: (value: ResearchResult) => void;
    const waitingDriver = new Promise<ResearchResult>((resolve) => {
      releaseDriver = resolve;
    });
    const context = await setup([
      agentExecutableTask({ taskId: 'task-running', sourceKey: 'synthetic:running' }),
      agentExecutableTask({ taskId: 'task-waiting', sourceKey: 'synthetic:waiting' }),
    ]);
    const first = controller(
      context,
      fakeDriver(() => waitingDriver),
      ['run-first'],
    );
    const firstRun = first.runAndWait({ mode: 'automatic' });
    await vi.waitFor(async () => {
      await expect(context.ctx.tasks.get('task-running')).resolves.toMatchObject({
        status: 'in_progress',
      });
    });
    const second = controller(
      context,
      fakeDriver(async () => result()),
      ['run-second'],
    );

    await expect(second.runAndWait({ mode: 'automatic' })).resolves.toEqual({
      status: 'runner_busy',
    });
    await expect(context.ctx.tasks.get('task-waiting')).resolves.toMatchObject({
      status: 'agent_executable',
      attempts: 0,
      claim: null,
    });
    await expect(context.ctx.audit.count({
      event: 'runner.busy',
      localDate: '2026-07-15',
      mode: 'automatic',
    })).resolves.toBe(1);

    releaseDriver(result());
    await expect(firstRun).resolves.toMatchObject({ status: 'submitted' });
  });

  it('acquires the lock before start returns and rejects a competing start', async () => {
    let releaseDriver!: (value: ResearchResult) => void;
    const waitingDriver = new Promise<ResearchResult>((resolve) => {
      releaseDriver = resolve;
    });
    const context = await setup();
    const runner = controller(
      context,
      fakeDriver(() => waitingDriver),
      ['run-background', 'run-competing'],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({ runId: 'run-background' });
    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).rejects.toBeInstanceOf(RunnerBusyError);

    releaseDriver(result());
    await vi.waitFor(async () => {
      await expect(context.ctx.tasks.get('task-runner-default')).resolves
        .toMatchObject({ status: 'review' });
      await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('releases the lock when start fails before launching the background pipeline', async () => {
    const context = await setup();
    const runner = controller(
      context,
      fakeDriver(async () => result()),
      [],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).rejects.toThrow('Run ID sequence exhausted');
    await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes a terminal background failure and releases the lock', async () => {
    const context = await setup([]);
    const runner = controller(
      context,
      fakeDriver(async () => result()),
      ['run-terminal'],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'PRIVATE_TERMINAL_SENTINEL\ninvalid',
    })).resolves.toEqual({ runId: 'run-terminal' });
    await vi.waitFor(async () => {
      await expect(context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      })).resolves.toMatchObject({
        event: 'runner.terminal_failure',
        runId: 'run-terminal',
        details: {
          errorCode: 'invalid_task_data',
          mode: 'manual',
        },
      });
      expect(await context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      })).not.toHaveProperty('taskId');
      expect(JSON.stringify(await context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      }))).not.toContain('PRIVATE_TERMINAL_SENTINEL');
      await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
