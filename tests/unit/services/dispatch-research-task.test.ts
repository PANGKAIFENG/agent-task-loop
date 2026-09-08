import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MulticaDispatchConnector } from '../../../src/connectors/multica-cli-connector.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import type { ServiceContext } from '../../../src/services/service-context.js';
import {
  dispatchResearchTask,
} from '../../../src/services/dispatch-research-task.js';
import { discoverResearchContext } from '../../../src/services/discover-research-context.js';
import { freshExecutionLink } from '../../../src/services/dispatch-development-task.js';
import { readContextManifestById } from '../../../src/runner/context-manifest-runtime.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T05:00:00.000Z';
const ATL_PROJECT_ID = 'project-research';
const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const MULTICA_PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01a03d19-bd5f-7263-a069-6f0cfde75b8e';
const RUN_ID = '01a057ce-1767-7c10-a6c8-8c966cc66ea7';
const AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const RUNTIME_ID = '5f282aa0-e717-421d-ab84-d1f0d4aab551';
const contexts: TestServiceContext[] = [];

function linkedResult() {
  return {
    status: 'linked' as const,
    ref: {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-999',
    },
    recovered: false,
    activation: {
      assigneeId: AGENT_ID,
      runId: RUN_ID,
      runStatus: 'in_progress',
      runAgentId: AGENT_ID,
      runRuntimeId: RUNTIME_ID,
      recovered: false,
      agent: {
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        model: 'gpt-5.6-sol',
        maxConcurrentTasks: 10,
        runtimeId: RUNTIME_ID,
        status: 'idle',
      },
    },
  };
}

function requiredDiscovery(currentTask: Task, currentProject: Project) {
  return {
    additionalLocalContexts: [],
    candidates: [
      {
        candidateId: 'task-current',
        category: 'task' as const,
        sourceRef: `task://${currentTask.taskId}`,
        version: currentTask.updatedAt,
        expectedSha256: null,
        selection: 'selected' as const,
        selectionReason: 'The current Task is required.',
        blockLabel: 'task',
      },
      {
        candidateId: 'project-current',
        category: 'project' as const,
        sourceRef: `atl-project://${currentProject.projectId}`,
        version: currentProject.updatedAt,
        expectedSha256: null,
        selection: 'selected' as const,
        selectionReason: 'The owning Project is required.',
        blockLabel: 'project',
      },
    ],
  };
}

function project(): Project {
  return {
    projectId: ATL_PROJECT_ID,
    name: 'Synthetic research project',
    description: 'Synthetic project context only.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260901-abc00001',
    title: 'Study a synthetic workflow',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: ATL_PROJECT_ID,
    taskType: 'research',
    objective: 'Produce decision-ready learning input.',
    acceptanceCriteria: ['Explain the mechanism and remaining uncertainty.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    executionTarget: 'multica',
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:research-blocked',
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

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('dispatchResearchTask', () => {
  it('persists a blocked Manifest before making zero Multica calls', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();
    const inspect = vi.fn<MulticaDispatchConnector['inspect']>();

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
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
            selectionReason: 'The current Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${currentProject.projectId}`,
            version: currentProject.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The owning Project is required.',
            blockLabel: 'project',
          },
          {
            candidateId: 'missing-source-note',
            category: 'source',
            sourceRef: 'file:///synthetic/missing-source.md',
            version: null,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The source material is needed to understand the task.',
            blockLabel: 'task_source_note',
          },
        ],
      }),
    }, 'task-20260901-abc00001');

    expect(outcome).toMatchObject({
      status: 'context_blocked',
      taskId: 'task-20260901-abc00001',
      manifestId: expect.stringMatching(/^cm_[0-9a-f]{24}$/),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    await expect(readdir(join(
      context.root,
      '.atl-runtime',
      'context-manifests',
    ))).resolves.toHaveLength(1);
  });

  it('persists a blocked Manifest when selected local context cannot be read', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task({
      sourceNote: '笔记同步助手/2026-09-01/missing.md',
    }));
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      contextBaseRoot: context.root,
      discoverContext: async ({ task: currentTask, project: currentProject }) => ({
        additionalLocalContexts: [],
        includeSourceNote: true,
        candidates: [
          {
            candidateId: 'task-current',
            category: 'task',
            sourceRef: `task://${currentTask.taskId}`,
            version: currentTask.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The current Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${currentProject.projectId}`,
            version: currentProject.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The owning Project is required.',
            blockLabel: 'project',
          },
          {
            candidateId: 'task-source-note',
            category: 'source',
            sourceRef: 'file:///synthetic/missing.md',
            version: null,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The source material is required.',
            blockLabel: 'task_source_note',
          },
        ],
      }),
    }, 'task-20260901-abc00001');

    expect(outcome).toMatchObject({
      status: 'context_blocked',
      issues: expect.arrayContaining([
        'missing_consumption_evidence:task-source-note',
      ]),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
    await expect(readdir(join(
      context.root,
      '.atl-runtime',
      'context-manifests',
    ))).resolves.toHaveLength(1);
  });

  it('fails closed with a blocked Manifest when the allowed context root is invalid', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [join(context.root, 'missing-root')],
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
            selectionReason: 'The current Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${currentProject.projectId}`,
            version: currentProject.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The owning Project is required.',
            blockLabel: 'project',
          },
        ],
      }),
    }, 'task-20260901-abc00001');

    expect(outcome).toMatchObject({
      status: 'context_blocked',
      issues: expect.arrayContaining([
        'missing_consumption_evidence:context-preflight-failure',
      ]),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it('persists a blocked Manifest when dynamic discovery itself fails', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      discoverContext: async () => {
        throw new Error('synthetic discovery failure');
      },
    }, 'task-20260901-abc00001');

    expect(outcome).toMatchObject({
      status: 'context_blocked',
      issues: expect.arrayContaining([
        'missing_consumption_evidence:context-preflight-failure',
      ]),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it('dispatches a ready Manifest with actual context and persists the verified execution binding', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue({
        status: 'linked',
        ref: {
          issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
          issueIdentifier: 'TEP-999',
        },
        recovered: false,
        activation: {
          assigneeId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
          runId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
          runStatus: 'in_progress',
          runAgentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
          runRuntimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          recovered: false,
          agent: {
            agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
            workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
            model: 'gpt-5.6-sol',
            maxConcurrentTasks: 10,
            runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
            status: 'idle',
          },
        },
      });

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
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
            selectionReason: 'The current Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${currentProject.projectId}`,
            version: currentProject.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The owning Project is required.',
            blockLabel: 'project',
          },
        ],
      }),
    }, 'task-20260901-abc00001');

    expect(outcome).toMatchObject({
      status: 'linked',
      taskId: 'task-20260901-abc00001',
      issueIdentifier: 'TEP-999',
      manifestId: expect.stringMatching(/^cm_[0-9a-f]{24}$/),
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      executionBindingReceiptId: expect.stringMatching(/^ebr_[0-9a-f]{24}$/),
      runId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
    });
    expect(ensureIssue).toHaveBeenCalledOnce();
    const envelope = ensureIssue.mock.calls[0]?.[0];
    expect(envelope?.description).toContain('Context Manifest');
    expect(envelope?.description).toContain('Produce decision-ready learning input.');
    expect(envelope?.description).toContain('Explain the mechanism and remaining uncertainty.');
    await expect(readdir(join(
      context.root,
      '.atl-runtime',
      'execution-bindings',
    ))).resolves.toHaveLength(1);
    await expect(context.ctx.tasks.get('task-20260901-abc00001')).resolves.toMatchObject({
      executionLink: {
        contextManifestId: expect.stringMatching(/^cm_[0-9a-f]{24}$/),
        contextManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        executionBindingReceiptId: expect.stringMatching(/^ebr_[0-9a-f]{24}$/),
        activationAssigneeId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
        activationRunId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
      },
    });
  });

  it('dispatches an explicit remote Project resource as an auditable reference block', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const remoteRef = 'https://github.com/example/synthetic-research-source';
    await context.ctx.projects.create({
      ...project(),
      resources: [{
        kind: 'github_repo',
        value: remoteRef,
        label: 'Synthetic upstream repository',
      }],
    });
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      discoverContext: async ({ task: currentTask, project: currentProject }) => (
        discoverResearchContext({ task: currentTask, project: currentProject }, {
          vaultRoot: context.root,
          allowedLocalRoots: [context.root],
        })
      ),
    }, task().taskId);

    expect(outcome).toMatchObject({ status: 'linked' });
    const envelope = ensureIssue.mock.calls[0]?.[0];
    expect(envelope?.description).toContain('### project_resource_001');
    expect(envelope?.description).toContain('Kind: github_repo');
    expect(envelope?.description).toContain(`Reference: ${remoteRef}`);
    const manifest = outcome.status === 'linked'
      ? await readContextManifestById(join(context.root, '.atl-runtime'), outcome.manifestId)
      : null;
    expect(manifest?.status).toBe('ready');
    expect(manifest?.entries).toContainEqual(expect.objectContaining({
      candidateId: 'project-resource-001',
      blockLabel: 'project_resource_001',
      status: 'consumed',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('reuses the immutable Manifest when the same dispatch is recovered later', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue({
        status: 'linked',
        ref: {
          issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
          issueIdentifier: 'TEP-999',
        },
        recovered: true,
        activation: {
          assigneeId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
          runId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
          runStatus: 'in_progress',
          runAgentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
          runRuntimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          recovered: true,
          agent: {
            agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
            workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
            model: 'gpt-5.6-sol',
            maxConcurrentTasks: 10,
            runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
            status: 'idle',
          },
        },
      });
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => ({
        additionalLocalContexts: [],
        candidates: [
          {
            candidateId: 'task-current',
            category: 'task' as const,
            sourceRef: `task://${currentTask.taskId}`,
            version: currentTask.readyAt ?? currentTask.updatedAt,
            expectedSha256: null,
            selection: 'selected' as const,
            selectionReason: 'The current Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project' as const,
            sourceRef: `atl-project://${currentProject.projectId}`,
            version: currentProject.updatedAt,
            expectedSha256: null,
            selection: 'selected' as const,
            selectionReason: 'The owning Project is required.',
            blockLabel: 'project',
          },
        ],
      }),
    };

    const first = await dispatchResearchTask(
      context.ctx,
      dependencies,
      'task-20260901-abc00001',
    );
    const replay = await dispatchResearchTask(
      context.createIndependentContext({ now: new Date('2026-09-01T05:05:00.000Z') }),
      dependencies,
      'task-20260901-abc00001',
    );

    expect(first).toMatchObject({ status: 'linked' });
    expect(replay).toMatchObject({
      status: 'linked',
      manifestId: first.status === 'linked' ? first.manifestId : '',
      manifestSha256: first.status === 'linked' ? first.manifestSha256 : '',
      executionBindingReceiptId: first.status === 'linked'
        ? first.executionBindingReceiptId
        : '',
    });
    expect(ensureIssue).toHaveBeenCalledOnce();
  });

  it('single-flights concurrent dispatches and returns the same persisted binding', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    let ensureCalls = 0;
    let releaseEnsure = () => {};
    let markEntered: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>(async () => {
      ensureCalls += 1;
      markEntered?.();
      await gate;
      return linkedResult();
    });
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => requiredDiscovery(currentTask, currentProject),
    };

    const first = dispatchResearchTask(context.ctx, dependencies, task().taskId);
    await entered;
    const second = dispatchResearchTask(
      context.createIndependentContext({ now: new Date(NOW) }),
      dependencies,
      task().taskId,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsDuringOverlap = ensureCalls;
    releaseEnsure();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(callsDuringOverlap).toBe(1);
    expect(firstOutcome).toMatchObject({ status: 'linked' });
    expect(secondOutcome).toMatchObject({
      status: 'linked',
      executionBindingReceiptId: firstOutcome.status === 'linked'
        ? firstOutcome.executionBindingReceiptId
        : '',
    });
    expect(ensureIssue).toHaveBeenCalledOnce();
  });

  it('recovers a persisted binding after local projection crashes without another remote ensure', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => requiredDiscovery(currentTask, currentProject),
    };
    const first = await dispatchResearchTask(context.ctx, dependencies, task().taskId);
    expect(first).toMatchObject({ status: 'linked' });
    const current = await context.ctx.tasks.get(task().taskId);
    await context.ctx.tasks.save({
      ...current,
      executionLink: {
        ...freshExecutionLink(task().taskId, dependencies.target),
        dispatchState: 'resolving_remote',
        lastAttemptAt: NOW,
      },
    });

    const recovered = await dispatchResearchTask(
      context.createIndependentContext({ now: new Date(NOW) }),
      dependencies,
      task().taskId,
    );

    expect(recovered).toMatchObject({
      status: 'linked',
      executionBindingReceiptId: first.status === 'linked'
        ? first.executionBindingReceiptId
        : '',
    });
    expect(ensureIssue).toHaveBeenCalledOnce();
    await expect(context.ctx.tasks.get(task().taskId)).resolves.toMatchObject({
      executionLink: {
        issueId: ISSUE_ID,
        activationRunId: RUN_ID,
        dispatchState: 'linked',
      },
    });
  });

  it('fails persisted binding recovery when a Project writer commits before the recovery locks', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => requiredDiscovery(currentTask, currentProject),
    };
    await expect(dispatchResearchTask(context.ctx, dependencies, task().taskId))
      .resolves.toMatchObject({ status: 'linked' });
    const linkedTask = await context.ctx.tasks.get(task().taskId);
    await context.ctx.tasks.save({
      ...linkedTask,
      executionLink: {
        ...freshExecutionLink(task().taskId, dependencies.target),
        dispatchState: 'resolving_remote',
        lastAttemptAt: NOW,
      },
    });

    const recoveryContext = context.createIndependentContext({ now: new Date(NOW) });
    const beforeRecoveryLock = Promise.withResolvers<void>();
    const releaseRecoveryLock = Promise.withResolvers<void>();
    const withTaskLock = recoveryContext.tasks.withTaskLock.bind(recoveryContext.tasks);
    vi.spyOn(recoveryContext.tasks, 'withTaskLock').mockImplementation(async (
      taskId,
      operation,
    ) => {
      beforeRecoveryLock.resolve();
      await releaseRecoveryLock.promise;
      return withTaskLock(taskId, operation);
    });
    const recovery = dispatchResearchTask(
      recoveryContext,
      dependencies,
      task().taskId,
    );
    await beforeRecoveryLock.promise;

    const contender = context.createIndependentContext({
      now: new Date('2026-09-01T05:01:00.000Z'),
    });
    const currentProject = await contender.projects.get(ATL_PROJECT_ID);
    await contender.projects.save({
      ...currentProject,
      description: 'Project changed before persisted binding recovery acquired its locks.',
      updatedAt: '2026-09-01T05:01:00.000Z',
    });
    releaseRecoveryLock.resolve();

    await expect(recovery).rejects.toThrow(
      'Persisted Research binding conflicts with its Context Manifest or target',
    );
    expect(ensureIssue).toHaveBeenCalledOnce();
    await expect(contender.tasks.get(task().taskId)).resolves.toMatchObject({
      executionLink: { issueId: null, dispatchState: 'resolving_remote' },
    });
  });

  it('persists a blocked Manifest and makes zero remote calls when required source context exceeds 20k', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const largeSource = join(context.root, 'large-research-source.md');
    await writeFile(largeSource, 'x'.repeat(21_000), 'utf8');
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task({ sourceNote: largeSource }));
    const sourceRef = pathToFileURL(await realpath(largeSource)).href;
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      discoverContext: async ({ task: currentTask, project: currentProject }) => {
        const required = requiredDiscovery(currentTask, currentProject);
        return {
          ...required,
          includeSourceNote: true,
          candidates: [
            ...required.candidates,
            {
              candidateId: 'task-source-note',
              category: 'source' as const,
              sourceRef,
              version: null,
              expectedSha256: null,
              selection: 'selected' as const,
              selectionReason: 'The explicit source is required.',
              blockLabel: 'task_source_note',
            },
          ],
        };
      },
    }, task().taskId);

    expect(outcome).toMatchObject({
      status: 'context_blocked',
      issues: expect.arrayContaining([
        'missing_consumption_evidence:dispatch-envelope-budget',
      ]),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it('starts a research run by excerpting relevant optional context within the 20k envelope budget', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const sourceDirectory = join(context.root, '笔记同步助手', '2026-09-01');
    const sourceNote = join(sourceDirectory, 'task-source-note.md');
    const relatedArticle = join(sourceDirectory, 'AI native lifecycle article.md');
    const unrelatedPrompt = join(sourceDirectory, 'unrelated prompt.md');
    const sourceNoteContent = 's'.repeat(2_855);
    const relatedArticleContent = `RELATED_AI_NATIVE_ARTICLE\n${'a'.repeat(16_476 - 26)}`;
    const unrelatedPromptContent = `UNRELATED_PROMPT_MATERIAL\n${'p'.repeat(5_168 - 26)}`;
    await mkdir(sourceDirectory, { recursive: true });
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task({
      title: 'Study AI native lifecycle',
      sourceDate: '2026-09-01',
      sourceNote: '笔记同步助手/2026-09-01/task-source-note.md',
    }));
    await Promise.all([
      writeFile(sourceNote, sourceNoteContent, 'utf8'),
      writeFile(relatedArticle, relatedArticleContent, 'utf8'),
      writeFile(unrelatedPrompt, unrelatedPromptContent, 'utf8'),
    ]);
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    const articleRef = pathToFileURL(await realpath(relatedArticle)).href;
    const promptRef = pathToFileURL(await realpath(unrelatedPrompt)).href;
    const articleFullSha256 = createHash('sha256')
      .update(relatedArticleContent)
      .digest('hex');

    const outcome = await dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      contextBaseRoot: context.root,
      discoverContext: async ({ task: currentTask, project: currentProject }) => (
        discoverResearchContext({ task: currentTask, project: currentProject }, {
          vaultRoot: context.root,
          allowedLocalRoots: [context.root],
        })
      ),
    }, task().taskId);

    expect(outcome).toMatchObject({ status: 'linked', runId: RUN_ID });
    expect(ensureIssue).toHaveBeenCalledOnce();
    const envelope = ensureIssue.mock.calls[0]?.[0];
    expect(envelope?.description.length).toBeLessThanOrEqual(20_000);
    expect(envelope?.description).toContain('[ATL_CONTEXT_EXCERPT]');
    expect(envelope?.description).toContain(`full_source_sha256: ${articleFullSha256}`);
    expect(envelope?.description).toContain('RELATED_AI_NATIVE_ARTICLE');
    expect(envelope?.description).not.toContain('UNRELATED_PROMPT_MATERIAL');
    const manifest = outcome.status === 'linked'
      ? await readContextManifestById(join(context.root, '.atl-runtime'), outcome.manifestId)
      : null;
    expect(manifest).not.toBeNull();
    expect(manifest?.entries).toContainEqual(expect.objectContaining({
      sourceRef: articleRef,
      status: 'consumed',
      selectionReason: expect.stringContaining(articleFullSha256),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(manifest?.entries).toContainEqual(expect.objectContaining({
      sourceRef: promptRef,
      status: 'excluded',
      reason: 'dispatch_envelope_budget',
    }));
  });

  it('creates a new attempt after blocked context is repaired and dispatches once', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    let repaired = false;
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => {
        const required = requiredDiscovery(currentTask, currentProject);
        return repaired
          ? required
          : {
              ...required,
              candidates: [
                ...required.candidates,
                {
                  candidateId: 'missing-required-source',
                  category: 'source' as const,
                  sourceRef: 'file:///synthetic/missing-required-source.md',
                  version: null,
                  expectedSha256: null,
                  selection: 'selected' as const,
                  selectionReason: 'The missing source is required.',
                  blockLabel: 'required_source',
                },
              ],
            };
      },
    };

    const blocked = await dispatchResearchTask(context.ctx, dependencies, task().taskId);
    repaired = true;
    const linked = await dispatchResearchTask(context.ctx, dependencies, task().taskId);

    expect(blocked).toMatchObject({ status: 'context_blocked' });
    expect(linked).toMatchObject({ status: 'linked' });
    expect(linked.status === 'linked' && blocked.status === 'context_blocked'
      ? linked.manifestId
      : '').not.toBe(blocked.status === 'context_blocked' ? blocked.manifestId : '');
    expect(ensureIssue).toHaveBeenCalledOnce();
    await expect(readdir(join(
      context.root,
      '.atl-runtime',
      'context-manifests',
    ))).resolves.toHaveLength(2);
  });

  it('makes zero remote calls when the Task is cancelled during context preflight', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    await expect(dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [],
      discoverContext: async ({ task: currentTask, project: currentProject }) => {
        await context.ctx.tasks.withTaskLock(currentTask.taskId, async () => {
          const latest = await context.ctx.tasks.get(currentTask.taskId);
          await context.ctx.tasks.save({
            ...latest,
            status: 'cancelled',
            updatedAt: '2026-09-01T05:00:30.000Z',
          });
        });
        return requiredDiscovery(currentTask, currentProject);
      },
    }, task().taskId)).rejects.toMatchObject({
      code: 'research_dispatch_not_admitted',
      errors: expect.arrayContaining(['status must be agent_executable']),
    });

    expect(ensureIssue).not.toHaveBeenCalled();
    await expect(context.ctx.tasks.get(task().taskId)).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it.each([
    ['title', { title: 'Changed after discovery started' }],
    ['body', { body: '\nChanged body after discovery started.\n' }],
    ['objective', { objective: 'Changed objective after discovery started.' }],
    ['acceptance criteria', {
      acceptanceCriteria: ['Changed acceptance after discovery started.'],
    }],
    ['source note', { sourceNote: 'changed-source-note.md' }],
  ] satisfies Array<[string, Partial<Task>]>)(
    'makes zero remote calls when the Task %s changes during context preflight', async (
    _field,
    changed,
  ) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    await expect(dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [],
      discoverContext: async ({ task: currentTask, project: currentProject }) => {
        await context.ctx.tasks.withTaskLock(currentTask.taskId, async () => {
          const latest = await context.ctx.tasks.get(currentTask.taskId);
          const changedTask = {
            ...latest,
            ...changed,
            updatedAt: '2026-09-01T05:00:30.000Z',
          };
          await (!('body' in changed)
            ? context.ctx.tasks.save(changedTask)
            : context.ctx.tasks.saveBody(changedTask));
        });
        return requiredDiscovery(currentTask, currentProject);
      },
    }, task().taskId)).rejects.toMatchObject({
      code: 'research_dispatch_not_admitted',
      errors: expect.arrayContaining(['Task dispatch content changed during context preflight']),
    });

    expect(ensureIssue).not.toHaveBeenCalled();
    },
  );

  it('freezes Task and Project mutation through the first remote write and binding', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureEntered = Promise.withResolvers<void>();
    const releaseEnsure = Promise.withResolvers<void>();
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockImplementation(async () => {
        ensureEntered.resolve();
        await releaseEnsure.promise;
        return linkedResult();
      });
    const dispatch = dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [],
      discoverContext: async ({ task: currentTask, project: currentProject }) => (
        requiredDiscovery(currentTask, currentProject)
      ),
    }, task().taskId);
    await ensureEntered.promise;

    const contender = context.createIndependentContext();
    let taskMutationSettled = false;
    let projectMutationSettled = false;
    const taskMutation = contender.tasks.withTaskLock(task().taskId, async () => {
      const latest = await contender.tasks.get(task().taskId);
      await contender.tasks.save({
        ...latest,
        title: 'Changed only after dispatch binding',
        updatedAt: '2026-09-01T05:01:00.000Z',
      });
    }).finally(() => {
      taskMutationSettled = true;
    });
    const projectMutation = contender.projects.withProjectLock(ATL_PROJECT_ID, async () => {
      const latest = await contender.projects.get(ATL_PROJECT_ID);
      await contender.projects.save({
        ...latest,
        description: 'Changed only after dispatch binding.',
        updatedAt: '2026-09-01T05:01:00.000Z',
      });
    }).finally(() => {
      projectMutationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(taskMutationSettled).toBe(false);
    expect(projectMutationSettled).toBe(false);

    releaseEnsure.resolve();
    await expect(dispatch).resolves.toMatchObject({ status: 'linked', runId: RUN_ID });
    await expect(Promise.all([taskMutation, projectMutation])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(ensureIssue).toHaveBeenCalledOnce();
    await expect(contender.tasks.get(task().taskId)).resolves.toMatchObject({
      title: 'Changed only after dispatch binding',
    });
    await expect(contender.projects.get(ATL_PROJECT_ID)).resolves.toMatchObject({
      description: 'Changed only after dispatch binding.',
    });
  });

  it.each([
    ['metadata save', async (contender: ServiceContext) => {
      const latest = await contender.tasks.get(task().taskId);
      await contender.tasks.save({
        ...latest,
        title: 'Task changed by a writer that acquired the lock first',
        updatedAt: '2026-09-01T05:01:00.000Z',
      });
    }],
    ['body save', async (contender: ServiceContext) => {
      const latest = await contender.tasks.get(task().taskId);
      await contender.tasks.saveBody({
        ...latest,
        body: '\nTask body changed by a writer that acquired the lock first.\n',
        updatedAt: '2026-09-01T05:01:00.000Z',
      });
    }],
  ] satisfies Array<[string, (contender: ServiceContext) => Promise<void>]>) (
    'lets a Task %s that acquired the shared lock first commit before freshness and makes zero remote writes',
    async (_kind, persistChange) => {
      const context = await createTestServiceContext({ now: new Date(NOW) });
      contexts.push(context);
      await context.ctx.projects.create(project());
      await context.ctx.tasks.createIfSourceKeyAbsent(task());
      const writerEntered = Promise.withResolvers<void>();
      const releaseWriter = Promise.withResolvers<void>();
      const contender = context.createIndependentContext();
      const mutation = contender.tasks.withTaskLock(task().taskId, async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        await persistChange(contender);
      });
      await writerEntered.promise;

      const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
        .mockResolvedValue(linkedResult());
      const dispatch = dispatchResearchTask(context.ctx, {
        connector: { ensureIssue, inspect: vi.fn() },
        target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
        runtimeRoot: join(context.root, '.atl-runtime'),
        allowedContextRoots: [],
        discoverContext: async ({ task: currentTask, project: currentProject }) => (
          requiredDiscovery(currentTask, currentProject)
        ),
      }, task().taskId).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(ensureIssue).not.toHaveBeenCalled();

      releaseWriter.resolve();
      await mutation;
      await expect(dispatch).resolves.toMatchObject({
        code: 'research_dispatch_not_admitted',
        errors: expect.arrayContaining(['Task dispatch content changed during context preflight']),
      });
      expect(ensureIssue).not.toHaveBeenCalled();
    },
  );

  it('lets a Project save that acquired the shared lock first commit before freshness and makes zero remote writes', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const contender = context.createIndependentContext();
    const mutation = contender.projects.withProjectLock(ATL_PROJECT_ID, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      const latest = await contender.projects.get(ATL_PROJECT_ID);
      await contender.projects.save({
        ...latest,
        description: 'Project changed by a writer that acquired the lock first.',
        updatedAt: '2026-09-01T05:01:00.000Z',
      });
    });
    await writerEntered.promise;

    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    const dispatch = dispatchResearchTask(context.ctx, {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [],
      discoverContext: async ({ task: currentTask, project: currentProject }) => (
        requiredDiscovery(currentTask, currentProject)
      ),
    }, task().taskId).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ensureIssue).not.toHaveBeenCalled();

    releaseWriter.resolve();
    await mutation;
    await expect(dispatch).resolves.toMatchObject({
      code: 'research_dispatch_not_admitted',
      errors: expect.arrayContaining(['Project context changed during context preflight']),
    });
    expect(ensureIssue).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'Changed after binding' }],
    ['body', { body: '\nChanged body after binding.\n' }],
    ['objective', { objective: 'Changed objective after binding.' }],
    ['acceptance criteria', { acceptanceCriteria: ['Changed acceptance after binding.'] }],
    ['source note', { sourceNote: 'changed-after-binding.md' }],
  ] satisfies Array<[string, Partial<Task>]>)(
    'does not recover the old binding after the Task %s changes', async (_field, changed) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(task());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>()
      .mockResolvedValue(linkedResult());
    const dependencies = {
      connector: { ensureIssue, inspect: vi.fn() },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [] as string[],
      discoverContext: async ({ task: currentTask, project: currentProject }: {
        task: Task;
        project: Project;
      }) => requiredDiscovery(currentTask, currentProject),
    };
    await expect(dispatchResearchTask(context.ctx, dependencies, task().taskId))
      .resolves.toMatchObject({ status: 'linked' });
    const current = await context.ctx.tasks.get(task().taskId);
    const changedTask = {
      ...current,
      ...changed,
      updatedAt: '2026-09-01T05:01:00.000Z',
    };
    await (!('body' in changed)
      ? context.ctx.tasks.save(changedTask)
      : context.ctx.tasks.saveBody(changedTask));

    await expect(dispatchResearchTask(
      context.createIndependentContext({ now: new Date('2026-09-01T05:01:00.000Z') }),
      dependencies,
      task().taskId,
    )).rejects.toMatchObject({
      code: 'research_dispatch_not_admitted',
      errors: expect.arrayContaining([
        'Task dispatch content changed after the persisted Research binding',
      ]),
    });

    expect(ensureIssue).toHaveBeenCalledOnce();
    },
  );
});
