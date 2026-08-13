import type { Task } from '../domain/task.js';
import { peekNextTask } from '../services/query-tasks.js';
import type { ServiceContext } from '../services/service-context.js';
import type { AuditEvent } from '../storage/contracts.js';
import { recordDecision } from '../services/record-decision.js';
import { startDecisionContinuation } from '../services/start-decision-continuation.js';
import {
  acquireProcessLock,
} from './process-lock.js';
import {
  appendBusyAudit,
  errorCode,
  executeClaimedRun,
  executeRun,
  runOnce,
  type RunOnceDependencies,
} from './run-once.js';

export type RunOutcome =
  | { status: 'submitted'; taskId: string; runId: string; artifactRef: string }
  | {
    status: 'waiting_for_decision';
    taskId: string;
    runId: string;
    decisionRequestId: string;
  }
  | { status: 'no_task' | 'runner_busy' }
  | {
    status: 'requeued' | 'blocked';
    taskId: string;
    runId: string;
    errorCode: string;
  };

export type DecisionContinuationOutcome = RunOutcome | {
  status: 'duplicate_decision';
  taskId: string;
  decisionRequestId: string;
};

export interface RunnerController {
  runAndWait(input: {
    taskId?: string;
    mode: 'automatic' | 'manual';
  }): Promise<RunOutcome>;
  start(input: {
    taskId: string;
    mode: 'manual';
  }): Promise<{ runId: string }>;
  continueAfterDecision(input: {
    taskId: string;
    decisionRequestId: string;
    responseEventId: string;
    senderUserId: string;
    conversationId: string;
    selectedOptionId: string;
    responseText?: string;
  }): Promise<DecisionContinuationOutcome>;
}

export type CreateRunnerControllerOptions = RunOnceDependencies;

export interface RunnerStatus {
  latestRun: AuditEvent | null;
  blockedTasks: Task[];
  nextEligibleTask: Task | null;
}

export class RunnerBusyError extends Error {
  readonly code = 'runner_busy';

  constructor() {
    super('Runner is busy');
    this.name = 'RunnerBusyError';
  }
}

async function recordTerminalFailure(
  dependencies: RunOnceDependencies,
  input: { taskId: string; mode: 'manual' },
  runId: string,
  error: unknown,
): Promise<void> {
  try {
    let boundTaskId: string | undefined;
    try {
      boundTaskId = (await dependencies.ctx.tasks.get(input.taskId)).taskId;
    } catch {
      // Setup failures may happen before an input can be bound to a stored task.
    }
    const event: AuditEvent = {
      event: 'runner.terminal_failure',
      at: dependencies.ctx.clock().toISOString(),
      runId,
      details: {
        errorCode: errorCode(error),
        mode: input.mode,
      },
    };
    if (boundTaskId !== undefined) {
      event.taskId = boundTaskId;
    }
    await dependencies.ctx.audit.append(event);
  } catch {
    // A background pipeline must never produce an unhandled rejection.
  }
}

export function createRunnerController(
  dependencies: CreateRunnerControllerOptions,
): RunnerController {
  return {
    runAndWait: (input) => runOnce(dependencies, input),
    async continueAfterDecision(input) {
      const recorded = await recordDecision(dependencies.ctx, input.taskId, {
        decisionRequestId: input.decisionRequestId,
        responseEventId: input.responseEventId,
        senderUserId: input.senderUserId,
        conversationId: input.conversationId,
        selectedOptionId: input.selectedOptionId,
        ...(input.responseText === undefined ? {} : { responseText: input.responseText }),
      });
      if (
        !recorded.accepted
        && (
          recorded.task.status !== 'agent_executable'
          || recorded.task.lastDecision?.continuationRunId !== null
        )
      ) {
        return {
          status: 'duplicate_decision',
          taskId: input.taskId,
          decisionRequestId: input.decisionRequestId,
        };
      }
      const lock = await acquireProcessLock({
        ...dependencies.processLock,
        runtimeRoot: dependencies.runtimeRoot,
        clock: dependencies.ctx.clock,
      });
      if (lock === null) {
        await appendBusyAudit(dependencies.ctx, 'manual');
        return { status: 'runner_busy' };
      }
      try {
        const runId = dependencies.runId();
        const continuation = await startDecisionContinuation(
          dependencies.ctx,
          input.taskId,
          {
            decisionRequestId: input.decisionRequestId,
            responseEventId: input.responseEventId,
            mode: 'manual',
            agent: dependencies.agent,
            runId,
            leaseMinutes: dependencies.leaseMinutes,
          },
        );
        if (!continuation.started) {
          return {
            status: 'duplicate_decision',
            taskId: input.taskId,
            decisionRequestId: input.decisionRequestId,
          };
        }
        return executeClaimedRun(
          dependencies,
          { mode: 'manual', taskId: input.taskId },
          runId,
          continuation.task,
        );
      } finally {
        await lock.release();
      }
    },
    async start(input) {
      const lock = await acquireProcessLock({
        ...dependencies.processLock,
        runtimeRoot: dependencies.runtimeRoot,
        clock: dependencies.ctx.clock,
      });
      if (lock === null) {
        await appendBusyAudit(dependencies.ctx, input.mode);
        throw new RunnerBusyError();
      }
      let runId: string;
      try {
        runId = dependencies.runId();
      } catch (error) {
        await lock.release();
        throw error;
      }
      void executeRun(dependencies, input, runId)
        .catch(async (error: unknown) => {
          await recordTerminalFailure(dependencies, input, runId, error);
        })
        .finally(async () => {
          await lock.release();
        })
        .catch(() => undefined);
      return { runId };
    },
  };
}

export async function getRunnerStatus(
  ctx: ServiceContext,
): Promise<RunnerStatus> {
  const [latestRun, tasks, nextEligibleTask] = await Promise.all([
    ctx.audit.latest({
      events: [
        'task.claimed',
        'runner.failed',
        'runner.terminal_failure',
        'artifact.submitted',
      ],
    }),
    ctx.tasks.list(),
    peekNextTask(ctx),
  ]);
  return {
    latestRun,
    blockedTasks: tasks.filter((task) => task.status === 'blocked'),
    nextEligibleTask,
  };
}
