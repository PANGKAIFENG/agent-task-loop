import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { assertTransition } from '../../../src/domain/transitions.js';
import { captureTask } from '../../../src/services/capture-task.js';
import {
  confirmTask,
  type ConfirmTaskInput,
} from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { TaskSavedIndexStaleError } from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext();
  contexts.push(context);
  return context;
}

function confirmInput(
  overrides: Partial<Required<ConfirmTaskInput>> = {},
): Required<ConfirmTaskInput> {
  return {
    projectId: 'project-public-research',
    taskType: 'research',
    objective: 'Compare public pricing and cite the evidence.',
    acceptanceCriteria: ['Cite at least two official public sources.'],
    permissionProfile: 'read_only_research',
    priority: 'high',
    autoExecutable: true,
    ...overrides,
  };
}

async function captureSyntheticTask(context: TestServiceContext) {
  return captureTask(context.ctx, {
    title: 'Review public product pricing',
    body: 'Sensitive synthetic task body.',
    origin: 'synthetic_test',
    sourceDate: '2026-07-14',
    sourceNote: '/synthetic/private-source.md',
    sourceQuote: 'Sensitive synthetic source quote.',
    sourceKey: 'synthetic:confirm-source-1',
    priority: 'normal',
  });
}

async function createSyntheticProject(
  context: TestServiceContext,
  projectId = 'project-public-research',
) {
  return createProject(context.ctx, {
    projectId,
    name: 'Public research',
    description: 'Synthetic project fixture.',
    resources: [{
      kind: 'url',
      value: 'https://example.com/public',
      label: 'Public example',
    }],
  });
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('confirmTask', () => {
  it('moves a lightweight manual task to Ready without execution metadata', async () => {
    const context = await makeContext();
    const task = await captureSyntheticTask(context);

    const confirmed = await confirmTask(context.ctx, task.taskId, {
      priority: 'normal',
      autoExecutable: false,
    });

    expect(confirmed).toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      projectId: null,
      taskType: null,
      objective: null,
      acceptanceCriteria: [],
      permissionProfile: null,
      autoExecutable: false,
    });
  });

  it('still requires complete readiness when automatic execution is requested', async () => {
    const context = await makeContext();
    const task = await captureSyntheticTask(context);

    await expect(confirmTask(context.ctx, task.taskId, {
      priority: 'normal',
      autoExecutable: true,
    })).rejects.toThrow('Task is not ready: projectId is required');
  });

  it('rejects confirmation when projectId is missing', async () => {
    const context = await makeContext();
    const task = await captureSyntheticTask(context);
    const incompleteInput = {
      ...confirmInput(),
      projectId: undefined,
    } as unknown as ConfirmTaskInput;

    await expect(
      confirmTask(context.ctx, task.taskId, incompleteInput),
    ).rejects.toThrow('Task is not ready: projectId is required');
  });

  it.each([[[]], [[' ', '\t']]])(
    'rejects confirmation when acceptance criteria are missing or blank',
    async (acceptanceCriteria) => {
      const context = await makeContext();
      await createSyntheticProject(context);
      const task = await captureSyntheticTask(context);
      const incompleteInput = confirmInput({ acceptanceCriteria });

      await expect(
        confirmTask(context.ctx, task.taskId, incompleteInput),
      ).rejects.toThrow(
        'Task is not ready: acceptanceCriteria requires at least one item',
      );
    },
  );

  it('rejects confirmation when permissionProfile is missing', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const task = await captureSyntheticTask(context);
    const incompleteInput = { ...confirmInput() } as Partial<ConfirmTaskInput>;
    delete incompleteInput.permissionProfile;

    await expect(confirmTask(
      context.ctx,
      task.taskId,
      incompleteInput as ConfirmTaskInput,
    )).rejects.toThrow(
      'Task is not ready: permissionProfile must be read_only_research',
    );

    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toHaveLength(1);
  });

  it('confirms a complete task without enabling automatic execution', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const task = await captureSyntheticTask(context);

    const confirmed = await confirmTask(
      context.ctx,
      task.taskId,
      confirmInput({ autoExecutable: false }),
    );

    expect(confirmed).toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      autoExecutable: false,
    });
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toHaveLength(2);
  });

  it('rejects an unknown project with a sanitized error', async () => {
    const context = await makeContext();
    const task = await captureSyntheticTask(context);
    const unknownProjectId = 'private-unknown-project';

    const error = await confirmTask(
      context.ctx,
      task.taskId,
      confirmInput({ projectId: unknownProjectId }),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'confirm_task_project_not_found',
      message: 'Task project not found',
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(unknownProjectId);
    expect((error as Error).message).not.toContain(task.body);
    expect((error as Error).message).not.toContain(task.sourceQuote ?? '');
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toHaveLength(1);
  });

  it('confirms a complete Inbox task and moves it to the project Active directory', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const captured = await captureSyntheticTask(context);
    const candidate = await context.ctx.tasks.save({
      ...captured,
      reviewState: 'ready_for_confirm',
      projectId: 'old-project-draft',
      taskType: 'research',
      objective: 'Old draft objective.',
      acceptanceCriteria: ['Old draft criterion.'],
      autoExecutable: false,
      permissionProfile: 'read_only_research',
      priority: 'low',
      possibleDuplicateIds: ['task-20260714-duplicate'],
      artifactRefs: ['10_Tasks/Artifacts/synthetic-existing.md'],
      reviewFeedback: 'Old review feedback.',
    });
    const input = confirmInput({
      objective: 'Sensitive confirmed objective.',
      acceptanceCriteria: ['Sensitive confirmed criterion.'],
      priority: 'urgent',
    });
    const inboxPath = join(
      context.root,
      '10_Tasks',
      'Inbox',
      '2026-07-14',
      `${candidate.taskId}.md`,
    );
    const activePath = join(
      context.root,
      '10_Tasks',
      'Active',
      input.projectId,
      `${candidate.taskId}.md`,
    );

    const confirmed = await confirmTask(context.ctx, candidate.taskId, input);

    expect(confirmed).toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      readyAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      projectId: input.projectId,
      taskType: 'research',
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      permissionProfile: 'read_only_research',
      priority: 'urgent',
      autoExecutable: true,
      reviewFeedback: null,
    });
    expect(confirmed).toMatchObject({
      title: candidate.title,
      body: candidate.body,
      origin: candidate.origin,
      sourceDate: candidate.sourceDate,
      sourceNote: candidate.sourceNote,
      sourceQuote: candidate.sourceQuote,
      sourceKey: candidate.sourceKey,
      possibleDuplicateIds: candidate.possibleDuplicateIds,
      artifactRefs: candidate.artifactRefs,
      attempts: candidate.attempts,
      claim: candidate.claim,
      createdAt: candidate.createdAt,
    });
    expect((await stat(activePath)).isFile()).toBe(true);
    await expect(stat(inboxPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(activePath, 'utf8')).toContain('Sensitive synthetic task body.');

    const confirmedEvents = (await context.ctx.audit.listForTask(candidate.taskId))
      .filter(({ event }) => event === 'task.confirmed');
    expect(confirmedEvents).toEqual([{
      event: 'task.confirmed',
      at: '2026-07-14T00:00:00.000Z',
      taskId: candidate.taskId,
      details: {
        projectId: input.projectId,
        priority: input.priority,
      },
    }]);
    const serializedAudit = JSON.stringify(confirmedEvents);
    expect(serializedAudit).not.toContain(input.objective);
    expect(serializedAudit).not.toContain(input.acceptanceCriteria[0]);
    expect(serializedAudit).not.toContain(candidate.body);
    expect(serializedAudit).not.toContain(candidate.sourceNote ?? '');
    expect(serializedAudit).not.toContain(candidate.sourceQuote ?? '');
  });

  it('audits a committed confirmation before reporting a stale task index', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const task = await captureSyntheticTask(context);
    const saveTask = context.ctx.tasks.save.bind(context.ctx.tasks);
    let readySaveFailed = false;
    context.ctx.tasks.save = async (submitted) => {
      const saved = await saveTask(submitted);
      if (submitted.status === 'ready' && !readySaveFailed) {
        readySaveFailed = true;
        throw new TaskSavedIndexStaleError();
      }
      return saved;
    };
    const input = confirmInput({
      objective: 'Sensitive stale-index objective.',
      acceptanceCriteria: ['Sensitive stale-index criterion.'],
    });
    const inboxPath = join(
      context.root,
      '10_Tasks',
      'Inbox',
      '2026-07-14',
      `${task.taskId}.md`,
    );
    const activePath = join(
      context.root,
      '10_Tasks',
      'Active',
      input.projectId,
      `${task.taskId}.md`,
    );

    const error = await confirmTask(
      context.ctx,
      task.taskId,
      input,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaskSavedIndexStaleError);
    expect(error).toMatchObject({
      code: 'task_saved_index_stale',
      message: 'Task saved but task index is stale',
    });
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      projectId: input.projectId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      autoExecutable: true,
    });
    expect((await stat(activePath)).isFile()).toBe(true);
    await expect(stat(inboxPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const confirmedEvents = (await context.ctx.audit.listForTask(task.taskId))
      .filter(({ event }) => event === 'task.confirmed');
    expect(confirmedEvents).toEqual([{
      event: 'task.confirmed',
      at: '2026-07-14T00:00:00.000Z',
      taskId: task.taskId,
      details: {
        projectId: input.projectId,
        priority: input.priority,
      },
    }]);
    const serializedAudit = JSON.stringify(confirmedEvents);
    expect(serializedAudit).not.toContain(input.objective);
    expect(serializedAudit).not.toContain(input.acceptanceCriteria[0]);
    expect(serializedAudit).not.toContain(task.body);
    expect(serializedAudit).not.toContain(task.sourceNote ?? '');
    expect(serializedAudit).not.toContain(task.sourceQuote ?? '');
  });

  it('restores the exact Inbox task when the confirmation audit fails', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const captured = await captureSyntheticTask(context);
    const original = await context.ctx.tasks.save({
      ...captured,
      reviewState: 'ready_for_confirm',
      objective: 'Unconfirmed draft objective.',
      acceptanceCriteria: ['Unconfirmed draft criterion.'],
      reviewFeedback: 'Preserve this old review feedback.',
      possibleDuplicateIds: ['task-20260714-existing-duplicate'],
      artifactRefs: ['10_Tasks/Artifacts/existing-result.md'],
    });
    const appendAudit = context.ctx.audit.append.bind(context.ctx.audit);
    context.ctx.audit.append = async (event) => {
      if (event.event === 'task.confirmed') {
        throw new Error('private synthetic audit failure');
      }
      await appendAudit(event);
    };
    const input = confirmInput();
    const inboxPath = join(
      context.root,
      '10_Tasks',
      'Inbox',
      '2026-07-14',
      `${original.taskId}.md`,
    );
    const activePath = join(
      context.root,
      '10_Tasks',
      'Active',
      input.projectId,
      `${original.taskId}.md`,
    );

    const error = await confirmTask(
      context.ctx,
      original.taskId,
      input,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'task_confirmation_audit_failed',
      message: 'Task confirmation audit failed',
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private synthetic');
    expect((error as Error).message).not.toContain(original.body);
    await expect(context.ctx.tasks.get(original.taskId)).resolves.toEqual(original);
    expect((await stat(inboxPath)).isFile()).toBe(true);
    await expect(stat(activePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await context.ctx.audit.listForTask(original.taskId))
      .filter(({ event }) => event === 'task.confirmed')).toEqual([]);
  });

  it('reports typed partial state when audit rollback also fails', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const original = await captureSyntheticTask(context);
    const saveTask = context.ctx.tasks.save.bind(context.ctx.tasks);
    let saveCalls = 0;
    context.ctx.tasks.save = async (task) => {
      saveCalls += 1;
      if (saveCalls === 2) {
        throw new Error('private synthetic rollback failure');
      }
      return saveTask(task);
    };
    context.ctx.audit.append = async (event) => {
      if (event.event === 'task.confirmed') {
        throw new Error('private synthetic audit failure');
      }
    };
    const input = confirmInput();
    const inboxPath = join(
      context.root,
      '10_Tasks',
      'Inbox',
      '2026-07-14',
      `${original.taskId}.md`,
    );
    const activePath = join(
      context.root,
      '10_Tasks',
      'Active',
      input.projectId,
      `${original.taskId}.md`,
    );

    const error = await confirmTask(
      context.ctx,
      original.taskId,
      input,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'task_confirmation_recovery_error',
      message: 'Task confirmation recovery required',
      partialCommit: true,
      recoveryRequired: true,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private synthetic');
    expect((error as Error).message).not.toContain(original.body);
    await expect(context.ctx.tasks.get(original.taskId)).resolves.toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      autoExecutable: true,
      readyAt: '2026-07-14T00:00:00.000Z',
    });
    expect((await stat(activePath)).isFile()).toBe(true);
    await expect(stat(inboxPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await context.ctx.audit.listForTask(original.taskId))
      .filter(({ event }) => event === 'task.confirmed')).toEqual([]);
  });

  it('rejects confirmation when the persisted task is no longer in Inbox', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const captured = await captureSyntheticTask(context);
    const inProgress = await context.ctx.tasks.save({
      ...captured,
      status: 'in_progress',
      reviewState: 'confirmed',
      projectId: 'project-public-research',
      taskType: 'research',
      objective: 'Existing execution objective.',
      acceptanceCriteria: ['Existing execution criterion.'],
      permissionProfile: 'read_only_research',
      autoExecutable: true,
    });

    await expect(confirmTask(
      context.ctx,
      inProgress.taskId,
      confirmInput(),
    )).rejects.toThrow('Task must be in Inbox to confirm');

    await expect(context.ctx.tasks.get(inProgress.taskId)).resolves.toEqual(inProgress);
    expect((await context.ctx.audit.listForTask(inProgress.taskId))
      .filter(({ event }) => event === 'task.confirmed')).toEqual([]);
  });

  it('rejects a direct Inbox-to-In-Progress transition and service shortcut', async () => {
    const context = await makeContext();
    const task = await captureSyntheticTask(context);

    expect(() => assertTransition(task.status, 'in_progress')).toThrow(
      'Invalid task transition: inbox -> in_progress',
    );
    const shortcutInput = {
      ...confirmInput(),
      status: 'in_progress',
    } as ConfirmTaskInput;
    await expect(confirmTask(
      context.ctx,
      task.taskId,
      shortcutInput,
    )).rejects.toMatchObject({
      code: 'invalid_confirm_task_input',
      message: 'Invalid confirm task input',
    });

    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    expect((await context.ctx.audit.listForTask(task.taskId))
      .filter(({ event }) => event === 'task.confirmed')).toEqual([]);
  });

  it('does not confirm without a user-supplied priority', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const task = await captureSyntheticTask(context);
    const incompleteInput = { ...confirmInput() } as Partial<ConfirmTaskInput>;
    delete incompleteInput.priority;

    await expect(confirmTask(
      context.ctx,
      task.taskId,
      incompleteInput as ConfirmTaskInput,
    )).rejects.toMatchObject({
      code: 'invalid_confirm_task_input',
      message: 'Invalid confirm task input',
    });

    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
  });

  it('serializes concurrent confirmation through the confirmation audit', async () => {
    const context = await makeContext();
    const second = context.createIndependentContext();
    await createSyntheticProject(context, 'project-public-research');
    await createSyntheticProject(context, 'project-market-research');
    const task = await captureSyntheticTask(context);
    const auditEntered = Promise.withResolvers<void>();
    const releaseAudit = Promise.withResolvers<void>();
    const appendAudit = context.ctx.audit.append.bind(context.ctx.audit);
    context.ctx.audit.append = async (event) => {
      if (event.event === 'task.confirmed') {
        auditEntered.resolve();
        await releaseAudit.promise;
      }
      await appendAudit(event);
    };

    const firstConfirmation = confirmTask(
      context.ctx,
      task.taskId,
      confirmInput({ projectId: 'project-public-research' }),
    );
    await auditEntered.promise;
    const secondConfirmation = confirmTask(
      second,
      task.taskId,
      confirmInput({ projectId: 'project-market-research' }),
    );
    const secondSettledWhileAuditPaused = await Promise.race([
      secondConfirmation.then(() => true, () => true),
      delay(100, false),
    ]);
    releaseAudit.resolve();
    const results = await Promise.allSettled([
      firstConfirmation,
      secondConfirmation,
    ]);

    expect(secondSettledWhileAuditPaused).toBe(false);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'task_confirmation_invalid_state',
        message: 'Task must be in Inbox to confirm',
      },
    });
    const activeFiles = (await readdir(
      join(context.root, '10_Tasks', 'Active'),
      { recursive: true },
    )).filter((path) => path.endsWith(`${task.taskId}.md`));
    expect(activeFiles).toEqual([
      join('project-public-research', `${task.taskId}.md`),
    ]);
    expect((await context.ctx.audit.listForTask(task.taskId))
      .filter(({ event }) => event === 'task.confirmed')).toHaveLength(1);
  });
});
