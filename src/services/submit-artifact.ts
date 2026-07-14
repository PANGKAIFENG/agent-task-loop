import type { ArtifactResult } from '../domain/artifact.js';
import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface SubmitArtifactInput {
  runId: string;
  result: ArtifactResult;
}

export class ArtifactSubmissionInvalidStateError extends Error {
  readonly code = 'artifact_submission_invalid_state';

  constructor() {
    super('Task is not eligible for Artifact submission');
    this.name = 'ArtifactSubmissionInvalidStateError';
  }
}

export class ArtifactSubmissionTaskSaveFailedError extends Error {
  readonly code = 'artifact_submission_task_save_failed';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor(readonly artifactRef: string) {
    super('Artifact written but task save failed');
    this.name = 'ArtifactSubmissionTaskSaveFailedError';
  }
}

export class ArtifactSubmissionAuditFailedError extends Error {
  readonly code = 'artifact_submission_audit_failed';
  readonly partialCommit = true;

  constructor(readonly artifactRef: string) {
    super('Artifact submission audit failed');
    this.name = 'ArtifactSubmissionAuditFailedError';
  }
}

export class ArtifactSubmissionRecoveryError extends Error {
  readonly code = 'artifact_submission_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor(readonly artifactRef: string) {
    super('Artifact submission recovery required');
    this.name = 'ArtifactSubmissionRecoveryError';
  }
}

export async function submitArtifact(
  ctx: ServiceContext,
  taskId: string,
  input: SubmitArtifactInput,
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (
      task.status !== 'in_progress'
      || task.claim === null
      || task.claim.runId !== input.runId
    ) {
      throw new ArtifactSubmissionInvalidStateError();
    }
    assertTransition('in_progress', 'review');
    const timestamp = ctx.clock().toISOString();
    const artifact = await ctx.artifacts.write({
      task,
      runId: input.runId,
      agent: task.claim.agent,
      result: input.result,
      createdAt: timestamp,
    });
    const reviewTask: Task = {
      ...task,
      status: 'review',
      claim: null,
      artifactRefs: [...task.artifactRefs, artifact.ref],
      reviewFeedback: null,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(reviewTask);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw new ArtifactSubmissionTaskSaveFailedError(artifact.ref);
      }
      saved = reviewTask;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'artifact.submitted',
        at: timestamp,
        taskId: task.taskId,
        runId: input.runId,
        details: {
          artifactRef: artifact.ref,
          attempt: task.attempts,
          artifactSha256: artifact.sha256,
        },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new ArtifactSubmissionRecoveryError(artifact.ref);
      }
      throw new ArtifactSubmissionAuditFailedError(artifact.ref);
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
