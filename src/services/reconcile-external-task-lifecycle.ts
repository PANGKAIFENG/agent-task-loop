import { posix } from 'node:path';

import type { Task } from '../domain/task.js';
import type { ServiceContext } from './service-context.js';

type LifecycleTask = Pick<
  Task,
  'taskId' | 'status' | 'projectId' | 'sourceDate' | 'updatedAt'
>;

function expectedTaskPath(task: LifecycleTask): string {
  const filename = `${task.taskId}.md`;
  if (task.status === 'inbox') {
    return posix.join(
      '10_Tasks',
      'Inbox',
      task.sourceDate ?? 'undated',
      filename,
    );
  }
  if (task.status === 'done' || task.status === 'cancelled') {
    return posix.join('10_Tasks', 'Archive', task.updatedAt.slice(0, 4), filename);
  }
  return posix.join(
    '10_Tasks',
    'Active',
    task.projectId ?? 'unassigned',
    filename,
  );
}

export function isTaskLifecyclePathAligned(
  relativePath: string,
  task: LifecycleTask,
): boolean {
  return relativePath.replaceAll('\\', '/') === expectedTaskPath(task);
}

export async function reconcileExternalTaskLifecycle(
  ctx: ServiceContext,
  taskId: string,
  currentRelativePath: string,
): Promise<{ reconciled: boolean; taskId: string }> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const current = await ctx.tasks.get(taskId);
    if (isTaskLifecyclePathAligned(currentRelativePath, current)) {
      return { reconciled: false, taskId };
    }
    const timestamp = ctx.clock().toISOString();
    const saved = await ctx.tasks.save({ ...current, updatedAt: timestamp });
    await ctx.audit.append({
      event: 'task.lifecycle_reconciled',
      at: timestamp,
      taskId,
      details: {
        status: saved.status,
      },
    });
    return { reconciled: true, taskId };
  });
}
