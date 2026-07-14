import { priorityRank, type Task } from '../domain/task.js';
import {
  ClaimTaskNotEligibleError,
  automaticClaimLockKey,
  claimTaskWithoutQuotaCheck,
  isClaimEligible,
  localBusinessDate,
  resolveClaimTaskOptions,
  type ClaimMode,
} from './claim-task.js';
import type { ServiceContext } from './service-context.js';

export interface ClaimNextTaskOptions {
  agent: string;
  runId: string;
  mode: ClaimMode;
  dailyLimit: number;
  leaseMinutes: number;
}

function readyTimestamp(task: Task): number {
  const timestamp = Date.parse(task.readyAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export async function claimNextTask(
  ctx: ServiceContext,
  rawOptions: ClaimNextTaskOptions,
): Promise<Task | null> {
  const options = resolveClaimTaskOptions(rawOptions);
  const now = ctx.clock();

  const claimFirstEligible = async (): Promise<Task | null> => {
    const tasks = (await ctx.tasks.list())
      .filter(isClaimEligible)
      .sort((left, right) => (
        priorityRank[left.priority] - priorityRank[right.priority]
        || readyTimestamp(left) - readyTimestamp(right)
        || left.taskId.localeCompare(right.taskId)
      ));
    for (const task of tasks) {
      try {
        return await claimTaskWithoutQuotaCheck(ctx, task.taskId, options, now);
      } catch (error) {
        if (!(error instanceof ClaimTaskNotEligibleError)) {
          throw error;
        }
      }
    }
    return null;
  };

  if (options.mode === 'manual') {
    return claimFirstEligible();
  }

  const localDate = localBusinessDate(now);
  return ctx.tasks.withTaskLock(automaticClaimLockKey(localDate), async () => {
    const claimedToday = await ctx.audit.count({
      event: 'task.claimed',
      localDate,
      mode: 'automatic',
    });
    if (claimedToday >= options.dailyLimit) {
      return null;
    }
    return claimFirstEligible();
  });
}
