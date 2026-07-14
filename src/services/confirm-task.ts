import { z } from 'zod';

import {
  PRIORITIES,
  readinessErrors,
  type Priority,
  type Task,
} from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { ProjectNotFoundError } from '../storage/markdown-project-repository.js';
import type { ServiceContext } from './service-context.js';

export interface ConfirmTaskInput {
  projectId: string;
  taskType: 'research';
  objective: string;
  acceptanceCriteria: string[];
  permissionProfile: 'read_only_research';
  priority: Priority;
  autoExecutable: boolean;
}

export class InvalidConfirmTaskInputError extends Error {
  readonly code = 'invalid_confirm_task_input';

  constructor() {
    super('Invalid confirm task input');
    this.name = 'InvalidConfirmTaskInputError';
  }
}

export class ConfirmTaskProjectNotFoundError extends Error {
  readonly code = 'confirm_task_project_not_found';

  constructor() {
    super('Task project not found');
    this.name = 'ConfirmTaskProjectNotFoundError';
  }
}

const confirmTaskInputSchema = z
  .object({
    projectId: z.string().max(200).optional(),
    taskType: z.literal('research').optional(),
    objective: z.string().max(4_000).optional(),
    acceptanceCriteria: z.array(z.string().max(2_000)).max(50).optional(),
    permissionProfile: z.literal('read_only_research').optional(),
    priority: z.enum(PRIORITIES),
    autoExecutable: z.boolean().optional(),
  })
  .strict();

export async function confirmTask(
  ctx: ServiceContext,
  taskId: string,
  input: ConfirmTaskInput,
): Promise<Task> {
  const parsed = confirmTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidConfirmTaskInputError();
  }

  const task = await ctx.tasks.get(taskId);
  if (task.status !== 'inbox') {
    throw new Error('Task must be in Inbox to confirm');
  }
  assertTransition('inbox', 'ready');

  const candidate: Task = {
    ...task,
    projectId: parsed.data.projectId ?? null,
    taskType: parsed.data.taskType ?? null,
    objective: parsed.data.objective ?? null,
    acceptanceCriteria: parsed.data.acceptanceCriteria ?? [],
    permissionProfile: parsed.data.permissionProfile ?? null,
    priority: parsed.data.priority,
    autoExecutable: parsed.data.autoExecutable ?? false,
  };
  if (candidate.projectId !== null && candidate.projectId.trim() !== '') {
    try {
      await ctx.projects.get(candidate.projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        throw new ConfirmTaskProjectNotFoundError();
      }
      throw error;
    }
  }
  const errors = readinessErrors(candidate);
  if (errors.length > 0) {
    throw new Error(`Task is not ready: ${errors.join('; ')}`);
  }

  const timestamp = ctx.clock().toISOString();
  const saved = await ctx.tasks.save({
    ...candidate,
    status: 'ready',
    reviewState: 'confirmed',
    reviewFeedback: null,
    readyAt: timestamp,
    updatedAt: timestamp,
  });
  await ctx.audit.append({
    event: 'task.confirmed',
    at: timestamp,
    taskId: saved.taskId,
    details: {
      projectId: saved.projectId,
      priority: saved.priority,
    },
  });
  return saved;
}
