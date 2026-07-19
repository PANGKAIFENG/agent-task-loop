import {
  access,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureTask } from '../../../src/services/capture-task.js';
import {
  isTaskLifecyclePathAligned,
  reconcileExternalTaskLifecycle,
} from '../../../src/services/reconcile-external-task-lifecycle.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

async function fixture(): Promise<{
  context: TestServiceContext;
  taskId: string;
  inboxPath: string;
}> {
  const context = await createTestServiceContext({
    now: new Date('2026-07-19T08:00:00.000Z'),
  });
  contexts.push(context);
  const task = await captureTask(context.ctx, {
    title: '整理 Obsidian 任务看板',
    body: '保留这段人工任务说明。',
    origin: 'obsidian_sync',
    sourceDate: '2026-07-19',
    sourceNote: '笔记同步助手/2026-07-19/同步助手.md',
    sourceQuote: '#待办 整理任务看板',
    sourceKey: 'obsidian_sync:lifecycle-test',
    priority: 'normal',
  });
  return {
    context,
    taskId: task.taskId,
    inboxPath: `10_Tasks/Inbox/2026-07-19/${task.taskId}.md`,
  };
}

async function replaceStatus(
  root: string,
  relativePath: string,
  from: string,
  to: string,
): Promise<void> {
  const path = join(root, relativePath);
  const content = await readFile(path, 'utf8');
  await writeFile(path, content.replace(`status: ${from}`, `status: ${to}`));
}

describe('reconcileExternalTaskLifecycle', () => {
  it('moves an Inbox task to Active/unassigned after TaskNotes changes status', async () => {
    const { context, taskId, inboxPath } = await fixture();
    await replaceStatus(context.root, inboxPath, 'inbox', 'ready');

    const result = await reconcileExternalTaskLifecycle(
      context.ctx,
      taskId,
      inboxPath,
    );

    const activePath = `10_Tasks/Active/unassigned/${taskId}.md`;
    expect(result).toEqual({ reconciled: true, taskId });
    await expect(access(join(context.root, inboxPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(context.root, activePath), 'utf8'))
      .toContain('保留这段人工任务说明。');
  });

  it('moves an Active task to the current-year Archive after status becomes done', async () => {
    const { context, taskId, inboxPath } = await fixture();
    await replaceStatus(context.root, inboxPath, 'inbox', 'ready');
    await reconcileExternalTaskLifecycle(context.ctx, taskId, inboxPath);
    const activePath = `10_Tasks/Active/unassigned/${taskId}.md`;
    await replaceStatus(context.root, activePath, 'ready', 'done');

    await reconcileExternalTaskLifecycle(context.ctx, taskId, activePath);

    await expect(access(join(context.root, activePath))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(
      join(context.root, `10_Tasks/Archive/2026/${taskId}.md`),
      'utf8',
    )).toContain('status: done');
  });

  it('does not rewrite a task whose custom or active status already matches its path', async () => {
    const { context, taskId, inboxPath } = await fixture();
    await replaceStatus(context.root, inboxPath, 'inbox', 'ready');
    await reconcileExternalTaskLifecycle(context.ctx, taskId, inboxPath);
    const activePath = `10_Tasks/Active/unassigned/${taskId}.md`;
    await replaceStatus(context.root, activePath, 'ready', 'waiting_for_user');
    const before = await readFile(join(context.root, activePath), 'utf8');

    const result = await reconcileExternalTaskLifecycle(
      context.ctx,
      taskId,
      activePath,
    );

    expect(result).toEqual({ reconciled: false, taskId });
    expect(await readFile(join(context.root, activePath), 'utf8')).toBe(before);
    expect(isTaskLifecyclePathAligned(activePath, {
      taskId,
      status: 'waiting_for_user',
      projectId: null,
      sourceDate: '2026-07-19',
      updatedAt: '2026-07-19T08:00:00.000Z',
    })).toBe(true);
  });
});
