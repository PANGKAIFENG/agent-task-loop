import {
  buildContextBundle,
  type AdditionalLocalContext,
} from './context-bundle.js';
import {
  ContextManifestBlockedError,
  persistContextManifest,
} from './context-manifest-runtime.js';
import { persistRuntimePack } from './runtime-pack.js';
import {
  executionProfileResultMatchesTask,
  resolveExecutionProfile,
  validateExecutionProfileContext,
} from './execution-profile.js';
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
import { peekNextDecisionContinuation } from '../services/query-tasks.js';
import type { ServiceContext } from '../services/service-context.js';
import { startDecisionContinuation } from '../services/start-decision-continuation.js';
import { submitArtifact } from '../services/submit-artifact.js';
import type { RunOutcome } from './runner-controller.js';
import type { Task } from '../domain/task.js';
import type { ContextCandidate } from '../domain/context-manifest.js';
import type { Project } from '../domain/project.js';
import {
  projectContextSha256,
  resolveProjectContext,
  type ResolveProjectContextInput,
} from '../domain/project-context-resolution.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';

export interface ArtifactChainContextPlan {
  projectContext: ResolveProjectContextInput;
  additionalLocalContexts: readonly AdditionalLocalContext[];
  candidates: ContextCandidate[];
}

export type ArtifactChainContextPlanner = (input: {
  task: Task;
  project: Project;
}) => Promise<ArtifactChainContextPlan>;

export interface RunOnceDependencies {
  ctx: ServiceContext;
  driver: ResearchDriver;
  runtimeRoot: string;
  allowedLocalRoots: readonly string[];
  leaseMinutes: number;
  timeoutMs: number;
  agent: string;
  runId: () => string;
  artifactChainContextPlanner?: ArtifactChainContextPlanner;
  processLock?: Omit<AcquireProcessLockOptions, 'runtimeRoot' | 'clock'>;
}

export interface RunInput {
  taskId?: string;
  mode: ClaimMode;
  continuationOfRunId?: string;
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
    || (
      input.continuationOfRunId !== undefined
      && (input.mode !== 'manual' || input.continuationOfRunId.trim() === '')
    )
  ) {
    throw new InvalidRunnerInputError();
  }
  await recoverExpiredClaims(dependencies.ctx);

  let task;
  if (input.mode === 'automatic') {
    const continuation = await peekNextDecisionContinuation(dependencies.ctx);
    if (continuation?.lastDecision !== null && continuation?.lastDecision !== undefined) {
      const started = await startDecisionContinuation(
        dependencies.ctx,
        continuation.taskId,
        {
          decisionRequestId: continuation.lastDecision.requestId,
          responseEventId: continuation.lastDecision.responseEventId,
          agent: dependencies.agent,
          runId,
          mode: 'automatic',
          leaseMinutes: dependencies.leaseMinutes,
        },
      );
      task = started.started ? started.task : null;
    } else {
      task = await claimNextTask(dependencies.ctx, {
        agent: dependencies.agent,
        runId,
        mode: 'automatic',
        leaseMinutes: dependencies.leaseMinutes,
      });
    }
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
    const previousArtifactParts = previousArtifactRef === undefined
      ? null
      : parseArtifactReference(previousArtifactRef, task.taskId);
    if (previousArtifactRef !== undefined && previousArtifactParts === null) {
      throw new InvalidRunnerInputError();
    }
    const previousArtifact = previousArtifactRef === undefined || previousArtifactParts === null
      ? undefined
      : {
          reference: previousArtifactRef,
          version: `v${previousArtifactParts.attempt}`,
          ...await dependencies.ctx.artifacts.readSummary(previousArtifactRef),
        };
    if (input.continuationOfRunId !== undefined) {
      if (previousArtifactRef === undefined) throw new InvalidRunnerInputError();
      const production = await dependencies.ctx.artifacts.readProductionEvidence(
        previousArtifactRef,
      );
      if (
        production.identity.taskId !== task.taskId
        || production.identity.ref !== previousArtifactRef
        || production.runId !== input.continuationOfRunId
      ) throw new InvalidRunnerInputError();
    }
    const artifactChainContext = dependencies.artifactChainContextPlanner === undefined
      ? undefined
      : await dependencies.artifactChainContextPlanner({ task, project });
    const projectResolution = artifactChainContext === undefined
      ? undefined
      : resolveProjectContext(artifactChainContext.projectContext);
    if (
      projectResolution !== undefined
      && (
        projectResolution.status !== 'resolved'
        || projectResolution.registry.atlProjectId !== project.projectId
        || projectResolution.atl.project.projectId !== project.projectId
        || projectResolution.atl.ref !== `atl-project://${project.projectId}`
        || projectResolution.atl.sha256 !== projectContextSha256(project)
      )
    ) {
      throw new InvalidRunnerInputError();
    }
    const context = await buildContextBundle(task, project, {
      allowedLocalRoots: dependencies.allowedLocalRoots,
      ...(previousArtifact === undefined ? {} : { previousArtifact }),
      ...(artifactChainContext === undefined
        ? {}
        : { additionalLocalContexts: artifactChainContext.additionalLocalContexts }),
    });
    const executionProfile = resolveExecutionProfile(task);
    validateExecutionProfileContext(executionProfile, context);
    const persistedContextManifest = (
      artifactChainContext === undefined
      || projectResolution === undefined
    )
      ? undefined
      : await persistContextManifest(dependencies.runtimeRoot, {
          taskId: task.taskId,
          runId,
          asOf: dependencies.ctx.clock().toISOString(),
          projectResolution,
          context,
          candidates: artifactChainContext.candidates,
        });
    if (persistedContextManifest !== undefined) {
      const consumedCount = persistedContextManifest.manifest.entries.filter(({ status }) => (
        status === 'consumed'
      )).length;
      await dependencies.ctx.audit.append({
        event: 'context_manifest.frozen',
        at: dependencies.ctx.clock().toISOString(),
        taskId: task.taskId,
        projectId: project.projectId,
        runId,
        details: {
          manifestId: persistedContextManifest.manifest.manifestId,
          manifestSha256: persistedContextManifest.manifest.sha256,
          documentSha256: persistedContextManifest.documentSha256,
          status: persistedContextManifest.manifest.status,
          candidateCount: persistedContextManifest.manifest.entries.length,
          consumedCount,
          issueCount: persistedContextManifest.manifest.issues.length,
        },
      });
      if (persistedContextManifest.manifest.status === 'blocked') {
        throw new ContextManifestBlockedError();
      }
    }
    const runtimePack = await persistRuntimePack(dependencies.runtimeRoot, {
      task,
      project,
      context,
      executionProfile,
      asOf: dependencies.ctx.clock().toISOString(),
      expiresAt: task.claim.leaseExpiresAt,
      ...(persistedContextManifest === undefined
        ? {}
        : {
            contextManifest: {
              manifestId: persistedContextManifest.manifest.manifestId,
              sha256: persistedContextManifest.manifest.sha256,
            },
          }),
      ...(input.continuationOfRunId === undefined
        ? {}
        : { continuationOfRunId: input.continuationOfRunId }),
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
        executionProfileId: executionProfile.profileId,
        executionProfileVersion: executionProfile.profileVersion,
        executionProfileSha256: runtimePack.pack.executionProfileSha256,
        contextManifestId: runtimePack.pack.contextManifestId,
        contextManifestSha256: runtimePack.pack.contextManifestSha256,
      },
    });
    const rawResult = await dependencies.driver.execute({
      task,
      context: { ...context, packId: runtimePack.packId },
      profile: executionProfile,
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
    if (!executionProfileResultMatchesTask(
      executionProfile,
      task,
      parsedResult.data,
    )) {
      throw new InvalidRunnerResultError();
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
