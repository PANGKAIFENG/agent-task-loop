import { buildContextBundle } from './context-bundle.js';
import { persistRuntimePack } from './runtime-pack.js';
import {
  acquireProcessLock,
  type AcquireProcessLockOptions,
} from './process-lock.js';
import type { ResearchDriver } from './research-driver.js';
import { driverResultSchema, type ResearchResult } from './result-contract.js';
import { claimNextTask } from '../services/claim-next-task.js';
import {
  claimTask,
  type ClaimMode,
} from '../services/claim-task.js';
import { requestDecision } from '../services/request-decision.js';
import { recordRunFailure } from '../services/record-run-failure.js';
import { recoverExpiredClaims } from '../services/recover-expired-claims.js';
import type { ServiceContext } from '../services/service-context.js';
import { submitArtifact } from '../services/submit-artifact.js';
import type { RunOutcome } from './runner-controller.js';
import type { Task } from '../domain/task.js';

export interface RunOnceDependencies {
  ctx: ServiceContext;
  driver: ResearchDriver;
  runtimeRoot: string;
  allowedLocalRoots: readonly string[];
  leaseMinutes: number;
  timeoutMs: number;
  agent: string;
  runId: () => string;
  processLock?: Omit<AcquireProcessLockOptions, 'runtimeRoot' | 'clock'>;
}

export interface RunInput {
  taskId?: string;
  mode: ClaimMode;
}

export class InvalidRunnerInputError extends Error {
  readonly code = 'invalid_runner_input';

  constructor() {
    super('Runner input is invalid');
    this.name = 'InvalidRunnerInputError';
  }
}

class InvalidRunnerResultError extends Error {
  readonly code = 'invalid_research_result';

  constructor() {
    super('Runner result is invalid');
    this.name = 'InvalidRunnerResultError';
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'runner_execution_failed';
}

async function appendBusyAudit(
  ctx: ServiceContext,
  mode: ClaimMode,
): Promise<void> {
  await ctx.audit.append({
    event: 'runner.busy',
    at: ctx.clock().toISOString(),
    details: { mode },
  });
}

export async function executeRun(
  dependencies: RunOnceDependencies,
  input: RunInput,
  runId: string,
): Promise<Exclude<RunOutcome, { status: 'runner_busy' }>> {
  if (
    (input.mode === 'manual' && (input.taskId === undefined || input.taskId.trim() === ''))
    || (input.mode === 'automatic' && input.taskId !== undefined)
  ) {
    throw new InvalidRunnerInputError();
  }
  await recoverExpiredClaims(dependencies.ctx);

  let task;
  if (input.mode === 'automatic') {
    task = await claimNextTask(dependencies.ctx, {
      agent: dependencies.agent,
      runId,
      mode: 'automatic',
      leaseMinutes: dependencies.leaseMinutes,
    });
    if (task === null) {
      return { status: 'no_task' };
    }
  } else {
    task = await claimTask(dependencies.ctx, input.taskId ?? '', {
      agent: dependencies.agent,
      runId,
      mode: 'manual',
      leaseMinutes: dependencies.leaseMinutes,
    });
  }

  return executeClaimedRun(dependencies, input, runId, task);
}

export async function executeClaimedRun(
  dependencies: RunOnceDependencies,
  input: RunInput,
  runId: string,
  task: Task,
): Promise<Exclude<RunOutcome, { status: 'runner_busy' | 'no_task' }>> {
  if (
    task.status !== 'in_progress'
    || task.claim === null
    || task.claim.runId !== runId
  ) {
    throw new InvalidRunnerInputError();
  }
  let result: ResearchResult;
  let resultContextPackId: string | undefined;
  try {
    if (task.projectId === null) {
      throw new InvalidRunnerInputError();
    }
    const project = await dependencies.ctx.projects.get(task.projectId);
    const previousArtifactRef = task.artifactRefs.at(-1);
    const previousArtifact = previousArtifactRef === undefined
      ? undefined
      : {
          reference: previousArtifactRef,
          ...await dependencies.ctx.artifacts.readSummary(previousArtifactRef),
        };
    const context = await buildContextBundle(task, project, {
      allowedLocalRoots: dependencies.allowedLocalRoots,
      ...(previousArtifact === undefined ? {} : { previousArtifact }),
    });
    const runtimePack = await persistRuntimePack(dependencies.runtimeRoot, {
      task,
      project,
      context,
      asOf: dependencies.ctx.clock().toISOString(),
      expiresAt: task.claim.leaseExpiresAt,
    });
    resultContextPackId = runtimePack.packId;
    await dependencies.ctx.audit.append({
      event: 'context_pack.frozen',
      at: dependencies.ctx.clock().toISOString(),
      taskId: task.taskId,
      projectId: project.projectId,
      runId,
      details: {
        packId: runtimePack.packId,
        packSha256: runtimePack.sha256,
        blockCount: runtimePack.pack.blocks.length,
        permissionProfile: runtimePack.pack.permissionProfile,
      },
    });
    const rawResult = await dependencies.driver.execute({
      task,
      context: { ...context, packId: runtimePack.packId },
      timeoutMs: dependencies.timeoutMs,
    });
    const parsedResult = driverResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      throw new InvalidRunnerResultError();
    }
    if ('kind' in parsedResult.data) {
      const waiting = await requestDecision(dependencies.ctx, task.taskId, {
        ...parsedResult.data,
        runId,
      });
      return {
        status: 'waiting_for_decision',
        taskId: task.taskId,
        runId,
        decisionRequestId: waiting.pendingDecision?.requestId
          ?? parsedResult.data.decisionRequestId,
      };
    }
    result = parsedResult.data;
  } catch (error) {
    const code = errorCode(error);
    const failed = await recordRunFailure(dependencies.ctx, task.taskId, {
      runId,
      errorCode: code,
      mode: input.mode,
    });
    return {
      status: failed.outcome,
      taskId: task.taskId,
      runId,
      errorCode: code,
    };
  }
  const submitted = await submitArtifact(dependencies.ctx, task.taskId, {
    runId,
    result,
    packId: resultContextPackId,
  });
  const artifactRef = submitted.artifactRefs.at(-1);
  if (artifactRef === undefined) {
    throw new InvalidRunnerResultError();
  }
  return {
    status: 'submitted',
    taskId: task.taskId,
    runId,
    artifactRef,
  };
}

export async function runOnce(
  dependencies: RunOnceDependencies,
  input: RunInput,
): Promise<RunOutcome> {
  const lock = await acquireProcessLock({
    ...dependencies.processLock,
    runtimeRoot: dependencies.runtimeRoot,
    clock: dependencies.ctx.clock,
  });
  if (lock === null) {
    await appendBusyAudit(dependencies.ctx, input.mode);
    return { status: 'runner_busy' };
  }
  try {
    return await executeRun(dependencies, input, dependencies.runId());
  } finally {
    await lock.release();
  }
}

export { appendBusyAudit, errorCode };
