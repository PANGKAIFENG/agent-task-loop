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

function normalizedTaskTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function evidenceDigest(input: CaptureTaskInput): string {
  return createHash('sha256').update(JSON.stringify({
    sourceDate: input.sourceDate,
    sourceNote: input.sourceNote?.normalize('NFKC').trim() ?? null,
    sourceQuote: input.sourceQuote?.normalize('NFKC').trim() ?? null,
  })).digest('hex');
}

function sameCanonicalEvidence(task: Task, input: CaptureTaskInput): boolean {
  return task.sourceDate === input.sourceDate
    && task.sourceNote === input.sourceNote
    && task.sourceQuote === input.sourceQuote;
}

function evidenceBlock(input: CaptureTaskInput, digest: string): string {
  const sourceDate = input.sourceDate ?? '未注明日期';
  const sourceNote = (input.sourceNote ?? '未注明来源').slice(0, 500);
  const sourceQuote = (input.sourceQuote ?? '未保留原文')
    .slice(0, 1_000)
    .replace(/\r?\n/gu, '\n  ');
  return [
    `<!-- atl-source-evidence:${digest} -->`,
    '## 来源补充',
    `- 日期：${sourceDate}`,
    `- 笔记：${sourceNote}`,
    `- 原文：${sourceQuote}`,
  ].join('\n');
}

async function appendSourceEvidence(
  ctx: ServiceContext,
  taskId: string,
  input: CaptureTaskInput,
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const current = await ctx.tasks.get(taskId);
    if (sameCanonicalEvidence(current, input)) return current;
    const digest = evidenceDigest(input);
    const marker = `<!-- atl-source-evidence:${digest} -->`;
    if (current.body.includes(marker)) return current;
    const timestamp = ctx.clock().toISOString();
    const updated = taskSchema.parse({
      ...current,
      body: `${current.body.trimEnd()}\n\n${evidenceBlock(input, digest)}\n`,
      updatedAt: timestamp,
    });
    const saved = await ctx.tasks.saveBody(updated);
    try {
      await ctx.audit.append({
        event: 'task.source_evidence_added',
        at: timestamp,
        taskId,
        details: {
          evidenceSha256: digest,
          sourceDate: input.sourceDate,
        },
      });
    } catch (error) {
      await ctx.tasks.saveBody(current);
      throw error;
    }
    return saved;
  });
}

async function captureValidatedTask(
  ctx: ServiceContext,
  validInput: CaptureTaskInput,
): Promise<Task> {
  const existing = await ctx.tasks.findBySourceKey(validInput.sourceKey);
  if (existing !== null) {
    return appendSourceEvidence(ctx, existing.taskId, validInput);
  }

  const tasks = await ctx.tasks.list();
  const duplicate = classifyTaskDuplicate(validInput, tasks);
  const exactTitleMatches = validInput.origin === 'obsidian_sync'
    ? tasks.filter((task) => (
      task.status !== 'done'
      && task.status !== 'cancelled'
      && normalizedTaskTitle(task.title) === normalizedTaskTitle(validInput.title)
    ))
    : [];
  const mergeTaskId = duplicate.existingTaskId
    ?? (exactTitleMatches.length === 1
      ? exactTitleMatches[0]?.taskId ?? null
      : null);
  if (mergeTaskId !== null) {
    return appendSourceEvidence(ctx, mergeTaskId, validInput);
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
