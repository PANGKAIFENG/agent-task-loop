import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import {
  decisionRequestSchema,
  type DecisionRequest,
} from '../runner/result-contract.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface RequestDecisionInput extends DecisionRequest {
  runId: string;
}

export class DecisionRequestInvalidStateError extends Error {
  readonly code = 'decision_request_invalid_state';

  constructor() {
    super('Task is not eligible for a decision request');
    this.name = 'DecisionRequestInvalidStateError';
  }
}

export class DecisionRequestAuditFailedError extends Error {
  readonly code = 'decision_request_audit_failed';

  constructor() {
    super('Decision request audit failed');
    this.name = 'DecisionRequestAuditFailedError';
  }
}

export class DecisionRequestRecoveryError extends Error {
  readonly code = 'decision_request_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Decision request recovery required');
    this.name = 'DecisionRequestRecoveryError';
  }
}

export async function requestDecision(
  ctx: ServiceContext,
  taskId: string,
  input: RequestDecisionInput,
): Promise<Task> {
  const request = decisionRequestSchema.safeParse({
    kind: input.kind,
    decisionRequestId: input.decisionRequestId,
    question: input.question,
    options: input.options,
  });
  if (!request.success || input.runId.trim() === '' || input.runId.length > 200) {
    throw new DecisionRequestInvalidStateError();
  }

  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (
      task.status !== 'in_progress'
      || task.claim === null
      || task.claim.runId !== input.runId
    ) {
      throw new DecisionRequestInvalidStateError();
    }
    assertTransition('in_progress', 'waiting_for_decision');
    const timestamp = ctx.clock().toISOString();
    const waiting: Task = {
      ...task,
      status: 'waiting_for_decision',
      claim: null,
      pendingDecision: {
        schemaVersion: 1,
        requestId: request.data.decisionRequestId,
        question: request.data.question,
        options: request.data.options,
        requestedAt: timestamp,
        requestedByRunId: input.runId,
      },
      updatedAt: timestamp,
    };

    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(waiting);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) throw error;
      saved = waiting;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'decision.requested',
        at: timestamp,
        taskId,
        runId: input.runId,
        details: {
          decisionRequestId: request.data.decisionRequestId,
          optionCount: request.data.options.length,
        },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new DecisionRequestRecoveryError();
      }
      throw new DecisionRequestAuditFailedError();
    }
    if (staleIndexError !== null) throw staleIndexError;
    return saved;
  });
}
