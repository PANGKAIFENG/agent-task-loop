import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { MulticaEvent } from './multica-event.js';

// PAW-GOAL-003 T3 (TECH §3.1/§9): the external_delivery acceptance recorded
// for an approved release_candidate_ready event. Its identity is
// atl_task_id + event_id + head_sha + sha256(canonical_release_actions); any
// change to the event, the immutable head SHA, or the authorized action set
// invalidates a previously accepted release and must be rejected as stale.
export const RELEASE_ACCEPTANCE_EVENT_TYPE = 'RELEASE_CANDIDATE_ACCEPTED';

// TECH §3.1 fixes the exact actions an RC approve authorizes — nothing else
// may be executed under a RELEASE_CANDIDATE_ACCEPTED event.
export const RELEASE_ACTIONS = [
  'merge_accepted_pr',
  'install_goal_plugin_build',
  'run_synthetic_live_verification',
  'write_and_read_back_release_receipts',
] as const;

export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];

const SHA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{5,99}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

const safeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed');

// Release references keep the same shape the Multica event allows (URL or
// short ref) — the identity binds the SHA, not the reference formatting.
const nullableSafeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed')
  .nullable();

/**
 * Canonical form of the authorized release actions: unique, sorted, one per
 * line. The digest over this exact byte sequence binds the action set into
 * the acceptance identity, so adding, removing, or reordering authority
 * changes the acceptance id and voids older replies.
 */
export function canonicalReleaseActions(actions: readonly string[]): string {
  return [...new Set(actions)].sort().join('\n');
}

export function releaseActionsDigest(actions: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalReleaseActions(actions), 'utf8')
    .digest('hex');
}

export function releaseAcceptanceId(input: {
  atlTaskId: string;
  eventId: string;
  headSha: string;
  releaseActions: readonly string[];
}): string {
  const digest = releaseActionsDigest(input.releaseActions).slice(0, 16);
  return `rc-acceptance:${input.atlTaskId}:${input.eventId}:${input.headSha}:${digest}`;
}

export interface ReleaseCandidateAcceptance {
  schemaVersion: 1;
  eventType: typeof RELEASE_ACCEPTANCE_EVENT_TYPE;
  acceptanceId: string;
  atlTaskId: string;
  eventId: string;
  headSha: string;
  releaseActions: ReleaseAction[];
  /** The trusted DingTalk stream event whose approve produced this acceptance. */
  streamEventId: string;
  /** Fresh independent CR verdict reference (e.g. the TEP issue identifier). */
  freshReviewRef: string;
  repository: string | null;
  githubIssue: string | null;
  githubPr: string | null;
  acceptedAt: string;
}

const releaseActionSchema = z.enum(RELEASE_ACTIONS);

export const releaseCandidateAcceptanceSchema: z.ZodType<ReleaseCandidateAcceptance> = z
  .object({
    schemaVersion: z.literal(1),
    eventType: z.literal(RELEASE_ACCEPTANCE_EVENT_TYPE),
    acceptanceId: safeText(600),
    atlTaskId: safeText(200),
    eventId: safeText(200),
    headSha: z.string().regex(SHA_PATTERN, 'headSha must look like a git SHA or ref'),
    releaseActions: z.array(releaseActionSchema).min(1).max(4),
    streamEventId: z.string().regex(SAFE_ID_PATTERN),
    freshReviewRef: safeText(200),
    repository: nullableSafeText(300),
    githubIssue: nullableSafeText(100),
    githubPr: nullableSafeText(100),
    acceptedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((acceptance, context) => {
    const expectedId = releaseAcceptanceId({
      atlTaskId: acceptance.atlTaskId,
      eventId: acceptance.eventId,
      headSha: acceptance.headSha,
      releaseActions: acceptance.releaseActions,
    });
    if (acceptance.acceptanceId !== expectedId) {
      context.addIssue({
        code: 'custom',
        message: `acceptanceId must equal the identity digest (${expectedId})`,
      });
    }
    const canonical = canonicalReleaseActions(acceptance.releaseActions);
    if (canonical !== canonicalReleaseActions(RELEASE_ACTIONS)) {
      context.addIssue({
        code: 'custom',
        message: 'releaseActions must be exactly the four fixed release actions',
      });
    }
  });

/**
 * Builds the acceptance for one approved RC event. The release operator later
 * re-validates it against the CURRENT event before any external action, so a
 * newer RC (or a rework that produced a new head SHA) voids this acceptance.
 */
export function releaseAcceptanceForApproval(input: {
  event: MulticaEvent;
  streamEventId: string;
  freshReviewRef: string;
  acceptedAt: string;
}): ReleaseCandidateAcceptance {
  if (input.event.state !== 'release_candidate_ready') {
    throw new Error('Release acceptance requires a release_candidate_ready event');
  }
  const release = input.event.release;
  if (release === null || release.headSha === null) {
    throw new Error('Release acceptance requires an immutable head SHA');
  }
  return releaseCandidateAcceptanceSchema.parse({
    schemaVersion: 1,
    eventType: RELEASE_ACCEPTANCE_EVENT_TYPE,
    acceptanceId: releaseAcceptanceId({
      atlTaskId: input.event.atlTaskId,
      eventId: input.event.eventId,
      headSha: release.headSha,
      releaseActions: RELEASE_ACTIONS,
    }),
    atlTaskId: input.event.atlTaskId,
    eventId: input.event.eventId,
    headSha: release.headSha,
    releaseActions: [...RELEASE_ACTIONS],
    streamEventId: input.streamEventId,
    freshReviewRef: input.freshReviewRef,
    repository: release.repository,
    githubIssue: release.issue,
    githubPr: release.pr,
    acceptedAt: input.acceptedAt,
  });
}

export type ReleaseCurrencyVerdict =
  | { status: 'ok' }
  | {
    status: 'stale';
    code: 'task_mismatch' | 'not_release_event' | 'stale_event' | 'stale_head_sha'
    | 'stale_actions' | 'missing_release_evidence';
    reason: string;
  };

/**
 * Current event/head-SHA validation (TECH §3.1): the acceptance may only be
 * consumed while the remote still presents the SAME release event with the
 * SAME immutable head SHA. Anything else is stale and must not publish.
 */
export function validateReleaseCurrency(
  acceptance: ReleaseCandidateAcceptance,
  currentEvent: MulticaEvent | null,
): ReleaseCurrencyVerdict {
  if (currentEvent === null) {
    return {
      status: 'stale',
      code: 'stale_event',
      reason: `no current release event for task ${acceptance.atlTaskId}`,
    };
  }
  if (currentEvent.atlTaskId !== acceptance.atlTaskId) {
    return {
      status: 'stale',
      code: 'task_mismatch',
      reason: `current event belongs to task ${currentEvent.atlTaskId}`,
    };
  }
  if (currentEvent.state !== 'release_candidate_ready') {
    return {
      status: 'stale',
      code: 'not_release_event',
      reason: `current event state is ${currentEvent.state}, not release_candidate_ready`,
    };
  }
  if (currentEvent.eventId !== acceptance.eventId) {
    return {
      status: 'stale',
      code: 'stale_event',
      reason: (
        `acceptance targets event ${acceptance.eventId}, `
        + `current event is ${currentEvent.eventId}`
      ),
    };
  }
  const currentHeadSha = currentEvent.release?.headSha ?? null;
  if (currentHeadSha === null || currentHeadSha !== acceptance.headSha) {
    return {
      status: 'stale',
      code: 'stale_head_sha',
      reason: (
        `acceptance binds head SHA ${acceptance.headSha}, `
        + `current event binds ${currentHeadSha ?? 'none'}`
      ),
    };
  }
  if (
    canonicalReleaseActions(acceptance.releaseActions)
    !== canonicalReleaseActions(RELEASE_ACTIONS)
  ) {
    return {
      status: 'stale',
      code: 'stale_actions',
      reason: 'authorized action set differs from the fixed release actions',
    };
  }
  const release = currentEvent.release;
  if (release?.repository === null || release?.repository === undefined) {
    return {
      status: 'stale',
      code: 'missing_release_evidence',
      reason: 'current release event declares no repository',
    };
  }
  if (release.pr === null || release.pr === undefined) {
    return {
      status: 'stale',
      code: 'missing_release_evidence',
      reason: 'current release event declares no PR',
    };
  }
  return { status: 'ok' };
}

/**
 * Approve preconditions (TECH §3.1): repo, PR, immutable SHA, fresh CR and a
 * verification summary must be complete before a RELEASE_CANDIDATE_ACCEPTED
 * event may authorize the four fixed release actions.
 */
export function releaseApprovalReadinessGaps(input: {
  event: MulticaEvent;
  freshReviewRef: string | null;
  verificationCommands: readonly string[];
}): string[] {
  const gaps: string[] = [];
  if (input.event.state !== 'release_candidate_ready') {
    gaps.push(`event state must be release_candidate_ready, got ${input.event.state}`);
  }
  const release = input.event.release;
  if (release?.repository == null) gaps.push('release.repository is required');
  if (release?.pr == null) gaps.push('release.pr is required');
  if (release?.headSha == null || release.headSha.trim() === '') {
    gaps.push('immutable release.head_sha is required');
  }
  if (input.freshReviewRef === null || input.freshReviewRef.trim() === '') {
    gaps.push('fresh independent review reference is required');
  }
  if (input.verificationCommands.length === 0) {
    gaps.push('fixed verification commands are required');
  }
  return gaps;
}
