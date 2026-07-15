import { z } from 'zod';

import {
  PRIORITIES,
  taskSchema,
  type Priority,
  type Task,
} from '../domain/task.js';
import type { ServiceContext } from './service-context.js';

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

function normalizedTitleCharacters(title: string): string[] {
  return [...title.normalize('NFKC').toLowerCase()]
    .filter((character) => /[\p{L}\p{N}]/u.test(character));
}

function markdownBody(body: string): string {
  return body.startsWith('\n') || body.startsWith('\r\n') ? body : `\n${body}`;
}

function titleBigrams(title: string): Set<string> | null {
  const characters = normalizedTitleCharacters(title);
  if (characters.length < 4) {
    return null;
  }
  const bigrams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    bigrams.add(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`);
  }
  return bigrams;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  let intersectionSize = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersectionSize += 1;
    }
  }
  const unionSize = left.size + right.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function possibleDuplicateIds(input: CaptureTaskInput, tasks: Task[]): string[] {
  const inputBigrams = titleBigrams(input.title);
  if (inputBigrams === null) {
    return [];
  }
  return tasks
    .filter((task) => {
      if (task.sourceKey === input.sourceKey) {
        return false;
      }
      const existingBigrams = titleBigrams(task.title);
      return existingBigrams !== null
        && jaccardSimilarity(inputBigrams, existingBigrams) >= 0.8;
    })
    .map((task) => task.taskId)
    .sort();
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
  const existing = await ctx.tasks.findBySourceKey(validInput.sourceKey);
  if (existing !== null) {
    return existing;
  }

  const tasks = await ctx.tasks.list();
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
    possibleDuplicateIds: possibleDuplicateIds(validInput, tasks),
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
