import { describe, expect, it } from 'vitest';

import {
  RELEASE_ACTIONS,
  canonicalReleaseActions,
  releaseAcceptanceForApproval,
  releaseAcceptanceId,
  releaseActionsDigest,
  releaseApprovalReadinessGaps,
  releaseCandidateAcceptanceSchema,
  validateReleaseCurrency,
} from '../../../src/domain/release-acceptance.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';

const TASK_ID = 'task-20260821-rel00001';
const HEAD_SHA = 'a'.repeat(40);
const NEW_HEAD_SHA = 'b'.repeat(40);

function rcEvent(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-rc-0001',
    atlTaskId: TASK_ID,
    state: 'release_candidate_ready',
    summary: 'Fresh CR passed on the immutable candidate',
    decision: null,
    recoverability: null,
    artifactRefs: ['docs/HANDOFF/PAW-GOAL-003-T3.md'],
    release: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      issue: 'https://github.com/PANGKAIFENG/personal-ai-workbench/issues/15',
      pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
      headSha: HEAD_SHA,
    },
    occurredAt: '2026-08-21T02:00:00.000Z',
    ...overrides,
  };
}

describe('release acceptance identity', () => {
  it('binds the four fixed release actions in a stable canonical order', () => {
    expect([...RELEASE_ACTIONS]).toEqual([
      'merge_accepted_pr',
      'install_goal_plugin_build',
      'run_synthetic_live_verification',
      'write_and_read_back_release_receipts',
    ]);
    expect(canonicalReleaseActions(['b', 'a', 'b'])).toBe('a\nb');
    // Order of the caller's list cannot change the digest.
    expect(releaseActionsDigest([...RELEASE_ACTIONS].reverse()))
      .toBe(releaseActionsDigest(RELEASE_ACTIONS));
  });

  it('derives the acceptance id from task, event, head SHA and action digest', () => {
    const id = releaseAcceptanceId({
      atlTaskId: TASK_ID,
      eventId: 'evt-rc-0001',
      headSha: HEAD_SHA,
      releaseActions: RELEASE_ACTIONS,
    });
    expect(id).toBe(
      `rc-acceptance:${TASK_ID}:evt-rc-0001:${HEAD_SHA}:${releaseActionsDigest(RELEASE_ACTIONS).slice(0, 16)}`,
    );
    expect(releaseAcceptanceId({
      atlTaskId: TASK_ID,
      eventId: 'evt-rc-0001',
      headSha: NEW_HEAD_SHA,
      releaseActions: RELEASE_ACTIONS,
    })).not.toBe(id);
    expect(releaseAcceptanceId({
      atlTaskId: TASK_ID,
      eventId: 'evt-rc-0002',
      headSha: HEAD_SHA,
      releaseActions: RELEASE_ACTIONS,
    })).not.toBe(id);
  });

  it('builds a valid acceptance from an approved RC event', () => {
    const acceptance = releaseAcceptanceForApproval({
      event: rcEvent(),
      streamEventId: 'stream-approve-0001',
      freshReviewRef: 'TEP-51',
      acceptedAt: '2026-08-21T02:05:00.000Z',
    });
    expect(releaseCandidateAcceptanceSchema.parse(acceptance)).toEqual(acceptance);
    expect(acceptance.githubPr).toContain('/pull/16');
    expect(acceptance.releaseActions).toEqual([...RELEASE_ACTIONS]);
  });

  it('rejects an acceptance whose id or action set was tampered with', () => {
    const acceptance = releaseAcceptanceForApproval({
      event: rcEvent(),
      streamEventId: 'stream-approve-0001',
      freshReviewRef: 'TEP-51',
      acceptedAt: '2026-08-21T02:05:00.000Z',
    });
    expect(() => releaseCandidateAcceptanceSchema.parse({
      ...acceptance,
      headSha: NEW_HEAD_SHA,
    })).toThrow(/acceptanceId/);
    expect(() => releaseCandidateAcceptanceSchema.parse({
      ...acceptance,
      releaseActions: RELEASE_ACTIONS.slice(0, 3),
    })).toThrow(/fixed release actions/);
  });

  it('refuses to build an acceptance from a non-RC event', () => {
    expect(() => releaseAcceptanceForApproval({
      event: rcEvent({ state: 'needs_decision' }),
      streamEventId: 'stream-approve-0001',
      freshReviewRef: 'TEP-51',
      acceptedAt: '2026-08-21T02:05:00.000Z',
    })).toThrow(/release_candidate_ready/);
  });
});


function staleCode(verdict: ReturnType<typeof validateReleaseCurrency>): string {
  expect(verdict.status).toBe('stale');
  return verdict.status === 'stale' ? verdict.code : '';
}

describe('validateReleaseCurrency', () => {
  const acceptance = releaseAcceptanceForApproval({
    event: rcEvent(),
    streamEventId: 'stream-approve-0001',
    freshReviewRef: 'TEP-51',
    acceptedAt: '2026-08-21T02:05:00.000Z',
  });

  it('accepts the same current event, head SHA and action set', () => {
    expect(validateReleaseCurrency(acceptance, rcEvent())).toEqual({ status: 'ok' });
  });

  it('rejects a missing current event as stale', () => {
    expect(staleCode(validateReleaseCurrency(acceptance, null))).toBe('stale_event');
  });

  it('rejects a newer release event as stale_event', () => {
    const verdict = validateReleaseCurrency(
      acceptance,
      rcEvent({ eventId: 'evt-rc-0002', occurredAt: '2026-08-21T03:00:00.000Z' }),
    );
    expect(staleCode(verdict)).toBe('stale_event');
  });

  it('rejects a moved head SHA on the same event as stale_head_sha', () => {
    const verdict = validateReleaseCurrency(
      acceptance,
      rcEvent({
        release: {
          repository: 'PANGKAIFENG/personal-ai-workbench',
          issue: null,
          pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
          headSha: NEW_HEAD_SHA,
        },
      }),
    );
    expect(staleCode(verdict)).toBe('stale_head_sha');
  });

  it('rejects an acceptance whose action set is not the fixed four', () => {
    // The schema itself refuses a non-fixed action set, so the runtime check
    // is exercised with an acceptance from a foreign (unschema'd) source.
    const tampered = {
      ...acceptance,
      releaseActions: RELEASE_ACTIONS.slice(0, 2),
      acceptanceId: releaseAcceptanceId({
        atlTaskId: acceptance.atlTaskId,
        eventId: acceptance.eventId,
        headSha: acceptance.headSha,
        releaseActions: RELEASE_ACTIONS.slice(0, 2),
      }),
    } as typeof acceptance;
    const verdict = validateReleaseCurrency(tampered, rcEvent());
    expect(staleCode(verdict)).toBe('stale_actions');
    expect(() => releaseCandidateAcceptanceSchema.parse(tampered)).toThrow(/fixed release actions/);
  });

  it('rejects a foreign task or a non-release current event', () => {
    const foreign = validateReleaseCurrency(acceptance, rcEvent({
      atlTaskId: 'task-20260821-other999',
    }));
    expect(staleCode(foreign)).toBe('task_mismatch');
    expect(staleCode(validateReleaseCurrency(acceptance, rcEvent({
      state: 'needs_decision',
    })))).toBe('not_release_event');
  });

  it('rejects a current event without repository or PR evidence', () => {
    const noRepo = rcEvent({
      release: {
        repository: null,
        issue: null,
        pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
        headSha: HEAD_SHA,
      },
    });
    expect(staleCode(validateReleaseCurrency(acceptance, noRepo))).toBe('missing_release_evidence');
    const noPr = rcEvent({
      release: {
        repository: 'PANGKAIFENG/personal-ai-workbench',
        issue: null,
        pr: null,
        headSha: HEAD_SHA,
      },
    });
    expect(staleCode(validateReleaseCurrency(acceptance, noPr))).toBe('missing_release_evidence');
  });
});

describe('releaseApprovalReadinessGaps', () => {
  it('is empty for a complete RC event with fresh review and fixed commands', () => {
    expect(releaseApprovalReadinessGaps({
      event: rcEvent(),
      freshReviewRef: 'TEP-51',
      verificationCommands: ['pnpm --dir apps/agent-task-loop test'],
    })).toEqual([]);
  });

  it('reports every missing approve precondition', () => {
    const gaps = releaseApprovalReadinessGaps({
      event: rcEvent({
        release: { repository: null, issue: null, pr: null, headSha: null },
      }),
      freshReviewRef: null,
      verificationCommands: [],
    });
    expect(gaps).toContain('release.repository is required');
    expect(gaps).toContain('release.pr is required');
    expect(gaps).toContain('immutable release.head_sha is required');
    expect(gaps).toContain('fresh independent review reference is required');
    expect(gaps).toContain('fixed verification commands are required');
  });
});
