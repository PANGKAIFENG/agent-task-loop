import { z } from 'zod';

export const TASK_STATUSES = [
  'inbox',
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
  'cancelled',
] as const;

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

export type ControlledTaskStatus = (typeof TASK_STATUSES)[number];
export type TaskStatus = string;
export type Priority = (typeof PRIORITIES)[number];

export const taskStatusSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export interface Task {
  schemaVersion: 1;
  taskId: string;
  title: string;
  body: string;
  status: TaskStatus;
  reviewState: 'candidate' | 'ready_for_confirm' | 'confirmed';
  projectId: string | null;
  taskType: 'research' | null;
  objective: string | null;
  acceptanceCriteria: string[];
  autoExecutable: boolean;
  permissionProfile: 'read_only_research' | null;
  origin: string;
  sourceDate: string | null;
  sourceNote: string | null;
  sourceQuote: string | null;
  sourceKey: string;
  possibleDuplicateIds: string[];
  priority: Priority;
  attempts: number;
  claim: {
    runId: string;
    agent: string;
    claimedAt: string;
    leaseExpiresAt: string;
  } | null;
  artifactRefs: string[];
  reviewFeedback: string | null;
  readyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const taskSchema: z.ZodType<Task> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string(),
    title: z.string(),
    body: z.string(),
    status: taskStatusSchema,
    reviewState: z.enum(['candidate', 'ready_for_confirm', 'confirmed']),
    projectId: z.string().nullable(),
    taskType: z.literal('research').nullable(),
    objective: z.string().nullable(),
    acceptanceCriteria: z.array(z.string()),
    autoExecutable: z.boolean(),
    permissionProfile: z.literal('read_only_research').nullable(),
    origin: z.string(),
    sourceDate: z.string().nullable(),
    sourceNote: z.string().nullable(),
    sourceQuote: z.string().nullable(),
    sourceKey: z.string(),
    possibleDuplicateIds: z.array(z.string()),
    priority: z.enum(PRIORITIES),
    attempts: z.number().int().nonnegative(),
    claim: z
      .object({
        runId: z.string(),
        agent: z.string(),
        claimedAt: z.string(),
        leaseExpiresAt: z.string(),
      })
      .strict()
      .nullable(),
    artifactRefs: z.array(z.string()),
    reviewFeedback: z.string().nullable(),
    readyAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const priorityRank: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function readinessErrors(task: Task): string[] {
  const errors: string[] = [];

  if (task.projectId === null || task.projectId.trim() === '') {
    errors.push('projectId is required');
  }
  if (task.taskType !== 'research') {
    errors.push('taskType must be research');
  }
  if (task.objective === null || task.objective.trim() === '') {
    errors.push('objective is required');
  }
  if (!task.acceptanceCriteria.some((criterion) => criterion.trim() !== '')) {
    errors.push('acceptanceCriteria requires at least one item');
  }
  if (task.permissionProfile !== 'read_only_research') {
    errors.push('permissionProfile must be read_only_research');
  }
  return errors;
}
