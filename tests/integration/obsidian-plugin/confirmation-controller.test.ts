import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfirmationController } from '../../../src/obsidian-plugin/confirmation-controller.js';
import { createObsidianServiceContext } from '../../../src/obsidian-plugin/service-context.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';
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

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

async function captureCandidate(context: TestServiceContext, sourceKey: string) {
  return captureTask(context.ctx, {
    title: '调研公开产品能力',
    body: '只使用公开资料完成调研。',
    origin: 'synthetic_test',
    sourceDate: '2026-07-16',
    sourceNote: null,
    sourceQuote: null,
    sourceKey,
    priority: 'normal',
  });
}

function controllerFor(context: TestServiceContext): ConfirmationController {
  const authorization = createVaultWriteAuthorization(context.root);
  return new ConfirmationController(createObsidianServiceContext(
    context.root,
    authorization,
    { clock: () => new Date('2026-07-16T12:00:00.000Z') },
  ));
}

describe('ConfirmationController', () => {
  it('moves a task to Ready without choosing a project', async () => {
    const context = await makeContext();
    const task = await captureCandidate(context, 'synthetic:obsidian-lightweight');
    const controller = controllerFor(context);

    const confirmed = await controller.confirm(task.taskId, {
      project: { mode: 'none' },
      objective: '',
      acceptanceCriteria: [],
      priority: 'normal',
      autoExecutable: false,
    });

    expect(confirmed).toMatchObject({
      status: 'ready',
      projectId: null,
      objective: null,
      acceptanceCriteria: [],
      autoExecutable: false,
    });
    await expect(stat(join(
      context.root,
      '10_Tasks/Active/unassigned',
      `${task.taskId}.md`,
    ))).resolves.toMatchObject({});
  });

  it('loads an Inbox task and confirms it with an existing project', async () => {
    const context = await makeContext();
    const task = await captureCandidate(context, 'synthetic:obsidian-existing');
    await createProject(context.ctx, {
      projectId: 'product-research',
      name: '产品调研',
      description: '公开资料调研',
      resources: [],
    });
    const controller = controllerFor(context);

    const prepared = await controller.prepare(task.taskId);
    const confirmed = await controller.confirm(task.taskId, {
      project: { mode: 'existing', projectId: 'product-research' },
      objective: '梳理产品定位与核心能力',
      acceptanceCriteria: ['引用至少一个官方来源'],
      priority: 'high',
      autoExecutable: true,
    });

    expect(prepared.task.taskId).toBe(task.taskId);
    expect(prepared.projects.map(({ projectId }) => projectId)).toEqual([
      'product-research',
    ]);
    expect(confirmed).toMatchObject({
      status: 'ready',
      projectId: 'product-research',
      objective: '梳理产品定位与核心能力',
    });
    await expect(stat(join(
      context.root,
      '10_Tasks/Active/product-research',
      `${task.taskId}.md`,
    ))).resolves.toMatchObject({});
    await expect(context.ctx.audit.count({
      event: 'task.confirmed',
      localDate: '2026-07-16',
    })).resolves.toBe(1);
  });

  it('creates a new project before confirming the task', async () => {
    const context = await makeContext();
    const task = await captureCandidate(context, 'synthetic:obsidian-new');
    const controller = controllerFor(context);

    const confirmed = await controller.confirm(task.taskId, {
      project: {
        mode: 'new',
        name: 'AI 产品雷达',
        description: '每日产品情报调研',
      },
      objective: '输出今日产品变化',
      acceptanceCriteria: ['每条变化包含官方链接'],
      priority: 'urgent',
      autoExecutable: false,
    });

    expect(confirmed).toMatchObject({
      projectId: 'ai-产品雷达',
      status: 'ready',
      autoExecutable: false,
    });
    await expect(controller.prepare(task.taskId)).rejects.toThrow(
      'Task must be in Inbox to confirm',
    );
    expect(await readFile(join(
      context.root,
      '10_Tasks/Projects/ai-产品雷达.md',
    ), 'utf8')).toContain('name: AI 产品雷达');
  });
});
