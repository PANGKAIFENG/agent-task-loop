import { isAbsolute, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  executionLinkSchema,
  type ExecutionLink,
} from './execution-link.js';
import {
  actionRequestSchema,
  type ActionRequest,
} from './action-request.js';
import {
  TASK_STATUSES,
  type ControlledTaskStatus,
  type TaskStatus,
} from './task-status.js';
import {
  candidateUnderstandingRevisionSchema,
  type CandidateUnderstandingRevision,
} from './candidate-understanding.js';

export { TASK_STATUSES };
export type { ControlledTaskStatus, TaskStatus };

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

export const TASK_TYPES = ['research', 'development'] as const;
export const PERMISSION_PROFILES = ['read_only_research', 'repo_delivery'] as const;
export const EXECUTION_TARGETS = ['multica'] as const;

export type Priority = (typeof PRIORITIES)[number];
export type TaskType = (typeof TASK_TYPES)[number] | null;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number] | null;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number] | null;

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
  taskType: TaskType;
  objective: string | null;
  acceptanceCriteria: string[];
  autoExecutable: boolean;
  permissionProfile: PermissionProfile;
  executionTarget?: ExecutionTarget | null | undefined;
  contextRefs?: string[] | undefined;
  executionLink?: ExecutionLink | null | undefined;
  actionRequest?: ActionRequest | null | undefined;
  /**
   * TEP-50 fix 1 (TECH §6 step 2): handled action_requests retained when a
   * newer event replaced them. The current `actionRequest` is replaceable, so
   * the durable handled-reply evidence (stream event id + terminal step) lives
   * on in this history — written in the same task save as the replacement.
   */
  handledActionRequests?: ActionRequest[] | undefined;
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
  candidateUnderstanding?: CandidateUnderstandingRevision | null | undefined;
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
    taskType: z.enum(TASK_TYPES).nullable(),
    objective: z.string().nullable(),
    acceptanceCriteria: z.array(z.string()),
    autoExecutable: z.boolean(),
    permissionProfile: z.enum(PERMISSION_PROFILES).nullable(),
    executionTarget: z.enum(EXECUTION_TARGETS).nullable().optional(),
    contextRefs: z.array(z.string()).optional(),
    executionLink: executionLinkSchema.nullable().optional(),
    actionRequest: actionRequestSchema.nullable().optional(),
    handledActionRequests: z.array(actionRequestSchema).max(20).optional(),
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
    candidateUnderstanding: candidateUnderstandingRevisionSchema.nullable().optional(),
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
  if (task.sourceKey.trim() === '') {
    errors.push('sourceKey is required');
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

export function isDecisionContinuationPending(task: Task): boolean {
  return !isExternalExecutionTask(task)
    && task.status === 'agent_executable'
    && task.reviewState === 'confirmed'
    && task.claim === null
    && task.lastDecision !== null
    && task.lastDecision !== undefined
    && task.lastDecision.continuationRunId === null
    && typeof task.lastDecision.continuationOfRunId === 'string'
    && task.lastDecision.continuationOfRunId.trim() !== ''
    && readinessErrors(task).length === 0;
}

// PAW-GOAL-003 T1: a task dispatched to an external executor (Multica) is
// owned by the remote loop; every local execution entry point must exclude
// it explicitly instead of relying on the research readiness rules.
export function isExternalExecutionTask(task: Task): boolean {
  return task.executionTarget === 'multica';
}

export function taskContextRefs(task: Task): string[] {
  return task.contextRefs ?? [];
}

// PAW-GOAL-003 T1 admission contract (PRD 4.1 / Goal AC 2): a development
// task may only be dispatched when every field-level requirement holds.
// Missing pieces keep the task undelivered and surface the exact gap.
export function developmentDispatchErrors(
  task: Task,
  allowedLocalRoots: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  if (task.status !== 'agent_executable') {
    errors.push('status must be agent_executable');
  }
  if (task.taskType !== 'development') {
    errors.push('taskType must be development');
  }
  if (task.projectId === null || task.projectId.trim() === '') {
    errors.push('projectId is required');
  }
  if (task.objective === null || task.objective.trim() === '') {
    errors.push('objective is required');
  }
  if (!task.acceptanceCriteria.some((criterion) => criterion.trim() !== '')) {
    errors.push('acceptanceCriteria requires at least one item');
  }
  if (task.permissionProfile !== 'repo_delivery') {
    errors.push('permissionProfile must be repo_delivery');
  }
  if (task.executionTarget !== 'multica') {
    errors.push('executionTarget must be multica');
  }
  const refs = taskContextRefs(task);
  if (!refs.some((ref) => ref.trim() !== '')) {
    errors.push('contextRefs requires at least one item');
  } else {
    errors.push(...contextRefErrors(refs, allowedLocalRoots));
  }
  return errors;
}

// context_refs only allow repo-relative paths or allowlisted local paths
// (TECH §2). Traversal segments, absolute roots outside the allowlist, and
// control characters are rejected with a per-field reason. Absolute refs are
// canonicalized with path semantics before the containment check, so a
// written `..` segment can never smuggle a ref outside its allowlisted root
// (symlink escapes are covered separately by context-ref-resolution.ts).
function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

export function contextRefErrors(refs: readonly string[], allowedLocalRoots: readonly string[] = []): string[] {
  const errors: string[] = [];
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (trimmed === '') {
      errors.push('contextRefs must not contain empty entries');
      continue;
    }
    if (trimmed.length > 300) {
      errors.push('contextRefs entries must be at most 300 characters');
      continue;
    }
    if (containsControlCharacters(trimmed)) {
      errors.push('contextRefs entries must not contain control characters');
      continue;
    }
    if (trimmed.startsWith('/')) {
      const allowed = allowedLocalRoots.some((root) => root !== '' && isInsideRoot(root, trimmed));
      if (!allowed) {
        errors.push(`contextRefs entry is outside the allowlist: ${trimmed}`);
      }
      continue;
    }
    const segments = trimmed.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      errors.push(`contextRefs entry must not contain traversal segments: ${trimmed}`);
    }
  }
  return errors;
}
