import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export type ReviewTaskInput =
  | { decision: 'approve'; feedback?: never }
  | { decision: 'request_changes' | 'block' | 'cancel'; feedback: string };

export class ReviewTaskInvalidInputError extends Error {
  readonly code = 'invalid_review_task_input';

  constructor() {
    super('Invalid task review input');
    this.name = 'ReviewTaskInvalidInputError';
  }
}

export class ReviewTaskInvalidStateError extends Error {
  readonly code = 'task_review_invalid_state';

  constructor() {
    super('Task must be in Review');
    this.name = 'ReviewTaskInvalidStateError';
  }
}

export class ReviewTaskArtifactInvalidError extends Error {
  readonly code = 'task_review_artifact_invalid';

  constructor() {
    super('Task Review Artifact is invalid');
    this.name = 'ReviewTaskArtifactInvalidError';
  }
}

export class ReviewTaskAuditFailedError extends Error {
  readonly code = 'task_review_audit_failed';

  constructor() {
    super('Task review audit failed');
    this.name = 'ReviewTaskAuditFailedError';
  }
}

export class ReviewTaskRecoveryError extends Error {
  readonly code = 'task_review_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task review recovery required');
    this.name = 'ReviewTaskRecoveryError';
  }
}

export async function reviewTask(
  ctx: ServiceContext,
  taskId: string,
  input: ReviewTaskInput,
): Promise<Task> {
  const feedback = 'feedback' in input ? input.feedback : undefined;
  if (
    !['approve', 'request_changes', 'block', 'cancel'].includes(input.decision)
    || (input.decision === 'approve' && feedback !== undefined)
    || (
      input.decision !== 'approve'
      && (typeof feedback !== 'string' || feedback.trim() === '' || feedback.length > 20_000)
    )
  ) {
    throw new ReviewTaskInvalidInputError();
  }
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'review') {
      throw new ReviewTaskInvalidStateError();
    }
    const artifactRef = task.artifactRefs.at(-1);
    const parts = artifactRef?.split('/');
    if (
      artifactRef === undefined
      || parts?.length !== 3
      || parts[0] !== 'Artifacts'
      || parts[1] !== task.taskId
      || !/^attempt-\d{3,}\.md$/.test(parts[2] ?? '')
    ) {
      throw new ReviewTaskArtifactInvalidError();
    }
    try {
      const artifact = await ctx.artifacts.readSummary(artifactRef);
      const submission = (await ctx.audit.listForTask(taskId))
        .findLast((event) => (
          event.event === 'artifact.submitted'
          && event.details?.artifactRef === artifactRef
        ));
      if (submission?.details?.artifactSha256 !== artifact.sha256) {
        throw new ReviewTaskArtifactInvalidError();
      }
    } catch {
      throw new ReviewTaskArtifactInvalidError();
    }
    const status = {
      approve: 'done',
      request_changes: 'ready',
      block: 'blocked',
      cancel: 'cancelled',
    }[input.decision] as Task['status'];
    assertTransition('review', status);
    const timestamp = ctx.clock().toISOString();
    const reviewed: Task = {
      ...task,
      status,
      reviewFeedback: feedback ?? null,
      readyAt: status === 'ready' ? timestamp : task.readyAt,
      updatedAt: timestamp,
    };
    let saved: Task;
    let staleIndexError: TaskSavedIndexStaleError | null = null;
    try {
      saved = await ctx.tasks.save(reviewed);
    } catch (error) {
      if (!(error instanceof TaskSavedIndexStaleError)) {
        throw error;
      }
      saved = reviewed;
      staleIndexError = error;
    }
    try {
      await ctx.audit.append({
        event: 'task.reviewed',
        at: timestamp,
        taskId,
        details: { decision: input.decision },
      });
    } catch {
      try {
        await ctx.tasks.save(task);
      } catch {
        throw new ReviewTaskRecoveryError();
      }
      throw new ReviewTaskAuditFailedError();
    }
    if (staleIndexError !== null) {
      throw staleIndexError;
    }
    return saved;
  });
}
