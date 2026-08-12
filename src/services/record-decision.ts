import { z } from 'zod';

import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

const DECISION_EVENT_LOCK_KEY = 'decision-event-global';

export interface RecordDecisionInput {
  decisionRequestId: string;
  responseEventId: string;
  senderUserId: string;
  conversationId: string;
  selectedOptionId: string;
  responseText?: string;
}

export interface RecordDecisionResult {
  task: Task;
  accepted: boolean;
}

export class DecisionEventInvalidError extends Error {
  readonly code = 'decision_event_invalid';

  constructor() {
    super('Decision event is invalid');
    this.name = 'DecisionEventInvalidError';
  }
}

export class DecisionEventConflictError extends Error {
  readonly code = 'decision_event_conflict';

  constructor() {
    super('Decision event conflicts with the recorded decision');
    this.name = 'DecisionEventConflictError';
  }
}

export class DecisionEventAuditFailedError extends Error {
  readonly code = 'decision_event_audit_failed';

  constructor() {
    super('Decision event audit failed');
    this.name = 'DecisionEventAuditFailedError';
  }
}

export class DecisionEventRecoveryError extends Error {
  readonly code = 'decision_event_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Decision event recovery required');
    this.name = 'DecisionEventRecoveryError';
  }
}

const inputSchema = z.object({
  decisionRequestId: z.string().trim().min(1).max(200),
  responseEventId: z.string().trim().min(1).max(200),
  senderUserId: z.string().trim().min(1).max(200),
  conversationId: z.string().trim().min(1).max(200),
  selectedOptionId: z.string().trim().min(1).max(200),
  responseText: z.string().max(20_000).optional(),
}).strict();

function isExactReplay(task: Task, input: z.infer<typeof inputSchema>): boolean {
  return task.lastDecision?.requestId === input.decisionRequestId
    && task.lastDecision.responseEventId === input.responseEventId
    && task.lastDecision.senderUserId === input.senderUserId
    && task.lastDecision.conversationId === input.conversationId
    && task.lastDecision.selectedOptionId === input.selectedOptionId
    && task.lastDecision.responseText === (input.responseText ?? null);
}

export async function recordDecision(
  ctx: ServiceContext,
  taskId: string,
  input: RecordDecisionInput,
): Promise<RecordDecisionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new DecisionEventInvalidError();

  return ctx.tasks.withTaskLock(DECISION_EVENT_LOCK_KEY, async () => {
    const recordedForEvent = (await ctx.tasks.list()).filter(
      (task) => task.lastDecision?.responseEventId === parsed.data.responseEventId,
    );
    if (recordedForEvent.length > 0) {
      if (
        recordedForEvent.length === 1
        && recordedForEvent[0]?.taskId === taskId
        && isExactReplay(recordedForEvent[0], parsed.data)
      ) {
        return { task: recordedForEvent[0], accepted: false };
      }
      throw new DecisionEventConflictError();
    }

    return ctx.tasks.withTaskLock(taskId, async () => {
      const task = await ctx.tasks.get(taskId);
      const pending = task.pendingDecision;
      if (
        task.status !== 'waiting_for_decision'
        || pending === null
        || pending === undefined
      ) {
        if (isExactReplay(task, parsed.data)) return { task, accepted: false };
        if (
          task.lastDecision?.requestId === parsed.data.decisionRequestId
          || task.lastDecision?.responseEventId === parsed.data.responseEventId
        ) {
          throw new DecisionEventConflictError();
        }
        throw new DecisionEventInvalidError();
      }
      if (task.lastDecision?.responseEventId === parsed.data.responseEventId) {
        throw new DecisionEventConflictError();
      }
      const selectedOption = pending.options.find(
        ({ id }) => id === parsed.data.selectedOptionId,
      );
      if (
        pending.requestId !== parsed.data.decisionRequestId
        || selectedOption === undefined
      ) {
        throw new DecisionEventInvalidError();
      }

      assertTransition('waiting_for_decision', 'agent_executable');
      const timestamp = ctx.clock().toISOString();
      const executable: Task = {
        ...task,
        status: 'agent_executable',
        pendingDecision: null,
        lastDecision: {
          schemaVersion: 1,
          requestId: parsed.data.decisionRequestId,
          selectedOptionId: parsed.data.selectedOptionId,
          selectedOptionLabel: selectedOption.label,
          responseText: parsed.data.responseText ?? null,
          responseEventId: parsed.data.responseEventId,
          senderUserId: parsed.data.senderUserId,
          conversationId: parsed.data.conversationId,
          respondedAt: timestamp,
          continuationRunId: null,
          continuationOfRunId: pending.requestedByRunId,
          continuationStartedAt: null,
        },
        updatedAt: timestamp,
      };

      let saved: Task;
      let staleIndexError: TaskSavedIndexStaleError | null = null;
      try {
        saved = await ctx.tasks.save(executable);
      } catch (error) {
        if (!(error instanceof TaskSavedIndexStaleError)) throw error;
        saved = executable;
        staleIndexError = error;
      }
      try {
        await ctx.audit.append({
          event: 'decision.received',
          at: timestamp,
          taskId,
          details: {
            decisionRequestId: parsed.data.decisionRequestId,
            responseEventId: parsed.data.responseEventId,
            senderUserId: parsed.data.senderUserId,
            conversationId: parsed.data.conversationId,
            selectedOptionId: parsed.data.selectedOptionId,
          },
        });
      } catch {
        try {
          await ctx.tasks.save(task);
        } catch {
          throw new DecisionEventRecoveryError();
        }
        throw new DecisionEventAuditFailedError();
      }
      if (staleIndexError !== null) throw staleIndexError;
      return { task: saved, accepted: true };
    });
  });
}
