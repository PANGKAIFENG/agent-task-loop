import { describe, expect, it } from 'vitest';

import {
  actionRequestForEvent,
  actionRequestSchema,
  multicaResponseMarker,
  parseExternalAction,
  parseMulticaActionReply,
  validateExternalAction,
  type ActionRequest,
} from '../../../src/domain/action-request.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';

function event(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-20260820-0001',
    atlTaskId: 'task-20260820-abc00001',
    state: 'needs_decision',
    summary: '选择 synthetic canary 的恢复策略',
    decision: {
      question: '真实 Vault 写入前选择恢复策略',
      options: [
        { id: 'retry_with_fixture', label: '使用合成数据重试' },
        { id: 'pause_goal', label: '暂停本 Goal' },
      ],
    },
    recoverability: null,
    artifactRefs: [],
    release: null,
    occurredAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

const RECOVERABLE = {
  recoverable: true,
  resumeCondition: 'fixture restored',
  lastSafeStep: 'dispatch linked',
};

describe('action request projection', () => {
  it('builds a pending action_request with matrix-allowed actions per event', () => {
    const decision = actionRequestForEvent(event(), 'TEP-42');
    expect(decision).toEqual<ActionRequest>({
      schemaVersion: 1,
      actionId: 'action:task-20260820-abc00001:evt-20260820-0001',
      eventId: 'evt-20260820-0001',
      type: 'needs_decision',
      status: 'pending',
      title: '选择恢复策略',
      summary: '选择 synthetic canary 的恢复策略',
      allowedActions: ['select:retry_with_fixture', 'select:pause_goal', 'block', 'cancel'],
      multicaIssue: 'TEP-42',
      githubPr: null,
      headSha: null,
      notificationId: null,
      handledStreamEventId: null,
      handledTerminalStep: null,
    });

    const blocked = actionRequestForEvent(event({
      state: 'blocked',
      decision: null,
      recoverability: RECOVERABLE,
    }), 'TEP-42');
    expect(blocked.allowedActions).toEqual(['rework', 'block', 'cancel']);
    expect(blocked.type).toBe('blocked');

    const unrecoverable = actionRequestForEvent(event({
      state: 'failed',
      decision: null,
      recoverability: { ...RECOVERABLE, recoverable: false },
    }), 'TEP-42');
    expect(unrecoverable.allowedActions).toEqual(['block', 'cancel']);

    const rc = actionRequestForEvent(event({
      state: 'release_candidate_ready',
      decision: null,
      release: { repository: 'personal-ai-workbench', issue: '12', pr: '13', headSha: 'bb757f2' },
    }), 'TEP-42');
    expect(rc.allowedActions).toEqual(['approve', 'rework', 'block', 'cancel']);
    expect(rc.headSha).toBe('bb757f2');
    expect(rc.githubPr).toBe('13');
  });

  it('never offers approve for blocked or failed events', () => {
    const blocked = actionRequestForEvent(event({
      state: 'blocked', decision: null, recoverability: RECOVERABLE,
    }), 'TEP-42');
    expect(blocked.allowedActions).not.toContain('approve');
    const failed = actionRequestForEvent(event({
      state: 'failed', decision: null, recoverability: RECOVERABLE,
    }), 'TEP-42');
    expect(failed.allowedActions).not.toContain('approve');
  });

  it('round-trips through the schema and rejects unsafe values', () => {
    const parsed = actionRequestSchema.parse(actionRequestForEvent(event(), 'TEP-42'));
    expect(parsed.actionId).toBe('action:task-20260820-abc00001:evt-20260820-0001');

    const bad = {
      ...actionRequestForEvent(event(), 'TEP-42'),
      allowedActions: ['approve'],
      type: 'blocked',
    };
    expect(actionRequestSchema.safeParse(bad).success).toBe(true); // shape only
    const control = { ...actionRequestForEvent(event(), 'TEP-42'), title: 'badtitle' };
    expect(actionRequestSchema.safeParse(control).success).toBe(false);
  });

  it('preserves the event multiline summary through action_request projection', () => {
    const summary = [
      'Live verification is ready for a decision.',
      'The task has one Multica binding.',
      'The candidate SHA was read back.',
    ].join('\n');

    expect(actionRequestForEvent(event({ summary }), 'TEP-42').summary).toBe(summary);
    expect(actionRequestSchema.safeParse({
      ...actionRequestForEvent(event(), 'TEP-42'),
      summary: 'one\rtwo',
    }).success).toBe(false);
  });
});

describe('external action matrix', () => {
  it('accepts a valid option selection and resumes the supervisor', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    const verdict = validateExternalAction(event(), request, 'select:retry_with_fixture', 'waiting_for_decision');
    expect(verdict).toMatchObject({
      status: 'ok',
      action: 'select:retry_with_fixture',
      nextTaskStatus: 'agent_executable',
      resumesSupervisor: true,
    });
  });

  it('rejects an option that is not part of the event', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    const verdict = validateExternalAction(event(), request, 'select:unknown_option', 'waiting_for_decision');
    expect(verdict.status).toBe('invalid');
    if (verdict.status === 'invalid') {
      expect(verdict.code).toBe('invalid_external_action');
      expect(verdict.reason).toContain('unknown option');
    }
  });

  it('rejects approve and rework for needs_decision events', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    for (const action of ['approve', 'rework']) {
      const verdict = validateExternalAction(event(), request, action, 'waiting_for_decision');
      expect(verdict.status).toBe('invalid');
    }
  });

  it('allows rework for recoverable blocked/failed and rejects it when unrecoverable', () => {
    const blockedEvent = event({ state: 'blocked', decision: null, recoverability: RECOVERABLE });
    const ok = validateExternalAction(
      blockedEvent,
      actionRequestForEvent(blockedEvent, 'TEP-42'),
      'rework',
      'blocked',
    );
    expect(ok).toMatchObject({ status: 'ok', nextTaskStatus: 'agent_executable', resumesSupervisor: true });

    const failedEvent = event({
      state: 'failed',
      decision: null,
      recoverability: { ...RECOVERABLE, recoverable: false },
    });
    const rejected = validateExternalAction(
      failedEvent,
      actionRequestForEvent(failedEvent, 'TEP-42'),
      'rework',
      'blocked',
    );
    expect(rejected.status).toBe('invalid');
    if (rejected.status === 'invalid') {
      expect(rejected.reason).toContain('not recoverable');
    }
  });

  it('maps block and cancel to their terminal states without rerun', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    const block = validateExternalAction(event(), request, 'block', 'waiting_for_decision');
    expect(block).toMatchObject({ status: 'ok', nextTaskStatus: 'blocked', resumesSupervisor: false });
    const cancel = validateExternalAction(event(), request, 'cancel', 'waiting_for_decision');
    expect(cancel).toMatchObject({ status: 'ok', nextTaskStatus: 'cancelled', resumesSupervisor: false });
  });

  it('keeps review and starts the release operator only on RC approve', () => {
    const rcEvent = event({
      state: 'release_candidate_ready',
      decision: null,
      release: { repository: 'personal-ai-workbench', issue: '12', pr: '13', headSha: 'bb757f2' },
    });
    const request = actionRequestForEvent(rcEvent, 'TEP-42');
    const approve = validateExternalAction(rcEvent, request, 'approve', 'review');
    expect(approve).toMatchObject({
      status: 'ok',
      nextTaskStatus: 'review',
      resumesSupervisor: false,
      terminalStep: 'release_operator_started',
    });
    const rework = validateExternalAction(rcEvent, request, 'rework', 'review');
    expect(rework).toMatchObject({
      status: 'ok',
      nextTaskStatus: 'agent_executable',
      resumesSupervisor: true,
      terminalStep: 'supervisor_resumed',
    });
  });

  it('rejects stale, handled and superseded action requests', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    const handled = validateExternalAction(event(), { ...request, status: 'handled' }, 'block', 'waiting_for_decision');
    expect(handled.status).toBe('invalid');
    if (handled.status === 'invalid') {
      expect(handled.code).toBe('action_request_not_pending');
    }

    const superseded = validateExternalAction(event(), { ...request, status: 'superseded' }, 'block', 'waiting_for_decision');
    expect(superseded.status).toBe('invalid');

    const newerEvent = event({ eventId: 'evt-20260820-0002' });
    const stale = validateExternalAction(newerEvent, request, 'block', 'waiting_for_decision');
    expect(stale.status).toBe('invalid');
    if (stale.status === 'invalid') {
      expect(stale.code).toBe('action_request_superseded');
    }
  });

  it('rejects actions outside the allowed list for the current event', () => {
    const blockedEvent = event({ state: 'blocked', decision: null, recoverability: RECOVERABLE });
    const request = actionRequestForEvent(blockedEvent, 'TEP-42');
    const approve = validateExternalAction(blockedEvent, request, 'approve', 'blocked');
    expect(approve.status).toBe('invalid');
    if (approve.status === 'invalid') {
      expect(approve.reason).toContain('not allowed');
    }
  });

  it('rejects transitions the task state machine does not allow', () => {
    const request = actionRequestForEvent(event(), 'TEP-42');
    const verdict = validateExternalAction(event(), request, 'select:retry_with_fixture', 'done');
    expect(verdict.status).toBe('invalid');
    if (verdict.status === 'invalid') {
      expect(verdict.code).toBe('invalid_task_transition');
    }
  });
});

describe('reply and marker parsing', () => {
  it('parses select/approve/rework/block/cancel actions from raw strings', () => {
    expect(parseExternalAction('select:retry_with_fixture')).toBe('select:retry_with_fixture');
    expect(parseExternalAction('approve')).toBe('approve');
    expect(parseExternalAction(' Approve ')).toBeNull();
    expect(parseExternalAction('deploy')).toBeNull();
    expect(parseExternalAction('select:')).toBeNull();
  });

  it('parses a DingTalk reply carrying task id plus action', () => {
    expect(parseMulticaActionReply('select:retry_with_fixture task-20260820-abc00001'))
      .toEqual({ taskId: 'task-20260820-abc00001', action: 'select:retry_with_fixture' });
    expect(parseMulticaActionReply('approve task-20260820-abc00001'))
      .toEqual({ taskId: 'task-20260820-abc00001', action: 'approve' });
    expect(parseMulticaActionReply('approve')).toBeNull();
    expect(parseMulticaActionReply('approve task-20260820-abc00001 extra')).toBeNull();
    expect(parseMulticaActionReply('')).toBeNull();
  });

  it('derives the stable remote response marker from a stream event id', () => {
    expect(multicaResponseMarker('stream-evt-1')).toBe('[ATL_RESPONSE:stream-evt-1]');
  });
});
