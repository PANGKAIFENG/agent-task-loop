import { createHash } from 'node:crypto';

import { z } from 'zod';

export const POST_DEPLOYMENT_ACCEPTANCE_EVENT_TYPE = 'POST_DEPLOYMENT_ACCEPTED';

export interface PostDeploymentAcceptance {
  schemaVersion: 1;
  eventType: typeof POST_DEPLOYMENT_ACCEPTANCE_EVENT_TYPE;
  acceptanceId: string;
  atlTaskId: string;
  /** The needs_decision event accepted after the release was already published. */
  eventId: string;
  headSha: string;
  streamEventId: string;
  decisionAction: 'select:accept';
  freshReviewRef: string;
  repository: string;
  githubIssue: string | null;
  githubPr: string;
  acceptedAt: string;
}

const safeText = (maxLength: number) => z.string().trim().min(1).max(maxLength)
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }), 'Control characters are not allowed');

export function postDeploymentAcceptanceId(input: {
  atlTaskId: string;
  eventId: string;
  headSha: string;
  streamEventId: string;
  repository: string;
  githubPr: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    atlTaskId: input.atlTaskId,
    eventId: input.eventId,
    headSha: input.headSha,
    streamEventId: input.streamEventId,
    repository: input.repository,
    githubPr: input.githubPr,
    decisionAction: 'select:accept',
  }), 'utf8').digest('hex').slice(0, 24);
  return `post-deployment-acceptance:${input.atlTaskId}:${digest}`;
}

export const postDeploymentAcceptanceSchema: z.ZodType<PostDeploymentAcceptance> = z.object({
  schemaVersion: z.literal(1),
  eventType: z.literal(POST_DEPLOYMENT_ACCEPTANCE_EVENT_TYPE),
  acceptanceId: safeText(600),
  atlTaskId: safeText(200),
  eventId: safeText(200),
  headSha: z.string().regex(/^[0-9a-f]{40}$/, 'headSha must be an immutable 40-character git SHA'),
  streamEventId: safeText(200),
  decisionAction: z.literal('select:accept'),
  freshReviewRef: safeText(200),
  repository: safeText(300),
  githubIssue: safeText(100).nullable(),
  githubPr: safeText(100),
  acceptedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((acceptance, context) => {
  const expected = postDeploymentAcceptanceId(acceptance);
  if (acceptance.acceptanceId !== expected) {
    context.addIssue({
      code: 'custom',
      message: `acceptanceId must equal the post-deployment identity (${expected})`,
    });
  }
});

export function postDeploymentAcceptance(
  input: Omit<PostDeploymentAcceptance, 'schemaVersion' | 'eventType' | 'acceptanceId' | 'decisionAction'>,
): PostDeploymentAcceptance {
  return postDeploymentAcceptanceSchema.parse({
    schemaVersion: 1,
    eventType: POST_DEPLOYMENT_ACCEPTANCE_EVENT_TYPE,
    acceptanceId: postDeploymentAcceptanceId(input),
    decisionAction: 'select:accept',
    ...input,
  });
}

export function isPostDeploymentAcceptance(
  acceptance: { eventType: string },
): acceptance is PostDeploymentAcceptance {
  return acceptance.eventType === POST_DEPLOYMENT_ACCEPTANCE_EVENT_TYPE;
}
