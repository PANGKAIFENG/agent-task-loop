import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MulticaAppendResponseResult,
  MulticaCommentPage,
  MulticaEnsureIssueResult,
  MulticaIssueSnapshot,
  MulticaListCommentsOptions,
  MulticaResumeResult,
  MulticaRoundtripConnector,
} from '../../../src/connectors/multica-cli-connector.js';
import {
  ingestMulticaEvents,
  type IngestMulticaEventsDependencies,
} from '../../../src/services/ingest-multica-events.js';
import type { ExecutionLink } from '../../../src/domain/execution-link.js';
import type { Task } from '../../../src/domain/task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const TASK_ID = 'task-20260820-abc00001';

interface ScriptedComment {
  commentId: string;
  body: string;
  createdAt: string;
  parentCommentId: string | null;
  authorType: string | null;
}

class ScriptedRoundtripConnector implements MulticaRoundtripConnector {
  listCalls = 0;
  lastSince: string | undefined;
  lastFull: boolean | undefined;
  pages: MulticaCommentPage[] = [];

  constructor(private readonly fallback: MulticaCommentPage = { comments: [] }) {}

  async listComments(
    _issueId: string,
    options?: MulticaListCommentsOptions,
  ): Promise<MulticaCommentPage> {
    this.listCalls += 1;
    this.lastSince = options?.since;
    this.lastFull = options?.full;
    return this.pages.shift() ?? this.fallback;
  }

  async ensureIssue(): Promise<MulticaEnsureIssueResult> {
    throw new Error('ensureIssue is not part of the ingestion surface');
  }

  async inspect(): Promise<MulticaIssueSnapshot> {
    throw new Error('inspect is not part of the ingestion surface');
  }

  async appendResponse(): Promise<MulticaAppendResponseResult> {
    throw new Error('appendResponse is not part of the ingestion surface');
  }

  async resume(): Promise<MulticaResumeResult> {
    throw new Error('resume is not part of the ingestion surface');
  }

  async runIds(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

function eventComment(
  commentId: string,
  payload: Record<string, unknown>,
  createdAt = '2026-08-20T10:00:00.000Z',
): ScriptedComment {
  return {
    commentId,
    body: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    createdAt,
    parentCommentId: null,
    authorType: 'agent',
  };
}

function needsDecisionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: 'evt-0001',
    atl_task_id: TASK_ID,
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

function blockedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: 'evt-0002',
    atl_task_id: TASK_ID,
    state: 'blocked',
    summary: '外部依赖不可用，需要人工恢复',
    decision: null,
    recoverability: {
      recoverable: true,
      resume_condition: 'dependency restored',
      last_safe_step: 'dispatch linked',
    },
    artifact_refs: [],
    occurred_at: '2026-08-20T11:00:00.000Z',
    ...overrides,
  };
}

function linkedExecutionLink(overrides: Partial<ExecutionLink> = {}): ExecutionLink {
  return {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: `atl:${TASK_ID}`,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    issueId: ISSUE_ID,
    issueIdentifier: 'TEP-42',
    dispatchState: 'linked',
    remoteState: 'active',
    lastCommentId: null,
    lastEventId: null,
    summary: null,
    artifactRefs: [],
    lastAttemptAt: '2026-08-20T09:00:00.000Z',
    lastSyncedAt: null,
    ...overrides,
  };
}

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Ship the action roundtrip',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Deliver the human action roundtrip',
    acceptanceCriteria: ['One trusted reply reaches the original task exactly once'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    executionLink: linkedExecutionLink(),
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `test:${TASK_ID}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('ingestMulticaEvents', () => {
  let harness: TestServiceContext;

  beforeEach(async () => {
    harness = await createTestServiceContext();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('projects a needs_decision event atomically with an action_request', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        eventComment('c1', needsDecisionPayload()),
        {
          commentId: 'c0',
          body: '普通进度评论，不携带事件。',
          createdAt: '2026-08-20T09:00:00.000Z',
          parentCommentId: null,
          authorType: 'agent',
        },
      ],
    });

    const summary = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect(summary.status).toBe('ingested');
    expect(summary.outcomes).toEqual([
      {
        eventId: 'evt-0001',
        commentId: 'c1',
        state: 'needs_decision',
        action: 'projected',
        reason: null,
      },
    ]);

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('waiting_for_decision');
    expect(task.actionRequest?.eventId).toBe('evt-0001');
    expect(task.actionRequest?.status).toBe('pending');
    expect(task.actionRequest?.allowedActions).toEqual([
      'select:retry_with_fixture',
      'block',
      'cancel',
    ]);
    expect(task.executionLink?.remoteState).toBe('needs_decision');
    expect(task.executionLink?.lastEventId).toBe('evt-0001');
    expect(task.executionLink?.lastSyncedAt).not.toBeNull();
  });

  it('never advances on natural-language comments or issue-only done', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtipOnlyNatural();
    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('agent_executable');
    expect(task.actionRequest ?? null).toBeNull();
    expect(task.executionLink?.lastCommentId).toBeNull();
  });

  it('rejects wrong-task, stale, duplicate and out-of-order terminal events with reasons', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        eventComment('c1', needsDecisionPayload(), '2026-08-20T10:00:00.000Z'),
        eventComment(
          'c2',
          needsDecisionPayload({
            event_id: 'evt-0002',
            atl_task_id: 'task-20260820-other01',
          }),
          '2026-08-20T10:05:00.000Z',
        ),
        eventComment(
          'c3',
          {
            schema_version: 1,
            event_id: 'evt-0003',
            atl_task_id: TASK_ID,
            state: 'completed',
            summary: '终态摘要',
            artifact_refs: [],
            occurred_at: '2026-08-20T10:30:00.000Z',
          },
          '2026-08-20T10:30:00.000Z',
        ),
      ],
    });

    const first = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect(first.outcomes.filter((outcome) => outcome.action === 'projected')).toHaveLength(1);
    const firstReasons = Object.fromEntries(
      first.outcomes.map((outcome) => [outcome.eventId, outcome.reason]),
    );
    expect(firstReasons['evt-0002']).toContain('task_mismatch');
    // completed while waiting_for_decision is an out-of-order terminal — the
    // transition is illegal so the event only records a rejection.
    expect(firstReasons['evt-0003']).toContain('invalid_transition');

    // Second cycle: the overlap window replays the consumed comment and an
    // event older than the consumed watermark arrives late.
    connector.pages.push({
      comments: [
        eventComment('c1', needsDecisionPayload(), '2026-08-20T10:00:00.000Z'),
        eventComment(
          'c4',
          needsDecisionPayload({ event_id: 'evt-0000', occurred_at: '2026-08-20T09:00:00.000Z' }),
          '2026-08-20T09:00:00.000Z',
        ),
      ],
    });
    const second = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    const secondReasons = Object.fromEntries(
      second.outcomes.map((outcome) => [outcome.eventId, outcome.reason]),
    );
    expect(secondReasons['evt-0001']).toBe('duplicate_event');
    expect(secondReasons['evt-0000']).toBe('stale_event');

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('waiting_for_decision');
  });

  it('supersedes the previous pending action_request when a newer notifiable event arrives', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        eventComment('c1', needsDecisionPayload({ event_id: 'evt-0001' }), '2026-08-20T10:00:00.000Z'),
        eventComment('c2', blockedPayload(), '2026-08-20T11:00:00.000Z'),
      ],
    });

    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('blocked');
    expect(task.actionRequest?.eventId).toBe('evt-0002');
    expect(task.actionRequest?.allowedActions).toEqual(['rework', 'block', 'cancel']);

    const audits = await harness.ctx.audit.listForTask(TASK_ID);
    expect(audits.some((event) => (
      event.event === 'multica.action_superseded'
      && event.details?.eventId === 'evt-0001'
    ))).toBe(true);
  });

  // TEP-50 fix 1: replacing a HANDLED request must retain its durable
  // handled-reply evidence — the crash-heal marker lives on that request, and
  // the audit append may never have landed.
  it('retains the handled action_request in the durable history when a newer event replaces it', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      status: 'agent_executable',
      executionLink: linkedExecutionLink({ lastEventId: 'evt-0001' }),
      // The crash window: the handled Task write landed, the audit did not.
      actionRequest: {
        schemaVersion: 1,
        actionId: `action:${TASK_ID}:evt-0001`,
        eventId: 'evt-0001',
        type: 'needs_decision',
        status: 'handled',
        title: '选择恢复策略',
        summary: '选择 synthetic canary 的恢复策略',
        allowedActions: ['select:retry_with_fixture', 'block', 'cancel'],
        multicaIssue: 'TEP-42',
        githubPr: null,
        headSha: null,
        notificationId: null,
        handledStreamEventId: 'stream-evt-crash-1',
        handledTerminalStep: 'supervisor_resumed',
      },
    }));
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        eventComment('c2', blockedPayload(), '2026-08-20T11:00:00.000Z'),
      ],
    });

    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.actionRequest?.eventId).toBe('evt-0002');
    expect(task.actionRequest?.status).toBe('pending');
    // The replaced handled request — with its stream-event marker and decided
    // terminal step — survives in the retained history.
    expect(task.handledActionRequests ?? []).toEqual([
      expect.objectContaining({
        eventId: 'evt-0001',
        status: 'handled',
        handledStreamEventId: 'stream-evt-crash-1',
        handledTerminalStep: 'supervisor_resumed',
      }),
    ]);
  });

  it('re-reads with the overlap window and does not reproject already consumed events', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload())],
    });
    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);

    // Second cycle: the overlap window returns the same comment again.
    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload())],
    });
    const second = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect(connector.lastSince).not.toBeNull();
    expect(second.outcomes[0]?.reason).toBe('duplicate_event');

    const audits = await harness.ctx.audit.listForTask(TASK_ID);
    expect(audits.filter((event) => event.event === 'multica.event_consumed')).toHaveLength(1);
  });

  it('supports an explicit full-history recovery without changing normal ingestion', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      executionLink: linkedExecutionLink({ lastSyncedAt: '2026-08-20T12:00:00.000Z' }),
    }));
    const connector = new ScriptedRoundtripConnector();
    const multilineSummary = [
      'Live verification is ready for a decision.',
      'The ATL task has one Multica binding.',
      'The candidate SHA and plugin version were read back.',
    ].join('\n');
    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload({ summary: multilineSummary }))],
    });

    const summary = await ingestMulticaEvents(
      harness.ctx,
      { connector },
      TASK_ID,
      { fullScan: true },
    );

    expect(connector.lastSince).toBeUndefined();
    expect(connector.lastFull).toBe(true);
    expect(summary.since).toBeNull();
    expect(summary.outcomes[0]?.action).toBe('projected');
    expect((await harness.ctx.tasks.get(TASK_ID)).executionLink?.summary)
      .toBe(multilineSummary);
  });

  it('clears a legacy polluted parent when no consumed audit can prove it', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      executionLink: linkedExecutionLink({
        lastCommentId: 'c-invalid-legacy',
        lastEventId: null,
        lastSyncedAt: '2026-08-20T12:00:00.000Z',
      }),
    }));
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [{
        commentId: 'c-invalid-legacy',
        body: '```json\n{"schema_version":9}\n```',
        createdAt: '2026-08-20T10:00:00.000Z',
        parentCommentId: null,
        authorType: 'agent',
      }],
    });

    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID, { fullScan: true });

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.executionLink?.lastCommentId).toBeNull();
  });

  it('restores the last consumed parent from audit on a duplicate-only full scan', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      status: 'waiting_for_decision',
      executionLink: linkedExecutionLink({
        lastCommentId: 'c-natural-legacy',
        lastEventId: 'evt-0001',
        lastSyncedAt: '2026-08-20T12:00:00.000Z',
      }),
    }));
    await harness.ctx.audit.append({
      event: 'multica.event_consumed',
      at: '2026-08-20T10:00:01.000Z',
      taskId: TASK_ID,
      details: {
        eventId: 'evt-0001',
        commentId: 'c-event-proven',
        state: 'needs_decision',
        occurredAt: '2026-08-20T10:00:00.000Z',
      },
    });
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        eventComment('c-event-proven', needsDecisionPayload()),
        {
          commentId: 'c-natural-legacy',
          body: '普通进展评论。',
          createdAt: '2026-08-20T11:00:00.000Z',
          parentCommentId: null,
          authorType: 'agent',
        },
      ],
    });

    const summary = await ingestMulticaEvents(
      harness.ctx,
      { connector },
      TASK_ID,
      { fullScan: true },
    );

    expect(summary.outcomes[0]?.reason).toBe('duplicate_event');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.executionLink?.lastCommentId).toBe('c-event-proven');
  });

  it('records parse rejections for malformed fenced blocks without projecting', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [
        {
          commentId: 'c1',
          body: '```json\n{"schema_version":9}\n```',
          createdAt: '2026-08-20T10:00:00.000Z',
          parentCommentId: null,
          authorType: 'agent',
        },
      ],
    });
    const summary = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect(summary.outcomes).toHaveLength(0);
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('agent_executable');
    expect(task.executionLink?.lastCommentId).toBeNull();
    const audits = await harness.ctx.audit.listForTask(TASK_ID);
    expect(audits.some((event) => (
      event.event === 'multica.event_rejected'
      && event.details?.reason === 'unsupported_schema_version'
    ))).toBe(true);
  });

  it('returns not_linked for unbound tasks and never calls the remote', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(
      developmentTask({ executionLink: linkedExecutionLink({ issueId: null, dispatchState: 'pending' }) }),
    );
    const connector = new ScriptedRoundtripConnector();
    const summary = await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect(summary.status).toBe('not_linked');
    expect(connector.listCalls).toBe(0);
  });

  it('sends one stable-key notification per notifiable projection and writes back the message id', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload())],
    });
    const notified: string[] = [];
    const dependencies: IngestMulticaEventsDependencies = {
      connector,
      notify: async ({ event }) => {
        notified.push(event.eventId);
        return { messageId: 'ding-msg-42' };
      },
    };

    const summary = await ingestMulticaEvents(harness.ctx, dependencies, TASK_ID);
    expect(notified).toEqual(['evt-0001']);
    expect(summary.notifications).toEqual([{ eventId: 'evt-0001', messageId: 'ding-msg-42' }]);

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.actionRequest?.notificationId).toBe('ding-msg-42');
  });

  it('recovers a missing notification receipt from full history exactly once', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload())],
    });

    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId).toBeNull();

    connector.pages.push({
      comments: [eventComment('c1', needsDecisionPayload())],
    });
    const notified: string[] = [];
    const dependencies: IngestMulticaEventsDependencies = {
      connector,
      notify: async ({ event }) => {
        notified.push(event.eventId);
        return { messageId: 'ding-recovered-42' };
      },
    };
    const recovered = await ingestMulticaEvents(harness.ctx, dependencies, TASK_ID);

    expect(connector.lastSince).toBeUndefined();
    expect(connector.lastFull).toBe(true);
    expect(recovered.outcomes[0]?.reason).toBe('duplicate_event');
    expect(recovered.notifications).toEqual([
      { eventId: 'evt-0001', messageId: 'ding-recovered-42' },
    ]);
    expect(notified).toEqual(['evt-0001']);
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId)
      .toBe('ding-recovered-42');

    connector.pages.push({ comments: [] });
    await ingestMulticaEvents(harness.ctx, dependencies, TASK_ID);
    expect(connector.lastFull).toBeUndefined();
    expect(notified).toEqual(['evt-0001']);
  });

  it('does not recover a notification from a different event state reusing the event id', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({ comments: [eventComment('c1', needsDecisionPayload())] });
    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);

    connector.pages.push({
      comments: [eventComment('c2', {
        schema_version: 1,
        event_id: 'evt-0001',
        atl_task_id: TASK_ID,
        state: 'release_candidate_ready',
        summary: 'Unrelated release candidate',
        artifact_refs: ['docs/TESTS/unrelated.md'],
        release: {
          repository: 'owner/repo',
          issue: '1',
          pr: '2',
          head_sha: 'abc1234',
        },
        occurred_at: '2026-08-20T11:00:00.000Z',
      })],
    });
    const notified: string[] = [];
    const result = await ingestMulticaEvents(harness.ctx, {
      connector,
      notify: async ({ event }) => {
        notified.push(event.state);
        return { messageId: 'should-not-send' };
      },
    }, TASK_ID);

    expect(result.outcomes[0]?.reason).toBe('duplicate_event');
    expect(result.notifications).toEqual([]);
    expect(notified).toEqual([]);
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId).toBeNull();
  });

  it('skips a modified duplicate and recovers from the payload matching the pending request', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
    const connector = new ScriptedRoundtripConnector();
    connector.pages.push({ comments: [eventComment('c1', needsDecisionPayload())] });
    await ingestMulticaEvents(harness.ctx, { connector }, TASK_ID);

    connector.pages.push({
      comments: [
        eventComment('c0', needsDecisionPayload({ summary: 'Modified duplicate summary' })),
        eventComment('c1', needsDecisionPayload()),
      ],
    });
    const notifiedSummaries: string[] = [];
    const result = await ingestMulticaEvents(harness.ctx, {
      connector,
      notify: async ({ event }) => {
        notifiedSummaries.push(event.summary);
        return { messageId: 'ding-recovered-exact' };
      },
    }, TASK_ID);

    expect(result.notifications).toEqual([
      { eventId: 'evt-0001', messageId: 'ding-recovered-exact' },
    ]);
    expect(notifiedSummaries).toEqual(['选择 synthetic canary 的恢复策略']);
    expect((await harness.ctx.tasks.get(TASK_ID)).actionRequest?.notificationId)
      .toBe('ding-recovered-exact');
  });
});

class ScriptedRoundtipOnlyNatural implements MulticaRoundtripConnector {
  async listComments(): Promise<MulticaCommentPage> {
    return {
      comments: [
        {
          commentId: 'c1',
          body: 'issue 已标记 done。',
          createdAt: '2026-08-20T10:00:00.000Z',
          parentCommentId: null,
          authorType: 'agent',
        },
      ],
    };
  }

  async ensureIssue(): Promise<MulticaEnsureIssueResult> {
    throw new Error('unused');
  }

  async inspect(): Promise<MulticaIssueSnapshot> {
    throw new Error('unused');
  }

  async appendResponse(): Promise<MulticaAppendResponseResult> {
    throw new Error('unused');
  }

  async resume(): Promise<MulticaResumeResult> {
    throw new Error('unused');
  }

  async runIds(): Promise<string[]> {
    return [];
  }
}
