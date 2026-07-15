import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { RunnerBusyError, type RunnerController } from '../../../src/runner/runner-controller.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { confirmTask } from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { createApp } from '../../../src/server/app.js';
import { findBoardStaticRoot, startServer } from '../../../src/server/start.js';
import {
  TaskConflictError,
  TaskIntegrityError,
} from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const BOARD_ORIGIN = 'http://127.0.0.1:4173';
const BOARD_TOKEN = 'synthetic-board-token';
const contexts: TestServiceContext[] = [];

function runner(overrides: Partial<RunnerController> = {}): RunnerController {
  return {
    runAndWait: vi.fn(),
    start: vi.fn().mockResolvedValue({ runId: 'run-board-001' }),
    ...overrides,
  };
}

async function setup(options: { runner?: RunnerController; token?: string } = {}) {
  const context = await createTestServiceContext({
    ids: [
      'task-20260714-board0001',
      'task-20260714-board0002',
      'task-20260714-board0003',
      'task-20260714-board0004',
      'task-20260714-board0005',
    ],
  });
  contexts.push(context);
  const controller = options.runner ?? runner();
  const app = await createApp({
    ctx: context.ctx,
    runner: controller,
    boardOrigin: BOARD_ORIGIN,
    environment: options.token === undefined
      ? { ATL_BOARD_TOKEN: BOARD_TOKEN }
      : { ATL_BOARD_TOKEN: options.token },
  });
  return { app, context, runner: controller };
}

function writeHeaders(overrides: Record<string, string> = {}) {
  return {
    origin: BOARD_ORIGIN,
    'x-atl-token': BOARD_TOKEN,
    ...overrides,
  };
}

async function createReadyTask(context: TestServiceContext) {
  await createProject(context.ctx, {
    projectId: 'project-public-research',
    name: 'Public research',
    description: 'Synthetic project fixture.',
    resources: [{
      kind: 'url',
      value: 'https://example.com/public',
      label: 'Public example',
    }],
  });
  const captured = await captureTask(context.ctx, {
    title: 'Review public pricing',
    body: 'Private synthetic task body.',
    origin: 'synthetic_test',
    sourceDate: '2026-07-14',
    sourceNote: '/synthetic/private-source.md',
    sourceQuote: 'Public pricing changed this quarter.',
    sourceKey: 'synthetic:board-ready',
    priority: 'normal',
  });
  return confirmTask(context.ctx, captured.taskId, {
    projectId: 'project-public-research',
    taskType: 'research',
    objective: 'Compare public pricing.',
    acceptanceCriteria: ['Use official public evidence.'],
    permissionProfile: 'read_only_research',
    priority: 'high',
    autoExecutable: true,
  });
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('local task board routes', () => {
  it('lists inbox, review, projects, and project tasks using sanitized DTOs', async () => {
    const { app, context } = await setup();
    const inbox = await captureTask(context.ctx, {
      title: 'Inbox task',
      body: 'Private body must not cross the API.',
      origin: 'synthetic_test',
      sourceDate: '2026-07-14',
      sourceNote: '/synthetic/private-note.md',
      sourceQuote: 'Only this excerpt is needed.',
      sourceKey: 'synthetic:board-inbox',
      priority: 'normal',
    });
    const ready = await createReadyTask(context);
    const review = await context.ctx.tasks.save({
      ...ready,
      status: 'review',
      claim: null,
      artifactRefs: [],
    });

    const inboxResponse = await app.inject({ method: 'GET', url: '/api/inbox' });
    const reviewResponse = await app.inject({ method: 'GET', url: '/api/review' });
    const projectsResponse = await app.inject({ method: 'GET', url: '/api/projects' });
    const projectTasksResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/project-public-research/tasks',
    });

    expect(inboxResponse.statusCode).toBe(200);
    expect(inboxResponse.json()).toEqual({
      tasks: [expect.objectContaining({
        taskId: inbox.taskId,
        title: 'Inbox task',
        status: 'inbox',
        sourceExcerpt: 'Only this excerpt is needed.',
        artifactSummaries: [],
      })],
    });
    const inboxDto = inboxResponse.json<{ tasks: Array<Record<string, unknown>> }>().tasks[0];
    expect(inboxDto).not.toHaveProperty('body');
    expect(inboxDto).not.toHaveProperty('sourceNote');
    expect(inboxDto).not.toHaveProperty('sourceKey');
    expect(inboxDto).not.toHaveProperty('artifactRefs');
    expect(JSON.stringify(inboxDto)).not.toContain('/synthetic/');
    expect(reviewResponse.json()).toEqual({
      tasks: [expect.objectContaining({ taskId: review.taskId, status: 'review' })],
    });
    expect(projectsResponse.json()).toEqual({
      projects: [expect.objectContaining({
        projectId: 'project-public-research',
        resources: [{
          kind: 'url',
          value: 'https://example.com/public',
          label: 'Public example',
        }],
      })],
    });
    expect(projectTasksResponse.json()).toEqual({
      tasks: [expect.objectContaining({ taskId: review.taskId })],
    });
    await app.close();
  });

  it('exposes only the per-app token and same-origin API base in runtime config', async () => {
    const first = await setup();
    const second = await setup();
    const generatedFirst = await createApp({
      ctx: first.context.ctx,
      runner: runner(),
      boardOrigin: BOARD_ORIGIN,
      environment: { PRIVATE_VALUE: 'must-not-leak' },
    });
    const generatedSecond = await createApp({
      ctx: second.context.ctx,
      runner: runner(),
      boardOrigin: BOARD_ORIGIN,
      environment: { PRIVATE_VALUE: 'must-not-leak' },
    });

    const configured = await first.app.inject({ method: 'GET', url: '/runtime-config.js' });
    const randomOne = await generatedFirst.inject({ method: 'GET', url: '/runtime-config.js' });
    const randomTwo = await generatedSecond.inject({ method: 'GET', url: '/runtime-config.js' });

    expect(configured.statusCode).toBe(200);
    expect(configured.headers['content-type']).toContain('application/javascript');
    expect(configured.body).toBe(
      `globalThis.ATL_RUNTIME_CONFIG=${JSON.stringify({ token: BOARD_TOKEN, apiBase: BOARD_ORIGIN })};\n`,
    );
    expect(configured.body).not.toContain('PRIVATE_VALUE');
    expect(randomOne.body).not.toBe(randomTwo.body);
    expect(randomOne.body).not.toContain('must-not-leak');
    expect(randomTwo.body).not.toContain('must-not-leak');
    await Promise.all([
      first.app.close(),
      second.app.close(),
      generatedFirst.close(),
      generatedSecond.close(),
    ]);
  });

  it('serves the SPA shell on direct board routes without swallowing other 404s', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const staticRoot = join(context.root, 'build', 'ui');
    const shell = '<main>synthetic board shell</main>';
    await mkdir(join(staticRoot, 'assets'), { recursive: true });
    await writeFile(join(staticRoot, 'index.html'), shell);
    await writeFile(join(staticRoot, 'assets', 'board.js'), 'export {};');
    const app = await createApp({
      ctx: context.ctx,
      runner: runner(),
      boardOrigin: BOARD_ORIGIN,
      environment: { ATL_BOARD_TOKEN: BOARD_TOKEN },
      staticRoot,
    });

    for (const url of ['/inbox', '/review', '/projects', '/projects/project-alpha']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toBe(shell);
    }

    const missingApi = await app.inject({ method: 'GET', url: '/api/not-real' });
    const runtimeConfig = await app.inject({ method: 'GET', url: '/runtime-config.js' });
    const missingAsset = await app.inject({ method: 'GET', url: '/assets/not-real.js' });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.body).not.toBe(shell);
    expect(runtimeConfig.statusCode).toBe(200);
    expect(runtimeConfig.headers['content-type']).toContain('application/javascript');
    expect(runtimeConfig.body).not.toBe(shell);
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.body).not.toBe(shell);
    await app.close();
  });

  it('rejects every write without the exact token or exact board origin', async () => {
    const { app } = await setup();
    const writes = [
      { url: '/api/tasks', payload: { title: 'Task', sourceKey: 'board:auth' } },
      { url: '/api/tasks/task-auth/confirm', payload: {} },
      { url: '/api/tasks/task-auth/run', payload: {} },
      { url: '/api/tasks/task-auth/review', payload: {} },
      { url: '/api/tasks/task-auth/stop', payload: {} },
      { url: '/api/tasks/task-auth/unblock', payload: {} },
      { url: '/api/tasks/task-auth/reopen', payload: {} },
    ];

    for (const write of writes) {
      const missingToken = await app.inject({
        method: 'POST',
        url: write.url,
        headers: { origin: BOARD_ORIGIN },
        payload: write.payload,
      });
      const wrongToken = await app.inject({
        method: 'POST',
        url: write.url,
        headers: writeHeaders({ 'x-atl-token': `${BOARD_TOKEN}-wrong` }),
        payload: write.payload,
      });
      const missingOrigin = await app.inject({
        method: 'POST',
        url: write.url,
        headers: { 'x-atl-token': BOARD_TOKEN },
        payload: write.payload,
      });
      const wrongOrigin = await app.inject({
        method: 'POST',
        url: write.url,
        headers: writeHeaders({ origin: 'http://localhost:4173' }),
        payload: write.payload,
      });

      expect(missingToken.statusCode).toBe(401);
      expect(wrongToken.statusCode).toBe(401);
      expect(missingOrigin.statusCode).toBe(403);
      expect(wrongOrigin.statusCode).toBe(403);
    }
    await app.close();
  });

  it('creates only an Inbox task with automatic execution disabled', async () => {
    const { app } = await setup();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: writeHeaders(),
      payload: { title: 'Missing source key' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: writeHeaders(),
      payload: {
        title: 'Board-created task',
        sourceKey: 'board:client-generated-001',
        body: 'Synthetic board details.',
        sourceExcerpt: 'Synthetic excerpt.',
        priority: 'high',
      },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      code: 'invalid_capture_task_input',
      message: 'Invalid capture task input',
      details: null,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(expect.objectContaining({
      status: 'inbox',
      reviewState: 'candidate',
      autoExecutable: false,
      sourceExcerpt: 'Synthetic excerpt.',
    }));
    await app.close();
  });

  it('returns stable client errors for malformed JSON and non-object review bodies', async () => {
    const { app } = await setup();
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: {
        ...writeHeaders(),
        'content-type': 'application/json',
      },
      payload: '{"title":',
    });
    const reviewBodies = ['"invalid"', 'null'];

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      code: 'invalid_request_body',
      message: 'Invalid request body',
      details: null,
    });
    for (const payload of reviewBodies) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/tasks/task-review-input/review',
        headers: {
          ...writeHeaders(),
          'content-type': 'application/json',
        },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: 'invalid_review_task_input',
        message: 'Invalid task review input',
        details: null,
      });
    }
    await app.close();
  });

  it('hides internal repository errors on reads and writes', async () => {
    const { app, context } = await setup();
    const internalError = new TaskIntegrityError();
    vi.spyOn(context.ctx.tasks, 'list').mockRejectedValueOnce(internalError);
    const read = await app.inject({ method: 'GET', url: '/api/inbox' });
    vi.spyOn(context.ctx.tasks, 'findBySourceKey').mockRejectedValueOnce(internalError);
    const create = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: writeHeaders(),
      payload: { title: 'Internal failure', sourceKey: 'board:internal-failure' },
    });
    vi.spyOn(context.ctx.tasks, 'get').mockRejectedValueOnce(internalError);
    const run = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-internal-failure/run',
      headers: writeHeaders(),
      payload: {},
    });

    for (const response of [read, create, run]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
        details: null,
      });
      expect(response.body).not.toContain(internalError.code);
      expect(response.body).not.toContain(internalError.message);
    }
    await app.close();
  });

  it('maps a task write conflict to a stable 409 response', async () => {
    const { app, context } = await setup();
    const conflict = new TaskConflictError();
    vi.spyOn(context.ctx.tasks, 'findBySourceKey').mockRejectedValueOnce(conflict);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: writeHeaders(),
      payload: { title: 'Conflicting task', sourceKey: 'board:conflict' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'task_conflict',
      message: 'Task conflict',
      details: null,
    });
    expect(response.body).not.toContain(conflict.message);
    await app.close();
  });

  it('routes confirm, stop, unblock, reopen, and review through domain services', async () => {
    const { app, context } = await setup();
    const ready = await createReadyTask(context);
    const stoppedInput: Task = {
      ...ready,
      status: 'in_progress',
      attempts: 1,
      claim: {
        runId: 'run-stop-001',
        agent: 'synthetic-agent',
        claimedAt: '2026-07-14T00:00:00.000Z',
        leaseExpiresAt: '2026-07-14T01:00:00.000Z',
      },
    };
    await context.ctx.tasks.save(stoppedInput);
    const stopped = await app.inject({
      method: 'POST',
      url: `/api/tasks/${ready.taskId}/stop`,
      headers: writeHeaders(),
      payload: {},
    });
    const stoppedTask = await context.ctx.tasks.get(ready.taskId);
    const blockedInput = await context.ctx.tasks.save({
      ...stoppedTask,
      status: 'blocked',
      reviewFeedback: 'Synthetic block.',
    });
    const unblocked = await app.inject({
      method: 'POST',
      url: `/api/tasks/${blockedInput.taskId}/unblock`,
      headers: writeHeaders(),
      payload: { recoveryNote: 'Recovered safely.' },
    });
    const unblockedTask = await context.ctx.tasks.get(ready.taskId);
    const doneInput = await context.ctx.tasks.save({
      ...unblockedTask,
      status: 'done',
    });
    const reopened = await app.inject({
      method: 'POST',
      url: `/api/tasks/${doneInput.taskId}/reopen`,
      headers: writeHeaders(),
      payload: { reason: 'New evidence appeared.' },
    });
    const invalidReview = await app.inject({
      method: 'POST',
      url: `/api/tasks/${doneInput.taskId}/review`,
      headers: writeHeaders(),
      payload: { decision: 'approve' },
    });
    const captured = await captureTask(context.ctx, {
      title: 'Confirm from board',
      body: 'Synthetic task.',
      origin: 'synthetic_test',
      sourceDate: null,
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:board-confirm',
      priority: 'normal',
    });
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${captured.taskId}/confirm`,
      headers: writeHeaders(),
      payload: {
        projectId: 'project-public-research',
        taskType: 'research',
        objective: 'Confirm through the shared service.',
        acceptanceCriteria: ['Use the shared service.'],
        permissionProfile: 'read_only_research',
        priority: 'normal',
        autoExecutable: true,
      },
    });

    expect(stopped.json()).toEqual(expect.objectContaining({ status: 'ready', claim: null }));
    expect(unblocked.json()).toEqual(expect.objectContaining({
      status: 'ready',
      reviewFeedback: 'Recovered safely.',
    }));
    expect(reopened.json()).toEqual(expect.objectContaining({
      status: 'ready',
      reviewFeedback: 'New evidence appeared.',
    }));
    expect(invalidReview.statusCode).toBe(400);
    expect(invalidReview.json()).toEqual({
      code: 'task_review_invalid_state',
      message: 'Task must be in Review',
      details: null,
    });
    expect(confirmed.json()).toEqual(expect.objectContaining({
      status: 'ready',
      reviewState: 'confirmed',
    }));
    await app.close();
  });

  it('starts a named Ready task asynchronously and maps runner contention to 409', async () => {
    const start = vi.fn().mockResolvedValue({ runId: 'run-board-001' });
    const first = await setup({ runner: runner({ start }) });
    const ready = await createReadyTask(first.context);
    const accepted = await first.app.inject({
      method: 'POST',
      url: `/api/tasks/${ready.taskId}/run`,
      headers: writeHeaders(),
      payload: {},
    });
    const invalid = await first.app.inject({
      method: 'POST',
      url: '/api/tasks/missing-task/run',
      headers: writeHeaders(),
      payload: {},
    });
    const busy = await setup({
      runner: runner({ start: vi.fn().mockRejectedValue(new RunnerBusyError()) }),
    });
    const busyReady = await createReadyTask(busy.context);
    const conflicted = await busy.app.inject({
      method: 'POST',
      url: `/api/tasks/${busyReady.taskId}/run`,
      headers: writeHeaders(),
      payload: {},
    });

    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ taskId: ready.taskId, runId: 'run-board-001' });
    expect(start).toHaveBeenCalledWith({ taskId: ready.taskId, mode: 'manual' });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toEqual({
      code: 'task_not_found',
      message: 'Task not found',
      details: null,
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({
      code: 'runner_busy',
      message: 'Runner is busy',
      details: null,
    });
    await Promise.all([first.app.close(), busy.app.close()]);
  });

  it('rejects attempts to bind the board server to a non-loopback host', async () => {
    const { app } = await setup();

    await expect(startServer(app, { host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      code: 'invalid_board_host',
      message: 'Board server host must be 127.0.0.1',
    });
    await app.close();
  });

  it('discovers the planned Vite board output under build/ui', async () => {
    const { context, app } = await setup();
    const staticRoot = join(context.root, 'build', 'ui');
    await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, 'index.html'), '<main>synthetic board</main>');

    await expect(findBoardStaticRoot(context.root)).resolves.toBe(staticRoot);
    await app.close();
  });
});
