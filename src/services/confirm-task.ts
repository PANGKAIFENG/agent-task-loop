import { z } from 'zod';

import {
  contextRefErrors,
  isExternalExecutionTask,
  PRIORITIES,
  TASK_TYPES,
  PERMISSION_PROFILES,
  type Priority,
  type Task,
} from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { ProjectNotFoundError } from '../storage/markdown-project-repository.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface ConfirmTaskInput {
  projectId?: string;
  taskType?: (typeof TASK_TYPES)[number];
  objective?: string;
  acceptanceCriteria?: string[];
  permissionProfile?: (typeof PERMISSION_PROFILES)[number];
  /**
   * PAW-GOAL-003-V0.5 D1 (PRD 4.1): a development declaration carries the
   * dispatch contract — external execution target and repo-relative context
   * refs. Research inputs never set these fields, so old callers are
   * unaffected.
   */
  executionTarget?: 'multica';
  contextRefs?: string[];
  priority: Priority;
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

export class ConfirmTaskInvalidStateError extends Error {
  readonly code = 'task_confirmation_invalid_state';

  constructor() {
    super('Task must be in Inbox or unconfirmed Ready to confirm');
    this.name = 'ConfirmTaskInvalidStateError';
  }
}

export class TaskConfirmationAuditFailedError extends Error {
  readonly code = 'task_confirmation_audit_failed';

  constructor() {
    super('Task confirmation audit failed');
    this.name = 'TaskConfirmationAuditFailedError';
  }
}

export class TaskConfirmationRecoveryError extends Error {
  readonly code = 'task_confirmation_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task confirmation recovery required');
    this.name = 'TaskConfirmationRecoveryError';
  }
}

const confirmTaskInputSchema = z
  .object({
    projectId: z.string().max(200).optional(),
    taskType: z.enum(TASK_TYPES).optional(),
    objective: z.string().max(4_000).optional(),
    acceptanceCriteria: z.array(z.string().max(2_000)).max(50).optional(),
    permissionProfile: z.enum(PERMISSION_PROFILES).optional(),
    executionTarget: z.literal('multica').optional(),
    contextRefs: z.array(z.string().max(300)).max(50).optional(),
    priority: z.enum(PRIORITIES),
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
  // PAW-GOAL-003-V0.5 D1 (PRD 4.1 / cross-module rule 6): context refs may
  // only persist in the shape the dispatch admission would accept. The
  // confirmation form surfaces the same per-entry errors before submit; this
  // backstop fails closed on ANY provided refs regardless of the declared
  // task type, so no caller can smuggle invalid entries into the vault. The
  // plugin process has no allowlisted local roots, so absolute paths always
  // count as out of bounds here — the same rule the Contract preview and
  // authorizeDevelopmentTask enforce (stricter than admission, never looser).
  if (contextRefErrors(parsed.data.contextRefs ?? [], []).length > 0) {
    throw new InvalidConfirmTaskInputError();
  }

  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    // PAW-GOAL-003-V0.5 D1 CR fix (PRD 4.2 返回表单修正): a confirmed
    // development declaration that has not started dispatch may be amended
    // through the same confirmation path — otherwise the Contract's
    // "return to the form and fix the gaps" loop would be a dead end.
    // Research tasks keep the exact previous state guard.
    const amendsUndeliveredDevelopment = task.status === 'ready'
      && task.reviewState === 'confirmed'
      && isExternalExecutionTask(task)
      && parsed.data.taskType === 'development'
      && (task.executionLink?.dispatchState ?? 'not_requested') === 'not_requested';
    const confirmsReadyCandidate = task.status === 'ready'
      && task.reviewState !== 'confirmed';
    if (task.status !== 'inbox' && !confirmsReadyCandidate && !amendsUndeliveredDevelopment) {
      throw new ConfirmTaskInvalidStateError();
    }
    if (task.status === 'inbox') {
      assertTransition('inbox', 'ready');
    }

    const candidate: Task = {
      ...task,
      projectId: parsed.data.projectId ?? null,
      taskType: parsed.data.taskType ?? null,
      objective: parsed.data.objective ?? null,
      acceptanceCriteria: parsed.data.acceptanceCriteria ?? [],
      permissionProfile: parsed.data.permissionProfile ?? null,
      // Development-only fields: untouched for research inputs, so research
      // confirmation behavior stays byte-identical to the previous contract.
      ...(parsed.data.executionTarget === undefined
        ? {}
        : { executionTarget: parsed.data.executionTarget }),
      ...(parsed.data.contextRefs === undefined
        ? {}
        : { contextRefs: parsed.data.contextRefs }),
      priority: parsed.data.priority,
      // Agent authorization is a separate, explicit transition after confirmation.
      autoExecutable: false,
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
    const timestamp = ctx.clock().toISOString();
    const confirmedTask: Task = {
      ...candidate,
      status: 'ready',
      reviewState: 'confirmed',
      reviewFeedback: null,
      readyAt: task.readyAt ?? timestamp,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(confirmedTask);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = confirmedTask;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.confirmed',
        at: timestamp,
        taskId: saved.taskId,
        details: {
          projectId: saved.projectId,
          priority: saved.priority,
        },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch (error) {
        if (error instanceof TaskSavedIndexStaleError) {
          throw new TaskConfirmationAuditFailedError();
        }
        throw new TaskConfirmationRecoveryError();
      }
      throw new TaskConfirmationAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
