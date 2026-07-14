import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertTransition } from '../../../src/domain/transitions.js';
import { captureTask } from '../../../src/services/capture-task.js';
import {
  confirmTask,
  type ConfirmTaskInput,
} from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
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
  overrides: Partial<ConfirmTaskInput> = {},
): ConfirmTaskInput {
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

async function createSyntheticProject(context: TestServiceContext) {
  return createProject(context.ctx, {
    projectId: 'project-public-research',
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

  it('rejects confirmation when autoExecutable is false', async () => {
    const context = await makeContext();
    await createSyntheticProject(context);
    const task = await captureSyntheticTask(context);

    await expect(confirmTask(
      context.ctx,
      task.taskId,
      confirmInput({ autoExecutable: false }),
    )).rejects.toThrow(
      'Task is not ready: autoExecutable must be explicitly enabled',
    );

    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toHaveLength(1);
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
});
