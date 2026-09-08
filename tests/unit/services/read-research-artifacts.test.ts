import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MulticaResearchConnector } from '../../../src/connectors/multica-cli-connector.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { dispatchResearchTask } from '../../../src/services/dispatch-research-task.js';
import {
  readResearchArtifacts,
  readResearchArtifactsIfCompleted,
} from '../../../src/services/read-research-artifacts.js';
import { FileArtifactProductionEvidenceRepository } from '../../../src/storage/file-artifact-production-evidence-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T05:00:00.000Z';
const TASK_ID = 'task-20260901-artifact01';
const PROJECT_ID = 'project-research-artifact';
const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const MULTICA_PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01a03d19-bd5f-7263-a069-6f0cfde75b8e';
const AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const RUN_ID = '01a057ce-1767-7c10-a6c8-8c966cc66ea7';
const RUNTIME_ID = '5f282aa0-e717-421d-ab84-d1f0d4aab551';
const contexts: TestServiceContext[] = [];

function project(): Project {
  return {
    projectId: PROJECT_ID,
    name: 'Synthetic artifact project',
    description: 'Synthetic project context only.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Study a synthetic workflow artifact',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
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
    sourceKey: 'synthetic:research-artifact',
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

async function dispatchBoundTask(context: TestServiceContext) {
  await context.ctx.projects.create(project());
  await context.ctx.tasks.createIfSourceKeyAbsent(task());
  const runtimeRoot = join(context.root, '.atl-runtime');
  const ensureIssue = vi.fn().mockResolvedValue({
    status: 'linked',
    ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-999' },
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
  });
  await dispatchResearchTask(context.ctx, {
    connector: { ensureIssue, inspect: vi.fn() },
    target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
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
  return { runtimeRoot, ensureIssue };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('readResearchArtifacts', () => {
  it('rejects an execution binding transplanted into another Vault before remote reads', async () => {
    const source = await createTestServiceContext({ now: new Date(NOW) });
    const target = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(source, target);
    const { runtimeRoot: sourceRuntimeRoot, ensureIssue } = await dispatchBoundTask(source);
    const sourceTask = await source.ctx.tasks.get(TASK_ID);
    await target.ctx.projects.create(project());
    await target.ctx.tasks.createIfSourceKeyAbsent({
      ...task(),
      executionLink: sourceTask.executionLink,
    });
    const targetRuntimeRoot = join(target.root, '.atl-runtime');
    const bindingFiles = await readdir(join(sourceRuntimeRoot, 'execution-bindings'));
    expect(bindingFiles).toHaveLength(1);
    const bindingFile = bindingFiles[0]!;
    const targetBindingPath = join(targetRuntimeRoot, 'execution-bindings', bindingFile);
    await mkdir(dirname(targetBindingPath), { recursive: true });
    await cp(
      join(sourceRuntimeRoot, 'execution-bindings', bindingFile),
      targetBindingPath,
    );
    const runs = vi.fn();
    const listComments = vi.fn();

    await expect(readResearchArtifacts(target.ctx, {
      connector: {
        ensureIssue,
        inspect: vi.fn(),
        runs,
        listComments,
      },
      runtimeRoot: targetRuntimeRoot,
    }, TASK_ID)).rejects.toThrow('freshness');
    expect(runs).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
    await expect(readdir(join(targetRuntimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['readyAt', (current: Task) => ({ ...current, readyAt: '2026-09-01T05:01:00.000Z' })],
    ['title', (current: Task) => ({ ...current, title: `${current.title} changed` })],
    ['body', (current: Task) => ({ ...current, body: '\nChanged source body.\n' })],
    ['objective', (current: Task) => ({ ...current, objective: 'Changed objective.' })],
    ['acceptance', (current: Task) => ({
      ...current,
      acceptanceCriteria: ['Changed acceptance.'],
    })],
    ['sourceNote', (current: Task) => ({ ...current, sourceNote: 'changed-source.md' })],
  ])('fails closed before remote Artifact reads when Task %s drifts', async (_field, mutate) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const current = await context.ctx.tasks.get(TASK_ID);
    const changed = mutate(current);
    if (_field === 'body') await context.ctx.tasks.saveBody(changed);
    else await context.ctx.tasks.save(changed);
    const runs = vi.fn();
    const listComments = vi.fn();

    await expect(readResearchArtifacts(context.ctx, {
      connector: {
        ensureIssue,
        inspect: vi.fn(),
        runs: runs.mockResolvedValue([]),
        listComments,
      },
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('freshness');
    expect(runs).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
  });

  it.each([
    ['description', (current: Project) => ({
      ...current,
      description: `${current.description} changed`,
    })],
    ['resources', (current: Project) => ({
      ...current,
      resources: [{
        kind: 'url' as const,
        value: 'https://example.invalid/changed',
        label: 'Changed resource',
      }],
    })],
  ])('fails closed before remote Artifact reads when Project %s drifts', async (_field, mutate) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    await context.ctx.projects.save(mutate(await context.ctx.projects.get(PROJECT_ID)));
    const runs = vi.fn();
    const listComments = vi.fn();

    await expect(readResearchArtifacts(context.ctx, {
      connector: {
        ensureIssue,
        inspect: vi.fn(),
        runs: runs.mockResolvedValue([]),
        listComments,
      },
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('freshness');
    expect(runs).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
  });

  it('binds only the completed verified Run output to one immutable receipt', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);

    const listComments = vi.fn().mockResolvedValue({
      comments: [{
        commentId: 'comment-artifact-1',
        parentCommentId: null,
        body: `[ATL_ARTIFACT_RUN:${RUN_ID}]\nResearch artifact attached.`,
        createdAt: '2026-09-01T06:00:00.000Z',
        authorType: 'agent',
        attachments: [{
          attachmentId: 'attachment-artifact-1',
          commentId: 'comment-artifact-1',
          issueId: ISSUE_ID,
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          filename: 'synthetic-report.html',
          contentType: 'text/html; charset=utf-8',
          sizeBytes: 2048,
          downloadUrl: '/api/attachments/attachment-artifact-1/download',
          markdownUrl: 'https://multica.example/api/attachments/attachment-artifact-1/download',
          url: 'https://static.multica.example/workspaces/synthetic-report.html',
          uploaderId: AGENT_ID,
          uploaderType: 'agent',
        }],
      }],
    });
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: 'completed',
        output: 'Synthetic decision-ready research output.',
        createdAt: NOW,
        startedAt: NOW,
        completedAt: '2026-09-01T06:00:00.000Z',
      }]),
      listComments,
    };

    const result = await readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID);

    expect(result).toMatchObject({
      status: 'recorded',
      taskId: TASK_ID,
      receiptId: expect.stringMatching(/^rar_[0-9a-f]{24}$/),
      sourceCount: 2,
    });
    expect(listComments).toHaveBeenCalledWith(ISSUE_ID, { full: true });
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).resolves.toHaveLength(1);
    const reloaded = await context.ctx.tasks.get(TASK_ID);
    expect(reloaded.status).toBe('review');
    expect(reloaded.executionLink?.remoteArtifactReceiptIds).toEqual([result.receiptId]);
    expect(reloaded.executionLink?.artifactRefs).toContain(`remote-artifact://${result.receiptId}`);
    expect(reloaded.artifactRefs).toEqual([`remote-artifact://${result.receiptId}`]);
    await expect(new FileArtifactProductionEvidenceRepository(context.root, runtimeRoot)
      .readProductionEvidence(`remote-artifact://${result.receiptId}`)).resolves.toMatchObject({
      identity: {
        taskId: TASK_ID,
        ref: `remote-artifact://${result.receiptId}`,
        version: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      runId: RUN_ID,
      executionBindingReceiptId: reloaded.executionLink?.executionBindingReceiptId,
      manifestId: reloaded.executionLink?.contextManifestId,
      manifestSha256: reloaded.executionLink?.contextManifestSha256,
      issueId: ISSUE_ID,
    });
  });

  it('repairs the Task projection to review when an immutable receipt already exists', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: 'completed',
        output: 'Synthetic decision-ready research output.',
        createdAt: NOW,
        startedAt: NOW,
        completedAt: '2026-09-01T06:00:00.000Z',
      }]),
      listComments: vi.fn().mockResolvedValue({ comments: [] }),
    };

    const first = await readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID);
    expect(first.created).toBe(true);

    // Simulate a crash after the create-only receipt was persisted but before
    // the Task projection was durably advanced.
    const projected = await context.ctx.tasks.get(TASK_ID);
    await context.ctx.tasks.save({
      ...projected,
      status: 'agent_executable',
      artifactRefs: [],
      executionLink: {
        ...projected.executionLink!,
        artifactRefs: [],
        remoteArtifactReceiptIds: [],
      },
    });

    const recovered = await readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID);

    expect(recovered).toMatchObject({
      status: 'recorded',
      receiptId: first.receiptId,
      created: false,
    });
    const reloaded = await context.ctx.tasks.get(TASK_ID);
    expect(reloaded.status).toBe('review');
    expect(reloaded.artifactRefs).toEqual([`remote-artifact://${first.receiptId}`]);
    expect(reloaded.executionLink?.remoteArtifactReceiptIds).toEqual([first.receiptId]);
  });

  it('records no Artifact when the Task drifts while the remote Run is being read', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const runsEntered = Promise.withResolvers<void>();
    const releaseRuns = Promise.withResolvers<void>();
    const read = readResearchArtifacts(context.ctx, {
      connector: {
        ensureIssue,
        inspect: vi.fn(),
        runs: vi.fn().mockImplementation(async () => {
          runsEntered.resolve();
          await releaseRuns.promise;
          return [{
            runId: RUN_ID,
            issueId: ISSUE_ID,
            agentId: AGENT_ID,
            runtimeId: RUNTIME_ID,
            status: 'completed',
            output: 'Output from the now-stale Task context.',
            createdAt: NOW,
            startedAt: NOW,
            completedAt: '2026-09-01T06:00:00.000Z',
          }];
        }),
        listComments: vi.fn().mockResolvedValue({ comments: [] }),
      },
      runtimeRoot,
    }, TASK_ID);
    await runsEntered.promise;

    const contender = context.createIndependentContext();
    const current = await contender.tasks.get(TASK_ID);
    await contender.tasks.save({
      ...current,
      title: 'Task changed during remote Artifact readback',
      updatedAt: '2026-09-01T05:01:00.000Z',
    });
    releaseRuns.resolve();

    await expect(read).rejects.toThrow('freshness');
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const reloaded = await contender.tasks.get(TASK_ID);
    expect(reloaded.artifactRefs).toEqual([]);
    expect(reloaded.executionLink?.remoteArtifactReceiptIds ?? []).toEqual([]);
  });

  it('records no Artifact when the Project drifts while remote comments are being read', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const commentsEntered = Promise.withResolvers<void>();
    const releaseComments = Promise.withResolvers<void>();
    const read = readResearchArtifacts(context.ctx, {
      connector: {
        ensureIssue,
        inspect: vi.fn(),
        runs: vi.fn().mockResolvedValue([{
          runId: RUN_ID,
          issueId: ISSUE_ID,
          agentId: AGENT_ID,
          runtimeId: RUNTIME_ID,
          status: 'completed',
          output: 'Output from the now-stale Project context.',
          createdAt: NOW,
          startedAt: NOW,
          completedAt: '2026-09-01T06:00:00.000Z',
        }]),
        listComments: vi.fn().mockImplementation(async () => {
          commentsEntered.resolve();
          await releaseComments.promise;
          return { comments: [] };
        }),
      },
      runtimeRoot,
    }, TASK_ID);
    await commentsEntered.promise;

    const contender = context.createIndependentContext();
    const current = await contender.projects.get(PROJECT_ID);
    await contender.projects.save({
      ...current,
      description: 'Project changed during remote Artifact readback.',
      updatedAt: '2026-09-01T05:01:00.000Z',
    });
    releaseComments.resolve();

    await expect(read).rejects.toThrow('freshness');
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const reloaded = await contender.tasks.get(TASK_ID);
    expect(reloaded.artifactRefs).toEqual([]);
    expect(reloaded.executionLink?.remoteArtifactReceiptIds ?? []).toEqual([]);
  });

  it('does not freeze a receipt from partial output while the bound Run is active', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const listComments = vi.fn();
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: 'in_progress',
        output: 'Partial output that can still change.',
        createdAt: NOW,
        startedAt: NOW,
        completedAt: null,
      }]),
      listComments,
    };

    await expect(readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('not completed');
    expect(listComments).not.toHaveBeenCalled();
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['queued', 'running', 'in_progress'])(
    'returns pending within the reconciliation deadline while the bound Run is %s',
    async (status) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const runs = vi.fn().mockResolvedValue([{
      runId: RUN_ID,
      issueId: ISSUE_ID,
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      status,
      output: null,
      createdAt: NOW,
      startedAt: NOW,
      completedAt: null,
    }]);
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs,
      listComments: vi.fn(),
    };
    const deadlineAt = Date.parse('2026-09-01T05:01:30.000Z');

    await expect(readResearchArtifactsIfCompleted(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID, { deadlineAt })).resolves.toEqual({
      status: 'pending',
      taskId: TASK_ID,
    });
    expect(runs).toHaveBeenCalledWith(ISSUE_ID, { deadlineAt });
    },
  );

  it.each([
    { status: 'failed', completedAt: '2026-09-01T06:00:00.000Z' },
    { status: 'cancelled', completedAt: '2026-09-01T06:00:00.000Z' },
    { status: 'unexpected_future_status', completedAt: null },
    { status: 'completed', completedAt: null },
  ])('fails closed instead of leaving a $status Run pending', async ({ status, completedAt }) => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const listComments = vi.fn();
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status,
        output: null,
        createdAt: NOW,
        startedAt: NOW,
        completedAt,
      }]),
      listComments,
    };

    await expect(readResearchArtifactsIfCompleted(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID)).rejects.toMatchObject({
      code: 'research_artifact_read_invalid',
      reason: 'invalid',
    });
    expect(listComments).not.toHaveBeenCalled();
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects an attachment-only Artifact when only an agent-authored marker claims the Run', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: 'completed',
        output: null,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: '2026-09-01T06:00:00.000Z',
      }]),
      listComments: vi.fn().mockResolvedValue({ comments: [{
        commentId: 'comment-attachment-only',
        parentCommentId: null,
        body: `[ATL_ARTIFACT_RUN:${RUN_ID}]`,
        createdAt: '2026-09-01T06:00:00.000Z',
        authorType: 'agent',
        attachments: [{
          attachmentId: 'attachment-only',
          commentId: 'comment-attachment-only',
          issueId: ISSUE_ID,
          workspaceId: WORKSPACE_ID,
          runId: null,
          filename: 'report.html',
          contentType: 'text/html',
          sizeBytes: 1024,
          downloadUrl: '/api/attachments/attachment-only/download',
          markdownUrl: null,
          url: null,
          uploaderId: AGENT_ID,
          uploaderType: 'agent',
        }],
      }] }),
    };

    await expect(readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('no readable Artifact');
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed when a Run-marked attachment has another uploader identity', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: RUNTIME_ID,
        status: 'completed',
        output: null,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: '2026-09-01T06:00:00.000Z',
      }]),
      listComments: vi.fn().mockResolvedValue({ comments: [{
        commentId: 'comment-wrong-uploader',
        parentCommentId: null,
        body: `[ATL_ARTIFACT_RUN:${RUN_ID}]`,
        createdAt: '2026-09-01T06:00:00.000Z',
        authorType: 'agent',
        attachments: [{
          attachmentId: 'attachment-wrong-uploader',
          commentId: 'comment-wrong-uploader',
          issueId: ISSUE_ID,
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          filename: 'report.html',
          contentType: 'text/html',
          sizeBytes: 1024,
          downloadUrl: '/api/attachments/attachment-wrong-uploader/download',
          markdownUrl: null,
          url: null,
          uploaderId: 'another-agent',
          uploaderType: 'agent',
        }],
      }] }),
    };

    await expect(readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('attachment conflicts');
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed before comments are read when the bound Run runtime drifts', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    const { runtimeRoot, ensureIssue } = await dispatchBoundTask(context);
    const listComments = vi.fn();
    const connector: MulticaResearchConnector = {
      ensureIssue,
      inspect: vi.fn(),
      runs: vi.fn().mockResolvedValue([{
        runId: RUN_ID,
        issueId: ISSUE_ID,
        agentId: AGENT_ID,
        runtimeId: 'different-runtime',
        status: 'completed',
        output: 'Untrusted output.',
        createdAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
      }]),
      listComments,
    };

    await expect(readResearchArtifacts(context.ctx, {
      connector,
      runtimeRoot,
    }, TASK_ID)).rejects.toThrow('Run identity conflicts');
    expect(listComments).not.toHaveBeenCalled();
    await expect(readdir(join(runtimeRoot, 'remote-artifacts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
