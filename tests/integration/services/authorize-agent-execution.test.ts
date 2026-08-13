import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  AgentAuthorizationAuditFailedError,
  AgentAuthorizationInvalidStateError,
  AgentAuthorizationNotReadyError,
  AgentAuthorizationRecoveryError,
  authorizeAgentExecution,
} from '../../../src/services/authorize-agent-execution.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { confirmTask } from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { TaskSavedIndexStaleError } from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

async function makeReadyTask(context: TestServiceContext): Promise<Task> {
  await createProject(context.ctx, {
    projectId: 'synthetic-research',
    name: 'Synthetic Research',
    description: 'Synthetic authorization fixture.',
    resources: [],
  });
  const captured = await captureTask(context.ctx, {
    title: 'Authorize synthetic research',
    body: 'Synthetic body.',
    origin: 'synthetic_test',
    sourceDate: '2026-07-14',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:authorize-agent',
    priority: 'high',
  });
  return confirmTask(context.ctx, captured.taskId, {
    projectId: 'synthetic-research',
    taskType: 'research',
    objective: 'Compare public evidence.',
    acceptanceCriteria: ['Cite official evidence.'],
    permissionProfile: 'read_only_research',
    priority: 'high',
  });
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('authorizeAgentExecution', () => {
  it('moves a confirmed Ready task to Agent Executable and records authorization', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    expect(ready).toMatchObject({ status: 'ready', autoExecutable: false });

    const authorized = await authorizeAgentExecution(context.ctx, ready.taskId);

    expect(authorized).toMatchObject({
      taskId: ready.taskId,
      status: 'agent_executable',
      reviewState: 'confirmed',
      autoExecutable: true,
    });
    await expect(context.ctx.audit.listForTask(ready.taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'task.agent_authorized',
          taskId: ready.taskId,
          details: { fromStatus: 'ready', toStatus: 'agent_executable' },
        }),
      ]),
    );
  });

  it.each(['inbox', 'agent_executable', 'in_progress', 'review'])(
    'rejects %s without changing the task',
    async (status) => {
      const context = await createTestServiceContext();
      contexts.push(context);
      const ready = await makeReadyTask(context);
      const candidate = await context.ctx.tasks.save({ ...ready, status });

      await expect(authorizeAgentExecution(context.ctx, candidate.taskId))
        .rejects.toBeInstanceOf(AgentAuthorizationInvalidStateError);
      await expect(context.ctx.tasks.get(candidate.taskId)).resolves
        .toMatchObject({ status });
    },
  );

  it('rejects a Ready task whose execution context is incomplete', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    const incomplete = await context.ctx.tasks.save({
      ...ready,
      reviewState: 'candidate',
      projectId: null,
      objective: null,
      acceptanceCriteria: [],
      permissionProfile: null,
    });

    await expect(authorizeAgentExecution(context.ctx, incomplete.taskId))
      .rejects.toMatchObject({
        name: 'AgentAuthorizationNotReadyError',
        code: 'task_agent_authorization_not_ready',
        errors: expect.arrayContaining([
          'reviewState must be confirmed',
          'projectId is required',
          'objective is required',
          'acceptanceCriteria requires at least one item',
          'permissionProfile must be read_only_research',
        ]),
      });
    await expect(context.ctx.tasks.get(incomplete.taskId)).resolves.toMatchObject({
      status: 'ready',
      reviewState: 'candidate',
    });
    expect(AgentAuthorizationNotReadyError).toBeDefined();
  });

  it('audits a committed authorization before reporting a stale task index', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    const save = context.ctx.tasks.save.bind(context.ctx.tasks);
    context.ctx.tasks.save = async (task) => {
      const saved = await save(task);
      if (task.status === 'agent_executable') throw new TaskSavedIndexStaleError();
      return saved;
    };

    await expect(authorizeAgentExecution(context.ctx, ready.taskId))
      .rejects.toBeInstanceOf(TaskSavedIndexStaleError);
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toMatchObject({
      status: 'agent_executable',
      autoExecutable: true,
    });
    await expect(context.ctx.audit.listForTask(ready.taskId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'task.agent_authorized' })]),
    );
  });

  it('rolls back the exact Ready task when authorization audit fails', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    vi.spyOn(context.ctx.audit, 'append').mockRejectedValueOnce(new Error('synthetic audit failure'));

    await expect(authorizeAgentExecution(context.ctx, ready.taskId))
      .rejects.toBeInstanceOf(AgentAuthorizationAuditFailedError);
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toEqual(ready);
  });

  it('reports audit failure when authorization rollback only leaves a stale index', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    const save = context.ctx.tasks.save.bind(context.ctx.tasks);
    context.ctx.tasks.save = async (task) => {
      const saved = await save(task);
      if (task.status === 'ready') throw new TaskSavedIndexStaleError();
      return saved;
    };
    vi.spyOn(context.ctx.audit, 'append').mockRejectedValueOnce(
      new Error('synthetic audit failure'),
    );

    await expect(authorizeAgentExecution(context.ctx, ready.taskId))
      .rejects.toBeInstanceOf(AgentAuthorizationAuditFailedError);
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toEqual(ready);
  });

  it('reports a partial commit when authorization rollback also fails', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReadyTask(context);
    const save = context.ctx.tasks.save.bind(context.ctx.tasks);
    let saveCount = 0;
    context.ctx.tasks.save = async (task) => {
      saveCount += 1;
      if (saveCount === 2) throw new Error('synthetic rollback failure');
      return save(task);
    };
    vi.spyOn(context.ctx.audit, 'append').mockRejectedValueOnce(
      new Error('synthetic audit failure'),
    );

    await expect(authorizeAgentExecution(context.ctx, ready.taskId))
      .rejects.toMatchObject({
        name: 'AgentAuthorizationRecoveryError',
        code: 'task_agent_authorization_recovery_error',
        partialCommit: true,
        recoveryRequired: true,
      });
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toMatchObject({
      status: 'agent_executable',
      autoExecutable: true,
    });
    expect(AgentAuthorizationRecoveryError).toBeDefined();
  });
});
