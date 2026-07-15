import type { Task } from '../domain/task.js';
import { localBusinessDate } from '../services/claim-task.js';
import { peekNextTask } from '../services/query-tasks.js';
import type { ServiceContext } from '../services/service-context.js';
import type { AuditEvent } from '../storage/contracts.js';
import {
  acquireProcessLock,
} from './process-lock.js';
import {
  appendBusyAudit,
  errorCode,
  executeRun,
  runOnce,
  type RunOnceDependencies,
} from './run-once.js';

export type RunOutcome =
  | { status: 'submitted'; taskId: string; runId: string; artifactRef: string }
  | { status: 'no_task' | 'daily_limit' | 'runner_busy' }
  | {
    status: 'requeued' | 'blocked';
    taskId: string;
    runId: string;
    errorCode: string;
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
}

export type CreateRunnerControllerOptions = RunOnceDependencies;

export interface RunnerStatus {
  latestRun: AuditEvent | null;
  automaticClaimsToday: number;
  dailyLimit: number;
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
  options: { dailyLimit: number },
): Promise<RunnerStatus> {
  const [latestRun, automaticClaimsToday, tasks, nextEligibleTask] = await Promise.all([
    ctx.audit.latest({
      events: [
        'task.claimed',
        'runner.failed',
        'runner.terminal_failure',
        'artifact.submitted',
      ],
    }),
    ctx.audit.count({
      event: 'task.claimed',
      localDate: localBusinessDate(ctx.clock()),
      mode: 'automatic',
    }),
    ctx.tasks.list(),
    peekNextTask(ctx),
  ]);
  return {
    latestRun,
    automaticClaimsToday,
    dailyLimit: options.dailyLimit,
    blockedTasks: tasks.filter((task) => task.status === 'blocked'),
    nextEligibleTask,
  };
}
