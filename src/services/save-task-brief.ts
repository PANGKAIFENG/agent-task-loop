import { z } from 'zod';

import { taskSchema, type Task } from '../domain/task.js';
import {
  TaskConflictError,
  TaskSavedIndexStaleError,
} from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface SaveTaskBriefInput {
  objective: string;
  nextAction: string;
  completionCriteria: string;
}

export class InvalidTaskBriefInputError extends Error {
  readonly code = 'invalid_task_brief_input';

  constructor() {
    super('任务目标、下一步和完成条件都需要填写');
    this.name = 'InvalidTaskBriefInputError';
  }
}

export class TaskBriefAuditFailedError extends Error {
  readonly code = 'task_brief_audit_failed';

  constructor() {
    super('Task brief audit failed');
    this.name = 'TaskBriefAuditFailedError';
  }
}

export class TaskBriefRecoveryError extends Error {
  readonly code = 'task_brief_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task brief recovery required');
    this.name = 'TaskBriefRecoveryError';
  }
}

const nonBlankBriefField = z.string().trim().min(1).max(4_000);
const saveTaskBriefInputSchema: z.ZodType<SaveTaskBriefInput> = z
  .object({
    objective: nonBlankBriefField,
    nextAction: nonBlankBriefField,
    completionCriteria: nonBlankBriefField,
  })
  .strict();

export function validateTaskBriefInput(input: SaveTaskBriefInput): SaveTaskBriefInput {
  const parsed = saveTaskBriefInputSchema.safeParse(input);
  if (!parsed.success) throw new InvalidTaskBriefInputError();
  return parsed.data;
}

export function nextTaskBriefTimestamp(now: Date, previous: string | null): string {
  const timestamp = now.toISOString();
  if (previous === null) return timestamp;
  const previousTime = Date.parse(previous);
  if (!Number.isFinite(previousTime) || now.getTime() > previousTime) return timestamp;
  return new Date(previousTime + 1).toISOString();
}

export async function saveTaskBrief(
  ctx: ServiceContext,
  taskId: string,
  input: SaveTaskBriefInput,
  expectedTaskBriefUpdatedAt: string | null,
): Promise<Task> {
  const parsed = validateTaskBriefInput(input);

  return ctx.tasks.withTaskLock(taskId, async () => {
    const original = await ctx.tasks.get(taskId);
    const currentTaskBriefUpdatedAt = original.taskBrief?.updatedAt ?? null;
    if (currentTaskBriefUpdatedAt !== expectedTaskBriefUpdatedAt) {
      throw new TaskConflictError();
    }
    const timestamp = nextTaskBriefTimestamp(
      ctx.clock(),
      currentTaskBriefUpdatedAt,
    );
    const updated = taskSchema.parse({
      ...original,
      taskBrief: {
        schemaVersion: 1,
        ...parsed,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    });

    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(updated);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) throw error;
      saved = updated;
      staleIndexError = error;
    }

    try {
      await ctx.audit.append({
        event: 'task.brief_saved',
        at: timestamp,
        taskId,
        details: { schemaVersion: 1 },
      });
    } catch {
      try {
        await ctx.tasks.save({
          ...original,
          taskBrief: original.taskBrief ?? null,
        });
      } catch (error) {
        if (error instanceof TaskSavedIndexStaleError) {
          throw new TaskBriefAuditFailedError();
        }
        throw new TaskBriefRecoveryError();
      }
      throw new TaskBriefAuditFailedError();
    }

    if (staleIndexError !== null) throw staleIndexError;
    return saved;
  });
}
