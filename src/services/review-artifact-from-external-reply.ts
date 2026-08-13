import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Task } from '../domain/task.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';
import { EXTERNAL_RESPONSE_EVENT_LOCK_KEY } from './external-response-event-lock.js';
import { reviewTask, type ReviewTaskInput } from './review-task.js';
import type { ServiceContext } from './service-context.js';

const baseInput = {
  artifactVersion: z.number().int().positive(),
  responseEventId: z.string().trim().min(1).max(200),
  senderUserId: z.string().trim().min(1).max(200),
  conversationId: z.string().trim().min(1).max(200),
};

const inputSchema = z.discriminatedUnion('decision', [
  z.object({
    ...baseInput,
    decision: z.literal('approve'),
  }).strict(),
  z.object({
    ...baseInput,
    decision: z.enum(['request_changes', 'block', 'cancel']),
    feedback: z.string().trim().min(1).max(20_000),
  }).strict(),
]);

export type ExternalArtifactReviewInput = z.input<typeof inputSchema>;

export interface ExternalArtifactReviewResult {
  task: Task;
  accepted: boolean;
}

export class ExternalArtifactReviewInvalidError extends Error {
  readonly code = 'external_artifact_review_invalid';

  constructor() {
    super('External Artifact review is invalid');
    this.name = 'ExternalArtifactReviewInvalidError';
  }
}

export class ExternalResponseEventConflictError extends Error {
  readonly code = 'external_response_event_conflict';

  constructor() {
    super('External response event conflicts with an existing action');
    this.name = 'ExternalResponseEventConflictError';
  }
}

export class ArtifactReviewVersionConflictError extends Error {
  readonly code = 'artifact_review_version_conflict';

  constructor() {
    super('Artifact review version is no longer current');
    this.name = 'ArtifactReviewVersionConflictError';
  }
}

function feedbackSha256(input: z.infer<typeof inputSchema>): string | null {
  return 'feedback' in input
    ? createHash('sha256').update(input.feedback).digest('hex')
    : null;
}

function exactReplay(
  event: Awaited<ReturnType<ServiceContext['audit']['listForTask']>>[number],
  taskId: string,
  input: z.infer<typeof inputSchema>,
): boolean {
  return event.event === 'task.reviewed'
    && event.taskId === taskId
    && event.details?.decision === input.decision
    && event.details.source === 'dingtalk_stream'
    && event.details.artifactVersion === input.artifactVersion
    && event.details.responseEventId === input.responseEventId
    && event.details.senderUserId === input.senderUserId
    && event.details.conversationId === input.conversationId
    && event.details.feedbackSha256 === feedbackSha256(input);
}

export async function reviewArtifactFromExternalReply(
  ctx: ServiceContext,
  taskId: string,
  input: ExternalArtifactReviewInput,
): Promise<ExternalArtifactReviewResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || taskId.trim() === '' || taskId.length > 200) {
    throw new ExternalArtifactReviewInvalidError();
  }

  return ctx.tasks.withTaskLock(EXTERNAL_RESPONSE_EVENT_LOCK_KEY, async () => {
    const tasks = await ctx.tasks.list();
    const events = (await Promise.all(tasks.map(
      (task) => ctx.audit.listForTask(task.taskId),
    ))).flat().filter(
      (event) => event.details?.responseEventId === parsed.data.responseEventId,
    );
    if (events.length > 0) {
      if (
        events.length === 1
        && exactReplay(events[0]!, taskId, parsed.data)
      ) {
        return { task: await ctx.tasks.get(taskId), accepted: false };
      }
      throw new ExternalResponseEventConflictError();
    }

    const task = await ctx.tasks.get(taskId);
    const current = parseArtifactReference(task.artifactRefs.at(-1) ?? '', taskId);
    if (current === null || current.attempt !== parsed.data.artifactVersion) {
      throw new ArtifactReviewVersionConflictError();
    }
    const reviewInput: ReviewTaskInput = 'feedback' in parsed.data
      ? {
          decision: parsed.data.decision,
          feedback: parsed.data.feedback,
          source: {
            kind: 'dingtalk_stream',
            artifactVersion: parsed.data.artifactVersion,
            responseEventId: parsed.data.responseEventId,
            senderUserId: parsed.data.senderUserId,
            conversationId: parsed.data.conversationId,
            feedbackSha256: feedbackSha256(parsed.data),
          },
        }
      : {
          decision: 'approve',
          source: {
            kind: 'dingtalk_stream',
            artifactVersion: parsed.data.artifactVersion,
            responseEventId: parsed.data.responseEventId,
            senderUserId: parsed.data.senderUserId,
            conversationId: parsed.data.conversationId,
            feedbackSha256: null,
          },
        };
    return {
      task: await reviewTask(ctx, taskId, reviewInput),
      accepted: true,
    };
  });
}
