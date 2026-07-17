import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  PRIORITIES,
  taskSchema,
  type Priority,
  type Task,
} from '../domain/task.js';
import type { ServiceContext } from './service-context.js';
import { classifyTaskDuplicate } from './task-deduplication.js';

export interface CaptureTaskInput {
  title: string;
  body: string;
  origin: string;
  sourceDate: string | null;
  sourceNote: string | null;
  sourceQuote: string | null;
  sourceKey: string;
  priority: Priority;
}

export class InvalidCaptureTaskInputError extends Error {
  readonly code = 'invalid_capture_task_input';

  constructor() {
    super('Invalid capture task input');
    this.name = 'InvalidCaptureTaskInputError';
  }
}

const requiredString = z.string().refine((value) => value.trim() !== '');

const captureTaskInputSchema: z.ZodType<CaptureTaskInput> = z
  .object({
    title: requiredString,
    body: requiredString,
    origin: requiredString,
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    sourceNote: z.string().nullable(),
    sourceQuote: z.string().nullable(),
    sourceKey: requiredString,
    priority: z.enum(PRIORITIES),
  })
  .strict();

function markdownBody(body: string): string {
  return body.startsWith('\n') || body.startsWith('\r\n') ? body : `\n${body}`;
}

function captureLockId(input: CaptureTaskInput): string {
  const scope = input.sourceNote === null
    ? `source-key:${input.sourceKey}`
    : `source-note:${input.sourceNote.normalize('NFKC').trim()}`;
  const digest = createHash('sha256').update(scope).digest('hex');
  return `capture-${digest}`;
}

async function captureValidatedTask(
  ctx: ServiceContext,
  validInput: CaptureTaskInput,
): Promise<Task> {
  const existing = await ctx.tasks.findBySourceKey(validInput.sourceKey);
  if (existing !== null) {
    return existing;
  }

  const tasks = await ctx.tasks.list();
  const duplicate = classifyTaskDuplicate(validInput, tasks);
  if (duplicate.existingTaskId !== null) {
    const duplicateTask = tasks.find((task) => (
      task.taskId === duplicate.existingTaskId
    ));
    if (duplicateTask !== undefined) return duplicateTask;
  }
  const timestamp = ctx.clock().toISOString();
  const task = taskSchema.parse({
    schemaVersion: 1,
    taskId: ctx.id(),
    title: validInput.title,
    body: markdownBody(validInput.body),
    status: 'inbox',
    reviewState: 'candidate',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: validInput.origin,
    sourceDate: validInput.sourceDate,
    sourceNote: validInput.sourceNote,
    sourceQuote: validInput.sourceQuote,
    sourceKey: validInput.sourceKey,
    possibleDuplicateIds: duplicate.possibleDuplicateIds,
    priority: validInput.priority,
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const result = await ctx.tasks.createIfSourceKeyAbsent(task);
  if (!result.created) {
    return result.task;
  }
  const saved = result.task;
  await ctx.audit.append({
    event: 'task.captured',
    at: timestamp,
    taskId: saved.taskId,
    details: {
      origin: saved.origin,
      priority: saved.priority,
    },
  });
  return saved;
}

export async function captureTask(
  ctx: ServiceContext,
  input: CaptureTaskInput,
): Promise<Task> {
  const parsed = captureTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidCaptureTaskInputError();
  }
  const validInput = parsed.data;
  return ctx.tasks.withTaskLock(
    captureLockId(validInput),
    () => captureValidatedTask(ctx, validInput),
  );
}
