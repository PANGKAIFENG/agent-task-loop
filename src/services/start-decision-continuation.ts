import { readinessErrors, type Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import {
  AGENT_CLAIM_LOCK_KEY,
  automaticClaimSlotAvailable,
  type ResolvedClaimTaskOptions,
} from './claim-task.js';
import type { ServiceContext } from './service-context.js';

export interface StartDecisionContinuationInput extends ResolvedClaimTaskOptions {
  decisionRequestId: string;
  responseEventId: string;
}

export interface StartDecisionContinuationResult {
  task: Task;
  started: boolean;
}

export class DecisionContinuationInvalidStateError extends Error {
  readonly code = 'decision_continuation_invalid_state';

  constructor() {
    super('Task is not eligible for decision continuation');
    this.name = 'DecisionContinuationInvalidStateError';
  }
}

export class DecisionContinuationAuditFailedError extends Error {
  readonly code = 'decision_continuation_audit_failed';

  constructor() {
    super('Decision continuation audit failed');
    this.name = 'DecisionContinuationAuditFailedError';
  }
}

export class DecisionContinuationRecoveryError extends Error {
  readonly code = 'decision_continuation_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Decision continuation recovery required');
    this.name = 'DecisionContinuationRecoveryError';
  }
}

function matchesDecision(task: Task, input: StartDecisionContinuationInput): boolean {
  return task.lastDecision?.requestId === input.decisionRequestId
    && task.lastDecision.responseEventId === input.responseEventId;
}

export async function startDecisionContinuation(
  ctx: ServiceContext,
  taskId: string,
  input: StartDecisionContinuationInput,
): Promise<StartDecisionContinuationResult> {
  const now = ctx.clock();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMinutes * 60_000);
  if (
    !Number.isFinite(now.getTime())
    || !Number.isFinite(leaseExpiresAt.getTime())
    || input.mode !== 'manual'
    || input.agent.trim() === ''
    || input.runId.trim() === ''
    || input.decisionRequestId.trim() === ''
    || input.responseEventId.trim() === ''
  ) {
    throw new DecisionContinuationInvalidStateError();
  }

  return ctx.tasks.withTaskLock(AGENT_CLAIM_LOCK_KEY, async () => {
    if (!(await automaticClaimSlotAvailable(ctx))) {
      const task = await ctx.tasks.get(taskId);
      if (matchesDecision(task, input) && task.lastDecision?.continuationRunId) {
        return { task, started: false };
      }
      throw new DecisionContinuationInvalidStateError();
    }
    return ctx.tasks.withTaskLock(taskId, async () => {
      const task = await ctx.tasks.get(taskId);
      if (!matchesDecision(task, input)) {
        throw new DecisionContinuationInvalidStateError();
      }
      if (task.lastDecision?.continuationRunId) {
        return { task, started: false };
      }
      if (
        task.status !== 'agent_executable'
        || task.claim !== null
        || task.reviewState !== 'confirmed'
        || readinessErrors(task).length > 0
        || task.lastDecision === null
        || task.lastDecision === undefined
        || !task.lastDecision.continuationOfRunId
      ) {
        throw new DecisionContinuationInvalidStateError();
      }

      assertTransition('agent_executable', 'in_progress');
      const timestamp = now.toISOString();
      const started: Task = {
        ...task,
        status: 'in_progress',
        attempts: task.attempts + 1,
        claim: {
          runId: input.runId,
          agent: input.agent,
          claimedAt: timestamp,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        },
        lastDecision: {
          ...task.lastDecision,
          continuationRunId: input.runId,
          continuationStartedAt: timestamp,
        },
        updatedAt: timestamp,
      };

      let saved: Task;
      let staleIndexError: TaskSavedIndexStaleError | null = null;
      try {
        saved = await ctx.tasks.save(started);
      } catch (error) {
        if (!(error instanceof TaskSavedIndexStaleError)) throw error;
        saved = started;
        staleIndexError = error;
      }
      try {
        await ctx.audit.append({
          event: 'decision.continuation_started',
          at: timestamp,
          taskId,
          runId: input.runId,
          details: {
            decisionRequestId: input.decisionRequestId,
            responseEventId: input.responseEventId,
            continuationOfRunId: task.lastDecision.continuationOfRunId,
            mode: input.mode,
          },
        });
      } catch {
        try {
          await ctx.tasks.save(task);
        } catch {
          throw new DecisionContinuationRecoveryError();
        }
        throw new DecisionContinuationAuditFailedError();
      }
      if (staleIndexError !== null) throw staleIndexError;
      return { task: saved, started: true };
    });
  });
}
