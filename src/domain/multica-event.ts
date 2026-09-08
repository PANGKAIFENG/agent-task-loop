import { z } from 'zod';

// PAW-GOAL-003 T2 (TECH §5): versioned structured Multica events. ATL never
// guesses state from natural language — only fenced JSON blocks carrying this
// schema can move a task, and every rejection records its reason.
export const MULTICA_EVENT_SCHEMA_VERSION = 1;

export const MULTICA_EVENT_STATES = [
  'needs_decision',
  'blocked',
  'release_candidate_ready',
  'failed',
  'completed',
] as const;

// TECH §6: only these states notify the user over DingTalk; `completed` and
// ordinary progress stay in Multica comments.
export const NOTIFIABLE_EVENT_STATES = [
  'needs_decision',
  'blocked',
  'release_candidate_ready',
  'failed',
] as const;

export type MulticaEventState = (typeof MULTICA_EVENT_STATES)[number];
export type NotifiableEventState = (typeof NOTIFIABLE_EVENT_STATES)[number];

// TECH §5: comment increments are re-read with an overlap window so a cursor
// written slightly late cannot drop a comment; dedup is by comment/event id.
export const MULTICA_COMMENT_OVERLAP_WINDOW_MS = 10 * 60 * 1000;

export interface MulticaEventDecision {
  question: string;
  options: Array<{ id: string; label: string }>;
}

export interface MulticaEventRecoverability {
  recoverable: boolean;
  resumeCondition: string;
  lastSafeStep: string;
}

export interface MulticaEventRelease {
  repository: string | null;
  issue: string | null;
  pr: string | null;
  headSha: string | null;
}

export interface MulticaEvent {
  schemaVersion: 1;
  eventId: string;
  atlTaskId: string;
  state: MulticaEventState;
  summary: string;
  decision: MulticaEventDecision | null;
  recoverability: MulticaEventRecoverability | null;
  artifactRefs: string[];
  release: MulticaEventRelease | null;
  occurredAt: string;
}

const UNSAFE_UNICODE_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => !UNSAFE_UNICODE_TEXT_PATTERN.test(character));
}

function hasNoControlCharactersExceptLineFeeds(value: string): boolean {
  return Array.from(value).every((character) => (
    character === '\n' || !UNSAFE_UNICODE_TEXT_PATTERN.test(character)
  ));
}

const safeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed');

const nullableSafeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed')
  .nullable();

// Shape-only validation: option count/uniqueness and per-state completeness
// are admission checks (stateCompletenessReason), so a malformed payload is
// reported with the precise state reason instead of a generic schema error.
const decisionSchema = z.object({
  question: z.string().trim().min(1).max(4_000)
    .refine(hasNoControlCharacters, 'Control characters are not allowed'),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(200)
      .refine(hasNoControlCharacters, 'Control characters are not allowed'),
    label: z.string().trim().min(1).max(2_000)
      .refine(hasNoControlCharacters, 'Control characters are not allowed'),
  }).strict()).max(20),
}).strict();

// TECH §5 wire keys: the envelope and nested objects are snake_case.
const recoverabilitySchema = z.object({
  recoverable: z.boolean(),
  resume_condition: z.string().trim().max(2_000)
    .refine(hasNoControlCharacters, 'Control characters are not allowed'),
  last_safe_step: z.string().trim().max(2_000)
    .refine(hasNoControlCharacters, 'Control characters are not allowed'),
}).strict();

const releaseSchema = z.object({
  repository: nullableSafeText(300),
  issue: nullableSafeText(100),
  pr: nullableSafeText(100),
  head_sha: nullableSafeText(100),
}).strict();

// PRD 4.3.2 keeps the task-level summary to five safe lines; the event carries
// the same bound so projections never store an unbounded transcript.
export const multicaSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    hasNoControlCharactersExceptLineFeeds,
    'Control characters other than line feeds are not allowed',
  )
  .refine(
    (summary) => summary.split('\n').length <= 5,
    'Summary must stay within five lines',
  );

const eventPayloadSchema = z.object({
  schema_version: z.literal(1),
  event_id: safeText(200),
  atl_task_id: safeText(200),
  state: z.enum(MULTICA_EVENT_STATES),
  summary: multicaSummarySchema,
  decision: decisionSchema.nullable().optional(),
  recoverability: recoverabilitySchema.nullable().optional(),
  artifact_refs: z.array(safeText(300)).max(50).default([]),
  release: releaseSchema.nullable().optional(),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();

type MulticaEventPayload = z.infer<typeof eventPayloadSchema>;

function stateCompletenessReason(payload: MulticaEventPayload): string | null {
  if (payload.state === 'needs_decision') {
    const decision = payload.decision ?? null;
    if (
      decision === null
      || decision.options.length === 0
      || new Set(decision.options.map((option) => option.id)).size !== decision.options.length
    ) {
      return 'needs_decision_requires_options';
    }
  }
  if (payload.state === 'blocked' || payload.state === 'failed') {
    const recoverability = payload.recoverability ?? null;
    if (
      recoverability === null
      || recoverability.resume_condition.trim() === ''
      || recoverability.last_safe_step.trim() === ''
    ) {
      return 'blocked_failed_require_recoverability';
    }
  }
  if (payload.state === 'release_candidate_ready') {
    const release = payload.release ?? null;
    if (release === null || release.head_sha === null || release.head_sha.trim() === '') {
      return 'release_candidate_requires_head_sha';
    }
  }
  return null;
}

export interface MulticaEventRejection {
  commentId: string;
  blockIndex: number;
  reason: string;
}

export interface ParsedMulticaEventComment {
  events: MulticaEvent[];
  rejections: MulticaEventRejection[];
}

const FENCED_JSON_PATTERN = /```json\s*([\s\S]*?)```/g;

/**
 * Extracts versioned event blocks from one Multica comment body. Natural
 * language, non-JSON fences, unsupported schema versions and state-incomplete
 * payloads are rejected with a per-block reason — they never project state.
 */
export function parseMulticaEventComment(
  commentId: string,
  body: string,
): ParsedMulticaEventComment {
  const events: MulticaEvent[] = [];
  const rejections: MulticaEventRejection[] = [];
  if (body.length > 200_000) {
    return { events, rejections: [{ commentId, blockIndex: 0, reason: 'comment_too_large' }] };
  }
  const matches = [...body.matchAll(FENCED_JSON_PATTERN)];
  matches.forEach((match, blockIndex) => {
    const raw = match[1] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      rejections.push({ commentId, blockIndex, reason: 'unparseable_json_block' });
      return;
    }
    if (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && 'schema_version' in parsed && parsed.schema_version !== MULTICA_EVENT_SCHEMA_VERSION
    ) {
      rejections.push({ commentId, blockIndex, reason: 'unsupported_schema_version' });
      return;
    }
    const result = eventPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const state = typeof parsed === 'object' && parsed !== null && 'state' in parsed
        && typeof (parsed as { state: unknown }).state === 'string'
        ? (parsed as { state: string }).state
        : null;
      if (state !== null && !MULTICA_EVENT_STATES.includes(state as MulticaEventState)) {
        rejections.push({ commentId, blockIndex, reason: 'invalid_state' });
        return;
      }
      rejections.push({ commentId, blockIndex, reason: 'invalid_multica_event' });
      return;
    }
    const completeness = stateCompletenessReason(result.data);
    if (completeness !== null) {
      rejections.push({ commentId, blockIndex, reason: completeness });
      return;
    }
    events.push({
      schemaVersion: result.data.schema_version,
      eventId: result.data.event_id,
      atlTaskId: result.data.atl_task_id,
      state: result.data.state,
      summary: result.data.summary,
      decision: result.data.decision ?? null,
      recoverability: result.data.recoverability === null || result.data.recoverability === undefined
        ? null
        : {
          recoverable: result.data.recoverability.recoverable,
          resumeCondition: result.data.recoverability.resume_condition,
          lastSafeStep: result.data.recoverability.last_safe_step,
        },
      artifactRefs: result.data.artifact_refs,
      release: result.data.release === null || result.data.release === undefined
        ? null
        : {
          repository: result.data.release.repository,
          issue: result.data.release.issue,
          pr: result.data.release.pr,
          headSha: result.data.release.head_sha,
        },
      occurredAt: result.data.occurred_at,
    });
  });
  return { events, rejections };
}

// TECH §5: candidates are ordered by occurred_at + comment_id + event_id so a
// batch always projects in a deterministic order before per-event admission.
export function compareMulticaEvents(
  left: MulticaEvent,
  right: MulticaEvent,
  leftCommentId = '',
  rightCommentId = '',
): number {
  const timeDelta = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (timeDelta !== 0) return timeDelta;
  if (leftCommentId !== rightCommentId) {
    return leftCommentId < rightCommentId ? -1 : 1;
  }
  if (left.eventId !== right.eventId) {
    return left.eventId < right.eventId ? -1 : 1;
  }
  return 0;
}

export function isNotifiableMulticaState(state: MulticaEventState): state is NotifiableEventState {
  return NOTIFIABLE_EVENT_STATES.includes(state as NotifiableEventState);
}

// TECH §6: the stable notification idempotency key for one event projection.
export function multicaEventCommentIdempotencyKey(input: {
  taskId: string;
  eventId: string;
  state: MulticaEventState;
}): string {
  return `multica:${input.taskId}:${input.eventId}:${input.state}`;
}
