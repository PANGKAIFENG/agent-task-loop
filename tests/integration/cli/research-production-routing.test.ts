import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { captureTask } from '../../../src/services/capture-task.js';
import { createProject } from '../../../src/services/create-project.js';
import {
  RESEARCH_AGENT_ID,
  RESEARCH_AGENT_MAX_CONCURRENT_TASKS,
  RESEARCH_AGENT_MODEL,
} from '../../../src/services/build-multica-dispatch-dependencies.js';
import { dispatchResearchTask } from '../../../src/services/dispatch-research-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const cli = join(process.cwd(), 'src', 'cli.ts');
const contexts: TestServiceContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('Research production CLI routing', () => {
  it('marks a complete CLI Research confirmation for Multica execution', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    await createProject(context.ctx, {
      projectId: 'project-cli-research-routing',
      name: 'CLI Research Routing',
      description: 'Synthetic project only.',
      resources: [],
    });
    const task = await captureTask(context.ctx, {
      title: 'Route one complete Research task',
      body: 'Synthetic task only.',
      origin: 'synthetic_test',
      sourceDate: '2026-09-01',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:cli-research-routing',
      priority: 'normal',
    });

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'confirm',
      '--task-id', task.taskId,
      '--project-id', 'project-cli-research-routing',
      '--objective', 'Produce a decision-ready comparison.',
      '--acceptance-criterion', 'Bind the result to cited evidence.',
      '--priority', 'normal',
      '--json',
    ], {
      cwd: process.cwd(),
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_ALLOW_REAL_WRITES: undefined,
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: task.taskId,
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
    });
  });

  it('authorizes and immediately attempts the Research Multica dispatch', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    await createProject(context.ctx, {
      projectId: 'project-cli-research-authorization',
      name: 'CLI Research Authorization',
      description: 'Synthetic project only.',
      resources: [],
    });
    const task = await captureTask(context.ctx, {
      title: 'Authorize one complete Research task',
      body: 'Synthetic task only.',
      origin: 'synthetic_test',
      sourceDate: '2026-09-01',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:cli-research-authorization',
      priority: 'normal',
    });
    await context.ctx.tasks.save({
      ...task,
      status: 'ready',
      reviewState: 'confirmed',
      projectId: 'project-cli-research-authorization',
      taskType: 'research',
      objective: 'Produce a decision-ready comparison.',
      acceptanceCriteria: ['Bind the result to cited evidence.'],
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
      readyAt: '2026-09-01T00:00:00.000Z',
    });

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'authorize-agent',
      '--task-id', task.taskId,
      '--json',
    ], {
      cwd: process.cwd(),
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_ALLOW_REAL_WRITES: undefined,
        ATL_MULTICA_BINARY: '/usr/bin/false',
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: {
        taskId: task.taskId,
        status: 'agent_executable',
        executionTarget: 'multica',
      },
      dispatch: {
        status: 'failed',
        taskId: task.taskId,
      },
    });
    expect(await readdir(join(context.root, '.atl-runtime', 'context-manifests')))
      .toHaveLength(1);
  });

  it('exposes Artifact readback through the Multica CLI surface', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = await captureTask(context.ctx, {
      title: 'Read one Research artifact',
      body: 'Synthetic task only.',
      origin: 'synthetic_test',
      sourceDate: '2026-09-01',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:cli-research-readback',
      priority: 'normal',
    });

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'multica', 'read-artifacts',
      '--task-id', task.taskId,
      '--json',
    ], {
      cwd: process.cwd(),
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_ALLOW_REAL_WRITES: undefined,
        ATL_MULTICA_BINARY: '/usr/bin/false',
      },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'research_artifact_read_invalid' },
    });
  });

  it.each([
    {
      label: 'records a completed',
      runStatus: 'completed',
      issueStatus: 'done',
      completedAt: '2026-09-01T06:00:00.000Z',
      expectedAction: 'artifact_recorded',
      expectedTaskStatus: 'review',
    },
    {
      label: 'reports a failed',
      runStatus: 'failed',
      issueStatus: 'in_progress',
      completedAt: '2026-09-01T06:00:00.000Z',
      expectedAction: 'failed',
      expectedTaskStatus: 'agent_executable',
    },
  ])('$label Research Run through the production reconcile entry', async ({
    runStatus,
    issueStatus,
    completedAt,
    expectedAction,
    expectedTaskStatus,
  }) => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const projectId = 'project-cli-research-auto-readback';
    const issueId = '01234567-89ab-4cde-8f01-234567890abc';
    const runId = 'run-cli-research-auto-readback';
    const runtimeId = '5f282aa0-e717-421d-ab84-d1f0d4aab551';
    await createProject(context.ctx, {
      projectId,
      name: 'CLI Research Auto Readback',
      description: 'Synthetic project only.',
      resources: [],
    });
    const captured = await captureTask(context.ctx, {
      title: 'Automatically read one completed Research artifact',
      body: 'Synthetic task only.',
      origin: 'synthetic_test',
      sourceDate: '2026-09-01',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:cli-research-auto-readback',
      priority: 'normal',
    });
    await context.ctx.tasks.save({
      ...captured,
      status: 'agent_executable',
      reviewState: 'confirmed',
      projectId,
      taskType: 'research',
      objective: 'Produce a decision-ready comparison.',
      acceptanceCriteria: ['Bind the result to cited evidence.'],
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
      readyAt: captured.updatedAt,
    });
    const dispatch = await dispatchResearchTask(context.ctx, {
      connector: {
        ensureIssue: async () => ({
          status: 'linked',
          ref: { issueId, issueIdentifier: 'TEP-999' },
          recovered: false,
          activation: {
            assigneeId: RESEARCH_AGENT_ID,
            runId,
            runStatus: 'in_progress',
            runAgentId: RESEARCH_AGENT_ID,
            runRuntimeId: runtimeId,
            recovered: false,
            agent: {
              agentId: RESEARCH_AGENT_ID,
              workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
              model: RESEARCH_AGENT_MODEL,
              maxConcurrentTasks: RESEARCH_AGENT_MAX_CONCURRENT_TASKS,
              runtimeId,
              status: 'idle',
            },
          },
        }),
        inspect: async () => { throw new Error('unused'); },
      },
      target: {
        workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
        projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [],
      discoverContext: async ({ task, project }) => ({
        additionalLocalContexts: [],
        candidates: [
          {
            candidateId: 'task-current',
            category: 'task',
            sourceRef: `task://${task.taskId}`,
            version: task.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The Task is required.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${project.projectId}`,
            version: project.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The Project is required.',
            blockLabel: 'project',
          },
        ],
      }),
    }, captured.taskId);
    expect(dispatch, JSON.stringify(dispatch)).toMatchObject({
      status: 'linked',
      taskId: captured.taskId,
    });
    expect((await context.ctx.tasks.get(captured.taskId)).executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId,
      activationRunId: runId,
    });

    const invocationLog = join(context.root, 'fake-multica-invocations.jsonl');
    const fakeMultica = join(context.root, 'fake-multica.mjs');
    await writeFile(fakeMultica, [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `const logPath = ${JSON.stringify(invocationLog)};`,
      'const args = process.argv.slice(2);',
      "appendFileSync(logPath, `${JSON.stringify(args)}\\n`, 'utf8');",
      "const command = args.slice(args.indexOf('issue'));",
      `const issue = ${JSON.stringify({
        id: issueId,
        identifier: 'TEP-999',
        workspace_id: '89440e05-518e-4c7e-aa80-0afa2be21196',
        project_id: 'b70aeddc-4a32-47ed-a288-571f5475634a',
        description: null,
        status: issueStatus,
        assignee_id: RESEARCH_AGENT_ID,
        assignee_type: 'agent',
      })};`,
      `const runs = ${JSON.stringify([{
        id: runId,
        issue_id: issueId,
        agent_id: RESEARCH_AGENT_ID,
        runtime_id: runtimeId,
        status: runStatus,
        result: { output: 'Synthetic decision-ready research output.' },
        created_at: '2026-09-01T05:00:00.000Z',
        started_at: '2026-09-01T05:00:00.000Z',
        completed_at: completedAt,
      }])};`,
      "if (command[0] === 'issue' && command[1] === 'get') console.log(JSON.stringify(issue));",
      "else if (command[0] === 'issue' && command[1] === 'runs') console.log(JSON.stringify(runs));",
      "else if (command[0] === 'issue' && command[1] === 'comment' && command[2] === 'list') console.log('[]');",
      "else { console.error(`unexpected fake Multica args: ${args.join(' ')}`); process.exitCode = 2; }",
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeMultica, 0o700);

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'multica', 'reconcile',
      '--json',
    ], {
      cwd: process.cwd(),
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_ALLOW_REAL_WRITES: undefined,
        ATL_MULTICA_BINARY: fakeMultica,
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcomes: [expect.objectContaining({
        taskId: captured.taskId,
        action: expectedAction,
      })],
    });
    expect((await context.ctx.tasks.get(captured.taskId)).status).toBe(expectedTaskStatus);
    const invocations = await readFile(invocationLog, 'utf8');
    expect(invocations).toContain('"runs"');
  }, 20_000);
});
