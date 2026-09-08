import { describe, expect, it } from 'vitest';

import {
  postDeploymentAcceptance,
  postDeploymentAcceptanceSchema,
} from '../../../src/domain/post-deployment-acceptance.js';

const INPUT = {
  atlTaskId: 'task-20260821-paw003live1',
  eventId: 'paw-goal-003-live-verification-decision-v1',
  headSha: 'a'.repeat(40),
  streamEventId: 'stream-live-accept',
  freshReviewRef: 'TEP-75',
  repository: 'PANGKAIFENG/personal-ai-workbench',
  githubIssue: '22',
  githubPr: '20',
  acceptedAt: '2026-08-21T02:05:00.000Z',
};

describe('postDeploymentAcceptance', () => {
  it('creates a stable identity for the already-published decision binding', () => {
    const first = postDeploymentAcceptance(INPUT);
    const replay = postDeploymentAcceptance(INPUT);

    expect(first).toEqual(replay);
    expect(first.eventType).toBe('POST_DEPLOYMENT_ACCEPTED');
    expect(first.decisionAction).toBe('select:accept');
    expect(first.acceptanceId).toMatch(/^post-deployment-acceptance:/);
  });

  it('rejects a forged acceptance identity', () => {
    const acceptance = postDeploymentAcceptance(INPUT);

    expect(() => postDeploymentAcceptanceSchema.parse({
      ...acceptance,
      acceptanceId: `${acceptance.acceptanceId}-forged`,
    })).toThrow(/acceptanceId must equal the post-deployment identity/);
  });
});
