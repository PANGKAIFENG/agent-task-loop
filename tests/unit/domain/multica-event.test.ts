import { describe, expect, it } from 'vitest';

import {
  compareMulticaEvents,
  MULTICA_COMMENT_OVERLAP_WINDOW_MS,
  MULTICA_EVENT_STATES,
  MULTICA_EVENT_SCHEMA_VERSION,
  multicaEventCommentIdempotencyKey,
  NOTIFIABLE_EVENT_STATES,
  parseMulticaEventComment,
  type MulticaEvent,
} from '../../../src/domain/multica-event.js';

// Wire payloads use the TECH §5 snake_case envelope exactly as a Multica
// comment would carry them.
type RawEvent = Record<string, unknown>;

function rawEvent(overrides: RawEvent = {}): RawEvent {
  return {
    schema_version: 1,
    event_id: 'evt-20260820-0001',
    atl_task_id: 'task-20260820-abc00001',
    state: 'needs_decision',
    summary: '选择 synthetic canary 的恢复策略',
    decision: {
      question: '真实 Vault 写入前选择恢复策略',
      options: [{ id: 'retry_with_fixture', label: '使用合成数据重试' }],
    },
    artifact_refs: [],
    occurred_at: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function fenced(payload: RawEvent): string {
  return `进展说明\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\n后续说明`;
}

describe('multica event schema', () => {
  it('accepts a well-formed needs_decision event with unique option ids', () => {
    const parsed = parseMulticaEventComment('c1', fenced(rawEvent()));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.rejections).toHaveLength(0);
    expect(parsed.events[0]?.eventId).toBe('evt-20260820-0001');
    expect(parsed.events[0]?.decision?.options[0]?.id).toBe('retry_with_fixture');
  });

  it('exposes the version and the allowed state set', () => {
    expect(MULTICA_EVENT_SCHEMA_VERSION).toBe(1);
    expect(MULTICA_EVENT_STATES).toEqual([
      'needs_decision',
      'blocked',
      'release_candidate_ready',
      'failed',
      'completed',
    ]);
    expect(NOTIFIABLE_EVENT_STATES).toEqual([
      'needs_decision',
      'blocked',
      'release_candidate_ready',
      'failed',
    ]);
  });

  it('rejects an unsupported schema version', () => {
    const parsed = parseMulticaEventComment('c1', fenced(rawEvent({ schema_version: 2 })));
    expect(parsed.events).toHaveLength(0);
    expect(parsed.rejections[0]?.reason).toBe('unsupported_schema_version');
  });

  it('rejects an unknown state', () => {
    const parsed = parseMulticaEventComment('c1', fenced(rawEvent({ state: 'in_review' })));
    expect(parsed.rejections[0]?.reason).toBe('invalid_state');
  });

  it('rejects needs_decision without options or with duplicate option ids', () => {
    const empty = parseMulticaEventComment('c1', fenced(rawEvent({
      decision: { question: 'q', options: [] },
    })));
    expect(empty.rejections[0]?.reason).toBe('needs_decision_requires_options');

    const duplicated = parseMulticaEventComment('c1', fenced(rawEvent({
      decision: {
        question: 'q',
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'A2' },
        ],
      },
    })));
    expect(duplicated.rejections[0]?.reason).toBe('needs_decision_requires_options');
  });

  it('rejects blocked or failed events without full recoverability', () => {
    const missing = parseMulticaEventComment('c1', fenced(rawEvent({
      state: 'blocked',
      decision: null,
    })));
    expect(missing.rejections[0]?.reason).toBe('blocked_failed_require_recoverability');

    const partial = parseMulticaEventComment('c1', fenced(rawEvent({
      state: 'failed',
      decision: null,
      recoverability: {
        recoverable: true,
        resume_condition: 'fixture restored',
        last_safe_step: '',
      },
    })));
    expect(partial.rejections[0]?.reason).toBe('blocked_failed_require_recoverability');
  });

  it('rejects release_candidate_ready without an immutable head sha', () => {
    const missing = parseMulticaEventComment('c1', fenced(rawEvent({
      state: 'release_candidate_ready',
      decision: null,
      release: { repository: 'personal-ai-workbench', issue: '12', pr: '13', head_sha: null },
    })));
    expect(missing.rejections[0]?.reason).toBe('release_candidate_requires_head_sha');

    const present = parseMulticaEventComment('c1', fenced(rawEvent({
      state: 'release_candidate_ready',
      decision: null,
      release: { repository: 'personal-ai-workbench', issue: '12', pr: '13', head_sha: 'bb757f2' },
    })));
    expect(present.events).toHaveLength(1);
    expect(present.events[0]?.release?.headSha).toBe('bb757f2');
  });

  it('rejects summaries beyond five lines and control characters', () => {
    const long = parseMulticaEventComment('c1', fenced(rawEvent({
      summary: ['line', 'line', 'line', 'line', 'line', 'line'].join('\n'),
    })));
    expect(long.rejections[0]?.reason).toBe('invalid_multica_event');

    const control = parseMulticaEventComment('c1', fenced(rawEvent({ summary: 'badsummary' })));
    expect(control.rejections[0]?.reason).toBe('invalid_multica_event');
  });

  it('accepts a safe summary spanning up to five lines', () => {
    const summary = [
      'Live verification is ready for a decision.',
      'The ATL task has one Multica binding.',
      'The Goal Contract matches the accepted envelope.',
      'The candidate SHA and plugin version were read back.',
    ].join('\n');

    const parsed = parseMulticaEventComment('c1', fenced(rawEvent({ summary })));

    expect(parsed.rejections).toHaveLength(0);
    expect(parsed.events[0]?.summary).toBe(summary);
  });

  it.each([
    ['carriage return', 'one\rtwo'],
    ['tab', 'one\ttwo'],
    ['C1 next line', 'one\u0085two'],
    ['Unicode line separator', 'one\u2028two'],
    ['Unicode bidi override', 'one\u202Etwo'],
  ])('rejects %s in summaries', (_label, summary) => {
    const parsed = parseMulticaEventComment('c1', fenced(rawEvent({ summary })));

    expect(parsed.events).toHaveLength(0);
    expect(parsed.rejections[0]?.reason).toBe('invalid_multica_event');
  });

  it('ignores natural-language comments and non-json fences entirely', () => {
    const natural = parseMulticaEventComment('c1', '普通进度评论：今天完成了 T2 的 schema 设计。');
    expect(natural.events).toHaveLength(0);
    expect(natural.rejections).toHaveLength(0);

    const notJson = parseMulticaEventComment('c2', '```json\n{not json}\n```');
    expect(notJson.events).toHaveLength(0);
    expect(notJson.rejections[0]?.reason).toBe('unparseable_json_block');
  });

  it('parses multiple events from one comment and reports per-block rejections', () => {
    const body = [
      fenced(rawEvent({ event_id: 'evt-a' })),
      '```json\n{"schema_version":1}\n```',
      fenced(rawEvent({
        event_id: 'evt-b',
        state: 'blocked',
        decision: null,
        recoverability: { recoverable: true, resume_condition: 'r', last_safe_step: 's' },
      })),
    ].join('\n');
    const parsed = parseMulticaEventComment('c1', body);
    expect(parsed.events.map((event) => event.eventId)).toEqual(['evt-a', 'evt-b']);
    expect(parsed.rejections).toHaveLength(1);
    expect(parsed.rejections[0]?.blockIndex).toBe(1);
  });
});

describe('event ordering and dedup keys', () => {
  it('sorts candidates by occurred_at, then comment id, then event id', () => {
    const early: MulticaEvent = {
      schemaVersion: 1,
      eventId: 'evt-b',
      atlTaskId: 'task-20260820-abc00001',
      state: 'needs_decision',
      summary: 's',
      decision: null,
      recoverability: null,
      artifactRefs: [],
      release: null,
      occurredAt: '2026-08-20T09:00:00.000Z',
    };
    const late = { ...early, eventId: 'evt-a', occurredAt: '2026-08-20T10:00:00.000Z' };
    expect([late, early].sort(compareMulticaEvents).map((event) => event.eventId))
      .toEqual(['evt-b', 'evt-a']);

    const same = [
      { event: { ...early, eventId: 'evt-z' }, commentId: 'c2' },
      { event: { ...early, eventId: 'evt-a' }, commentId: 'c1' },
    ].sort((left, right) => compareMulticaEvents(left.event, right.event, left.commentId, right.commentId));
    expect(same.map((entry) => entry.commentId)).toEqual(['c1', 'c2']);
  });

  it('derives a stable notification idempotency key from task, event and state', () => {
    expect(multicaEventCommentIdempotencyKey({
      taskId: 'task-20260820-abc00001',
      eventId: 'evt-20260820-0001',
      state: 'needs_decision',
    })).toBe('multica:task-20260820-abc00001:evt-20260820-0001:needs_decision');
  });

  it('defines a positive comment overlap window for cursor re-reads', () => {
    expect(MULTICA_COMMENT_OVERLAP_WINDOW_MS).toBeGreaterThan(0);
  });
});
