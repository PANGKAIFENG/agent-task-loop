import {
  priorityRank,
  type Task,
  type TaskStatus,
} from '../domain/task.js';
import { isClaimEligible } from './claim-task.js';
import type { ServiceContext } from './service-context.js';

export async function listTasks(
  ctx: ServiceContext,
  status?: TaskStatus,
): Promise<Task[]> {
  const tasks = await ctx.tasks.list();
  return status === undefined
    ? tasks
    : tasks.filter((task) => task.status === status);
}

function readyTimestamp(task: Task): number {
  const timestamp = Date.parse(task.readyAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export async function peekNextTask(ctx: ServiceContext): Promise<Task | null> {
  return (await ctx.tasks.list())
    .filter(isClaimEligible)
    .sort((left, right) => (
      priorityRank[left.priority] - priorityRank[right.priority]
      || readyTimestamp(left) - readyTimestamp(right)
      || left.taskId.localeCompare(right.taskId)
    ))[0] ?? null;
}
