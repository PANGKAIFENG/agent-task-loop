import { isTaskCompletionEvent } from './query-contribution.js';
import type { ServiceContext } from './service-context.js';

export type CompletionDateBackfillErrorCode =
  | 'invalid_date'
  | 'future_date'
  | 'task_not_done';

export class CompletionDateBackfillError extends Error {
  readonly code: CompletionDateBackfillErrorCode;

  constructor(code: CompletionDateBackfillErrorCode) {
    super(code);
    this.name = 'CompletionDateBackfillError';
    this.code = code;
  }
}

export interface RecordTaskCompletionDateInput {
  taskId: string;
  completedOn: string;
  timeZone: string;
}

export interface RecordTaskCompletionDateResult {
  recorded: boolean;
  taskId: string;
  completedOn: string;
}

function dateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  });
}

function formattedParts(value: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(value)
    .map(({ type, value: part }) => [type, part]));
}

function localDate(value: Date, timeZone: string): string {
  const parts = formattedParts(value, timeZone);
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
}

function localNoonIso(
  parts: { year: number; month: number; day: number },
  timeZone: string,
): string {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  let instant = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = formattedParts(new Date(instant), timeZone);
    const represented = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second),
    );
    instant += desired - represented;
  }
  return new Date(instant).toISOString();
}

export async function recordTaskCompletionDate(
  ctx: ServiceContext,
  input: RecordTaskCompletionDateInput,
): Promise<RecordTaskCompletionDateResult> {
  const parsedDate = dateParts(input.completedOn);
  if (parsedDate === null) throw new CompletionDateBackfillError('invalid_date');
  const recordedAt = ctx.clock();
  if (input.completedOn > localDate(recordedAt, input.timeZone)) {
    throw new CompletionDateBackfillError('future_date');
  }

  return ctx.tasks.withTaskLock(input.taskId, async () => {
    const task = await ctx.tasks.get(input.taskId);
    if (task.status !== 'done') throw new CompletionDateBackfillError('task_not_done');
    const history = await ctx.audit.listForTask(input.taskId);
    if (history.some(isTaskCompletionEvent)) {
      return {
        recorded: false,
        taskId: input.taskId,
        completedOn: input.completedOn,
      };
    }
    await ctx.audit.append({
      event: 'task.completion_date_recorded',
      at: localNoonIso(parsedDate, input.timeZone),
      taskId: input.taskId,
      details: {
        completedOn: input.completedOn,
        recordedAt: recordedAt.toISOString(),
        source: 'manual_backfill',
      },
    });
    return {
      recorded: true,
      taskId: input.taskId,
      completedOn: input.completedOn,
    };
  });
}
