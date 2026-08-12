import { createHash } from 'node:crypto';

import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import type { AuditEvent } from '../storage/contracts.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export type ReviewTaskInput =
  | { decision: 'approve'; feedback?: never; source?: ReviewTaskSource }
  | {
      decision: 'request_changes' | 'block' | 'cancel';
      feedback: string;
      source?: ReviewTaskSource;
    };

export interface ReviewTaskSource {
  kind: 'dingtalk_stream';
  artifactVersion: number;
  responseEventId: string;
  senderUserId: string;
  conversationId: string;
  feedbackSha256: string | null;
}

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

interface EvalSampleAudit {
  runId: string;
  details: Record<string, string | number | boolean | null>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evalSampleAudit(
  task: Task,
  input: ReviewTaskInput,
  artifactRef: string,
  artifactSha256: string,
  submission: AuditEvent,
  events: AuditEvent[],
): EvalSampleAudit | null {
  const packId = submission.details?.packId;
  if (packId === undefined) return null;
  const runId = submission.runId;
  const frozen = events.findLast((event) => (
    event.event === 'context_pack.frozen'
    && event.runId === runId
    && event.details?.packId === packId
  ));
  const packSha256 = frozen?.details?.packSha256;
  const executionProfileId = frozen?.details?.executionProfileId;
  const executionProfileVersion = frozen?.details?.executionProfileVersion;
  const executionProfileSha256 = frozen?.details?.executionProfileSha256;
  if (
    typeof packId !== 'string'
    || !/^pack-[0-9a-f]{24}$/u.test(packId)
    || typeof runId !== 'string'
    || runId.trim() === ''
    || typeof packSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(packSha256)
    || executionProfileId !== 'research_v1'
    || executionProfileVersion !== 1
    || typeof executionProfileSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(executionProfileSha256)
  ) {
    return null;
  }
  const feedbackSha256 = 'feedback' in input
    ? sha256(input.feedback.trim())
    : null;
  const sampleId = `eval-${sha256(JSON.stringify({
    taskId: task.taskId,
    runId,
    packId,
    artifactRef,
    artifactSha256,
    humanOutcome: input.decision,
    feedbackSha256,
  })).slice(0, 24)}`;
  return {
    runId,
    details: {
      evalSampleId: sampleId,
      evalSampleType: 'capability',
      evalSampleStatus: 'pending_review',
      regressionCandidateStatus: input.decision === 'approve'
        ? 'not_proposed'
        : 'pending_review',
      packId,
      packSha256,
      executionProfileId,
      executionProfileVersion,
      executionProfileSha256,
      artifactRef,
      artifactSha256,
      runOutcome: 'artifact_submitted',
      humanOutcome: input.decision,
      feedbackSha256,
      harnessMutationAllowed: false,
    },
  };
}

export async function reviewTask(
  ctx: ServiceContext,
  taskId: string,
  input: ReviewTaskInput,
): Promise<Task> {
  const feedback = 'feedback' in input ? input.feedback : undefined;
  const source = input.source;
  if (
    !['approve', 'request_changes', 'block', 'cancel'].includes(input.decision)
    || (input.decision === 'approve' && feedback !== undefined)
    || (
      input.decision !== 'approve'
      && (typeof feedback !== 'string' || feedback.trim() === '' || feedback.length > 20_000)
    )
    || (
      source !== undefined
      && (
        source.kind !== 'dingtalk_stream'
        || !Number.isSafeInteger(source.artifactVersion)
        || source.artifactVersion <= 0
        || [
          source.responseEventId,
          source.senderUserId,
          source.conversationId,
        ].some((value) => value.trim() === '' || value.length > 200)
        || (
          source.feedbackSha256 !== null
          && !/^[0-9a-f]{64}$/u.test(source.feedbackSha256)
        )
      )
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
    let evalSample: EvalSampleAudit | null;
    try {
      const artifact = await ctx.artifacts.readSummary(artifactRef);
      const events = await ctx.audit.listForTask(taskId);
      const submission = events
        .findLast((event) => (
          event.event === 'artifact.submitted'
          && event.details?.artifactRef === artifactRef
        ));
      if (submission?.details?.artifactSha256 !== artifact.sha256) {
        throw new ReviewTaskArtifactInvalidError();
      }
      evalSample = evalSampleAudit(
        task,
        input,
        artifactRef,
        artifact.sha256,
        submission,
        events,
      );
    } catch {
      throw new ReviewTaskArtifactInvalidError();
    }
    const trustedExternalRework = input.decision === 'request_changes'
      && source?.kind === 'dingtalk_stream';
    const status = trustedExternalRework ? 'agent_executable' : ({
      approve: 'done',
      request_changes: 'ready',
      block: 'blocked',
      cancel: 'cancelled',
    }[input.decision] as Task['status']);
    assertTransition('review', status);
    const timestamp = ctx.clock().toISOString();
    const reviewed: Task = {
      ...task,
      status,
      autoExecutable: trustedExternalRework,
      reviewFeedback: feedback ?? null,
      readyAt: status === 'ready' || status === 'agent_executable'
        ? timestamp
        : task.readyAt,
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
      const details = {
        decision: input.decision,
        ...(evalSample?.details ?? {}),
        ...(source === undefined
          ? {}
          : {
              source: source.kind,
              artifactVersion: source.artifactVersion,
              responseEventId: source.responseEventId,
              senderUserId: source.senderUserId,
              conversationId: source.conversationId,
              feedbackSha256: source.feedbackSha256,
              ...(trustedExternalRework ? {
                toStatus: status,
                executionAuthorized: true,
              } : {}),
            }),
      };
      await ctx.audit.append({
        event: 'task.reviewed',
        at: timestamp,
        taskId,
        ...(evalSample === null ? {} : { runId: evalSample.runId }),
        details,
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
