import { z } from 'zod';

export const TASK_STATUSES = [
  'inbox',
  'ready',
  'agent_executable',
  'in_progress',
  'waiting_for_decision',
  'review',
  'done',
  'blocked',
  'cancelled',
] as const;

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

export type ControlledTaskStatus = (typeof TASK_STATUSES)[number];
export type TaskStatus = string;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskBrief {
  schemaVersion: 1;
  objective: string;
  nextAction: string;
  completionCriteria: string;
  updatedAt: string;
}

export interface DecisionOption {
  id: string;
  label: string;
}

export interface PendingDecision {
  schemaVersion: 1;
  requestId: string;
  question: string;
  options: DecisionOption[];
  requestedAt: string;
  requestedByRunId: string;
}

export interface DecisionContext {
  schemaVersion: 1;
  requestId: string;
  selectedOptionId: string;
  selectedOptionLabel: string;
  responseText: string | null;
  responseEventId: string;
  senderUserId?: string | null | undefined;
  conversationId?: string | null | undefined;
  respondedAt: string;
  continuationRunId?: string | null | undefined;
  continuationOfRunId?: string | null | undefined;
  continuationStartedAt?: string | null | undefined;
}

const decisionOptionSchema: z.ZodType<DecisionOption> = z
  .object({
    id: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(2_000),
  })
  .strict();

const uniqueDecisionOptions = (options: DecisionOption[]): boolean => (
  new Set(options.map(({ id }) => id)).size === options.length
);

export const pendingDecisionSchema: z.ZodType<PendingDecision> = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(20_000),
    options: z.array(decisionOptionSchema).min(1).max(20)
      .refine(uniqueDecisionOptions, 'Decision option IDs must be unique'),
    requestedAt: z.string().datetime({ offset: true }),
    requestedByRunId: z.string().trim().min(1).max(200),
  })
  .strict();

export const decisionContextSchema: z.ZodType<DecisionContext> = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().trim().min(1).max(200),
    selectedOptionId: z.string().trim().min(1).max(200),
    selectedOptionLabel: z.string().trim().min(1).max(2_000),
    responseText: z.string().max(20_000).nullable(),
    responseEventId: z.string().trim().min(1).max(200),
    senderUserId: z.string().trim().min(1).max(200).nullable().optional(),
    conversationId: z.string().trim().min(1).max(200).nullable().optional(),
    respondedAt: z.string().datetime({ offset: true }),
    continuationRunId: z.string().trim().min(1).max(200).nullable().optional(),
    continuationOfRunId: z.string().trim().min(1).max(200).nullable().optional(),
    continuationStartedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const taskBriefSchema: z.ZodType<TaskBrief> = z
  .object({
    schemaVersion: z.literal(1),
    objective: z.string().trim().min(1).max(4_000),
    nextAction: z.string().trim().min(1).max(4_000),
    completionCriteria: z.string().trim().min(1).max(4_000),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const taskStatusSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }));

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
  pendingDecision?: PendingDecision | null | undefined;
  lastDecision?: DecisionContext | null | undefined;
  taskBrief?: TaskBrief | null | undefined;
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
    pendingDecision: pendingDecisionSchema.nullable().optional(),
    lastDecision: decisionContextSchema.nullable().optional(),
    taskBrief: taskBriefSchema.nullable().optional(),
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
