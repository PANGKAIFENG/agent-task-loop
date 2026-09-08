import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  MulticaAppendResponseResult,
  MulticaEnsureIssueResult,
  MulticaIssueSnapshot,
  MulticaCommentPage,
  MulticaResponseDraft,
  MulticaResumeInput,
  MulticaResumeResult,
  MulticaRoundtripConnector,
} from '../../../src/connectors/multica-cli-connector.js';
import {
  continueMulticaResponses,
  processMulticaReply,
  type MulticaReplyOutcome,
  type MulticaResponseLedgerRecord,
} from '../../../src/services/process-multica-reply.js';
import { ingestMulticaEvents } from '../../../src/services/ingest-multica-events.js';
import { FileMulticaResponseLedger } from '../../../src/storage/file-multica-response-ledger.js';
import { actionRequestForEvent } from '../../../src/domain/action-request.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';
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
const SENDER = 'staff-1';
const CONVERSATION = 'cid-1';

class ScriptedRoundtripConnector implements MulticaRoundtripConnector {
  runIdsCalls = 0;
  appendCalls = 0;
  resumeCalls = 0;
  existingMarkers: string[] = [];
  runs = ['run-1'];
  /** Runs started by this connector's rerun trigger (never comment-triggered). */
  rerunRunIds: string[] = [];
  /** Optional scripted override; null runs the real §6.4 diff semantics. */
  resumeOutcome: MulticaResumeResult | null = null;
  appendOutcome: MulticaAppendResponseResult = { commentId: 'c-response', deduplicated: false };
  failureAt: 'append' | 'resume' | null = null;
  failRunIdsReads = 0;

  async ensureIssue(): Promise<MulticaEnsureIssueResult> {
    throw new Error('unused');
  }

  async inspect(): Promise<MulticaIssueSnapshot> {
    throw new Error('unused');
  }

  async listComments(): Promise<MulticaCommentPage> {
    throw new Error('unused');
  }

  async runIds(): Promise<string[]> {
    this.runIdsCalls += 1;
    if (this.failRunIdsReads > 0) {
      this.failRunIdsReads -= 1;
      const error = new Error('read-back lost') as Error & { code: string };
      error.code = 'multica_call_timed_out';
      throw error;
    }
    return [...this.runs];
  }

  async appendResponse(_issueId: string, response: MulticaResponseDraft): Promise<MulticaAppendResponseResult> {
    // Marker scan first: a hit means the comment already exists — no add.
    if (this.existingMarkers.includes(response.streamEventId)) {
      return { commentId: `c-marker-${response.streamEventId}`, deduplicated: true };
    }
    // The add itself lands remotely even when its confirmation is lost.
    this.appendCalls += 1;
    this.existingMarkers.push(response.streamEventId);
    if (this.failureAt === 'append') {
      return { status: 'remote_write_unknown', reason: 'comment add: multica_call_timed_out' };
    }
    return this.appendOutcome;
  }

  async resume(_issueId: string, input: MulticaResumeInput): Promise<MulticaResumeResult> {
    this.resumeCalls += 1;
    if (this.failureAt === 'resume') {
      return { status: 'remote_write_unknown', reason: 'no new run observed after the rerun trigger' };
    }
    if (this.resumeOutcome !== null) {
      return this.resumeOutcome;
    }
    // Real §6.4 semantics: a run outside the caller's baseline is the
    // comment-triggered run — already_running, never a second trigger.
    const baseline = new Set(input.baselineRunIds);
    const alreadyNew = this.runs.filter((runId) => !baseline.has(runId));
    if (alreadyNew.length > 0) {
      return { status: 'already_running', runIds: [...this.runs] };
    }
    const newRunId = `run-rerun-${this.resumeCalls}`;
    this.rerunRunIds.push(newRunId);
    this.runs = [...this.runs, newRunId];
    return { status: 'confirmed', newRunIds: [newRunId] };
  }
}

function needsDecisionEvent(overrides: Partial<MulticaEvent> = {}): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-0001',
    atlTaskId: TASK_ID,
    state: 'needs_decision',
    summary: '选择 synthetic canary 的恢复策略',
    decision: {
      question: '真实 Vault 写入前选择恢复策略',
      options: [{ id: 'retry_with_fixture', label: '使用合成数据重试' }],
    },
    recoverability: null,
    artifactRefs: [],
    release: null,
    occurredAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function linkedExecutionLink(): ExecutionLink {
  return {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: `atl:${TASK_ID}`,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    issueId: ISSUE_ID,
    issueIdentifier: 'TEP-42',
    dispatchState: 'linked',
    remoteState: 'needs_decision',
    lastCommentId: 'c-event',
    lastEventId: 'evt-0001',
    summary: '选择 synthetic canary 的恢复策略',
    artifactRefs: [],
    lastAttemptAt: '2026-08-20T09:00:00.000Z',
    lastSyncedAt: '2026-08-20T10:00:00.000Z',
  };
}

function waitingTask(overrides: Partial<Task> = {}): Task {
  const event = needsDecisionEvent();
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Ship the action roundtrip',
    body: '',
    status: 'waiting_for_decision',
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
    actionRequest: actionRequestForEvent(event, 'TEP-42'),
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

describe('processMulticaReply', () => {
  let harness: TestServiceContext;
  let ledgerRoot: string;
  let ledger: FileMulticaResponseLedger;
  let connector: ScriptedRoundtripConnector;

  const dependencies = () => ({
    ledger,
    connector,
    trustPolicy: { trustedSenderUserId: SENDER, trustedConversationId: CONVERSATION },
  });

  beforeEach(async () => {
    harness = await createTestServiceContext();
    ledgerRoot = await mkdtemp(join(tmpdir(), 'atl-multica-responses-'));
    ledger = new FileMulticaResponseLedger(ledgerRoot);
    connector = new ScriptedRoundtripConnector();
  });

  afterEach(async () => {
    await harness.cleanup();
    await rm(ledgerRoot, { recursive: true, force: true });
  });

  it('walks the four steps for a trusted select reply', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-1',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' ? outcome.step : null).toBe('supervisor_resumed');

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('agent_executable');
    expect(task.actionRequest?.status).toBe('handled');

    const record = await ledger.get('stream-evt-1');
    expect(record?.step).toBe('supervisor_resumed');
    expect(record?.responseCommentId).toBe('c-response');
    expect(record?.runIds).toEqual(['run-rerun-1']);
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
  });

  it('replays a terminal record without repeating comment or rerun', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    const input = {
      streamEventId: 'stream-evt-1',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    };
    await processMulticaReply(harness.ctx, dependencies(), input);
    const replay = await processMulticaReply(harness.ctx, dependencies(), input);

    expect(replay.status).toBe('completed');
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
    const audits = await harness.ctx.audit.listForTask(TASK_ID);
    expect(audits.filter((event) => event.event === 'multica.action_recorded')).toHaveLength(1);
  });

  it('rejects untrusted senders and unparseable replies without any remote write', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());

    const untrusted = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-2',
      senderUserId: 'someone-else',
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(untrusted.status).toBe('rejected');
    expect(connector.appendCalls).toBe(0);

    const unparseable = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-3',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: '随便聊聊',
    });
    expect(unparseable.status).toBe('rejected');
    expect((await ledger.get('stream-evt-3'))?.rejectedReason).toBe('unparseable_reply');
  });

  it('rejects actions the matrix does not allow and leaves the task untouched', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-4',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `approve ${TASK_ID}`,
    });
    expect(outcome.status).toBe('invalid_action');
    expect(connector.appendCalls).toBe(0);
    expect(connector.resumeCalls).toBe(0);

    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.status).toBe('waiting_for_decision');
    expect(task.actionRequest?.status).toBe('pending');
  });

  it('completes block and cancel replies without a rerun', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-5',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `cancel ${TASK_ID}`,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' ? outcome.step : null).toBe('completed_without_resume');
    expect(connector.resumeCalls).toBe(0);
    expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('cancelled');
  });

  it('keeps RC approve in review with a release_operator_started receipt', async () => {
    const rcEvent = needsDecisionEvent({
      eventId: 'evt-rc-1',
      state: 'release_candidate_ready',
      decision: null,
      release: { repository: 'personal-ai-workbench', issue: '12', pr: '13', headSha: 'bb757f2' },
    });
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask({
      status: 'review',
      actionRequest: actionRequestForEvent(rcEvent, 'TEP-42'),
      executionLink: { ...linkedExecutionLink(), lastEventId: 'evt-rc-1' },
    }));

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-6',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `approve ${TASK_ID}`,
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' ? outcome.step : null).toBe('release_operator_started');
    expect((await harness.ctx.tasks.get(TASK_ID)).status).toBe('review');
    expect(connector.resumeCalls).toBe(0);
  });

  it('recovers from a crash after atl_recorded: the reply resumes at the comment step', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    // Simulate: step 2's task write landed but the ledger never advanced.
    const task = await harness.ctx.tasks.get(TASK_ID);
    await harness.ctx.tasks.save({
      ...task,
      status: 'agent_executable',
      actionRequest: task.actionRequest ? { ...task.actionRequest, status: 'handled' } : null,
    });
    await harness.ctx.audit.append({
      event: 'multica.action_recorded',
      at: harness.ctx.clock().toISOString(),
      taskId: TASK_ID,
      details: {
        streamEventId: 'stream-evt-7',
        eventId: 'evt-0001',
        actionId: `action:${TASK_ID}:evt-0001`,
        action: 'select:retry_with_fixture',
        nextTaskStatus: 'agent_executable',
        resumesSupervisor: true,
      },
    });
    await ledger.save({
      schemaVersion: 1,
      streamEventId: 'stream-evt-7',
      taskId: TASK_ID,
      eventId: 'evt-0001',
      actionId: `action:${TASK_ID}:evt-0001`,
      action: 'select:retry_with_fixture',
      message: `select:retry_with_fixture ${TASK_ID}`,
      trust: { senderUserId: SENDER, conversationId: CONVERSATION, trusted: true },
      step: 'received',
      terminalStep: null,
      rejectedReason: null,
      receivedAt: harness.ctx.clock().toISOString(),
      recordedAt: null,
      confirmedAt: null,
      resumedAt: null,
      responseCommentId: null,
      baselineRunIds: null,
      runIds: [],
      remoteWriteUnknown: null,
      lastError: null,
    });

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-7',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(outcome.status).toBe('completed');
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
    const record = await ledger.get('stream-evt-7');
    expect(record?.step).toBe('supervisor_resumed');
  });

  it('does not duplicate the comment when the append outcome was uncertain', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    connector.failureAt = 'append';

    const uncertain = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-8',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(uncertain.status).toBe('remote_write_unknown');
    expect((await ledger.get('stream-evt-8'))?.step).toBe('atl_recorded');

    // Next cycle the marker exists remotely: no second write, straight to resume.
    connector.failureAt = null;
    const recovered = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-8',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(recovered.status).toBe('completed');
    const record = await ledger.get('stream-evt-8');
    expect(record?.responseCommentId).toBe('c-marker-stream-evt-8');
    expect(record?.step).toBe('supervisor_resumed');
    // 1 marker scan miss (uncertain attempt) + 1 marker hit — never two adds.
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
  });

  it('continues mid-ledger replies through the reconciliation entry', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    connector.failureAt = 'resume';
    await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-9',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect((await ledger.get('stream-evt-9'))?.step).toBe('remote_response_confirmed');

    connector.failureAt = null;
    const summary = await continueMulticaResponses(harness.ctx, dependencies());
    expect(summary.processed).toBe(1);
    expect(summary.remaining).toBe(0);
    expect((await ledger.get('stream-evt-9'))?.step).toBe('supervisor_resumed');
    expect(connector.resumeCalls).toBe(2);
  });

  it('reports duplicate runs as a conflict instead of a silent success', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    connector.resumeOutcome = {
      status: 'duplicate_conflict',
      runIds: ['run-1', 'run-2', 'run-3'],
    };
    const outcome: MulticaReplyOutcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-10',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(outcome.status).toBe('duplicate_conflict');
    expect((await ledger.get('stream-evt-10'))?.lastError).toContain('duplicate');
  });

  // T2 CR fix 3: a failed pre-comment run read-back must stay
  // remote_write_unknown — an empty baseline would fabricate supervisor_resumed.
  it('keeps a failed pre-comment run read-back as remote_write_unknown, then reconciles the baseline', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    connector.failRunIdsReads = 1;

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-11',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });

    expect(outcome.status).toBe('remote_write_unknown');
    expect(outcome.status === 'remote_write_unknown' ? outcome.reason : null)
      .toContain('run baseline read-back');
    const record = await ledger.get('stream-evt-11');
    expect(record?.step).toBe('atl_recorded');
    expect(record?.remoteWriteUnknown).toContain('run baseline read-back');
    expect(record?.responseCommentId).toBeNull();
    expect(record?.runIds).toEqual([]);
    expect(connector.appendCalls).toBe(0);
    expect(connector.resumeCalls).toBe(0);

    // Next cycle the read-back works: the baseline is reconciled BEFORE the
    // comment/rerun decisions, and the confirmation is a real run diff.
    const recovered = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-11',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(recovered.status).toBe('completed');
    const finalRecord = await ledger.get('stream-evt-11');
    expect(finalRecord?.step).toBe('supervisor_resumed');
    expect(finalRecord?.runIds).toEqual(['run-rerun-1']);
    expect(finalRecord?.remoteWriteUnknown).toBeNull();
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
  });

  // T2 CR fix 2: the crash window between the task save and the audit append
  // (and the ledger step) must heal from the task-side marker, never degrade
  // to invalid_action.
  it('recovers when the crash happened between the task save and the audit append', async () => {
    // Failure injection: the task write landed — carrying the durable
    // stream-event marker — but neither the audit append nor the ledger step
    // ever ran. The action is `block`, whose terminal step forbids a rerun.
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    const task = await harness.ctx.tasks.get(TASK_ID);
    await harness.ctx.tasks.save({
      ...task,
      status: 'blocked',
      actionRequest: task.actionRequest
        ? {
          ...task.actionRequest,
          status: 'handled',
          handledStreamEventId: 'stream-evt-12',
          handledTerminalStep: 'completed_without_resume',
        }
        : null,
    });
    await ledger.save({
      schemaVersion: 1,
      streamEventId: 'stream-evt-12',
      taskId: TASK_ID,
      eventId: 'evt-0001',
      actionId: `action:${TASK_ID}:evt-0001`,
      action: 'block',
      message: `block ${TASK_ID}`,
      trust: { senderUserId: SENDER, conversationId: CONVERSATION, trusted: true },
      step: 'received',
      terminalStep: null,
      rejectedReason: null,
      receivedAt: harness.ctx.clock().toISOString(),
      recordedAt: null,
      confirmedAt: null,
      resumedAt: null,
      responseCommentId: null,
      baselineRunIds: null,
      runIds: [],
      remoteWriteUnknown: null,
      lastError: null,
    });

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-12',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `block ${TASK_ID}`,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' ? outcome.step : null).toBe('completed_without_resume');
    // The terminal step comes from the task-side marker: no fabricated rerun
    // for an action that must not resume the supervisor.
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(0);
    expect((await ledger.get('stream-evt-12'))?.step).toBe('completed_without_resume');
  });

  // T2 CR fix 2: the audit append is evidence, not a gate — its failure after
  // the task save must not lose the recording.
  it('completes the recording when the audit append fails after the task save', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    const originalAudit = harness.ctx.audit;
    // Delegate through the prototype so only `append` fails; every read
    // (including the secondary evidence scan) keeps working.
    const failingAudit = Object.create(originalAudit) as typeof originalAudit;
    failingAudit.append = async (event: Parameters<typeof originalAudit.append>[0]) => {
      if (event.event === 'multica.action_recorded') {
        throw new Error('disk full');
      }
      return originalAudit.append(event);
    };
    const ctx = { ...harness.ctx, audit: failingAudit };

    const outcome = await processMulticaReply(ctx, dependencies(), {
      streamEventId: 'stream-evt-13',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });

    expect(outcome.status).toBe('completed');
    const task = await harness.ctx.tasks.get(TASK_ID);
    expect(task.actionRequest?.status).toBe('handled');
    expect(task.actionRequest?.handledStreamEventId).toBe('stream-evt-13');
    expect(task.actionRequest?.handledTerminalStep).toBe('supervisor_resumed');
    const audits = await harness.ctx.audit.listForTask(TASK_ID);
    expect(audits.filter((event) => event.event === 'multica.action_recorded')).toHaveLength(0);
  });

  // TEP-50 fix 1: the crash window leaves only the handled Task write behind;
  // a newer event then replaces the handled request before the retry. The
  // retained handled_action_requests history keeps the durable evidence, so
  // the original stream event heals exactly once — never invalid_action and
  // never a handling of the newer request.
  it('heals the original stream event after a newer event replaced the handled request', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    // Failure injection: the handled Task save landed; the audit append and
    // the ledger step save never ran (no multica.action_recorded audit).
    const task = await harness.ctx.tasks.get(TASK_ID);
    await harness.ctx.tasks.save({
      ...task,
      status: 'agent_executable',
      actionRequest: task.actionRequest
        ? {
          ...task.actionRequest,
          status: 'handled',
          handledStreamEventId: 'stream-evt-14',
          handledTerminalStep: 'supervisor_resumed',
        }
        : null,
    });
    // A newer needs_decision event is ingested before the retry. Its options
    // differ from the original event, so the original reply action is illegal
    // for the newer request — without retained evidence this degrades to
    // invalid_action.
    const newerEvent = needsDecisionEvent({
      eventId: 'evt-0002',
      occurredAt: '2026-08-20T12:00:00.000Z',
      decision: {
        question: '第二次决策',
        options: [{ id: 'pause_goal', label: '暂停本 Goal' }],
      },
    });
    const ingestConnector = new (class implements MulticaRoundtripConnector {
      async listComments(): Promise<MulticaCommentPage> {
        return {
          comments: [{
            commentId: 'c-newer',
            parentCommentId: null,
            body: `\`\`\`json\n${JSON.stringify({
              schema_version: 1,
              event_id: newerEvent.eventId,
              atl_task_id: newerEvent.atlTaskId,
              state: newerEvent.state,
              summary: newerEvent.summary,
              decision: newerEvent.decision,
              artifact_refs: [],
              occurred_at: newerEvent.occurredAt,
            })}\n\`\`\``,
            createdAt: newerEvent.occurredAt,
            authorType: 'agent',
          }],
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
        return Promise.resolve([]);
      }
    })();
    const ingestSummary = await ingestMulticaEvents(
      harness.ctx,
      { connector: ingestConnector },
      TASK_ID,
    );
    expect(ingestSummary.outcomes.some((outcome) => outcome.action === 'projected')).toBe(true);

    const superseded = await harness.ctx.tasks.get(TASK_ID);
    expect(superseded.actionRequest?.eventId).toBe('evt-0002');
    expect(superseded.actionRequest?.status).toBe('pending');
    expect(superseded.handledActionRequests ?? []).toEqual([
      expect.objectContaining({
        eventId: 'evt-0001',
        status: 'handled',
        handledStreamEventId: 'stream-evt-14',
        handledTerminalStep: 'supervisor_resumed',
      }),
    ]);

    // The ledger is still at received: the crash ate the step-2 ledger save.
    await ledger.save(receivedRecord(harness.ctx.clock().toISOString(), {
      streamEventId: 'stream-evt-14',
      action: 'select:retry_with_fixture',
      message: `select:retry_with_fixture ${TASK_ID}`,
    }));

    const outcome = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-14',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.status === 'completed' ? outcome.step : null).toBe('supervisor_resumed');
    const record = await ledger.get('stream-evt-14');
    // The heal recovers the ORIGINAL event's ids from the retained evidence,
    // not the newer request that replaced it.
    expect(record?.eventId).toBe('evt-0001');
    expect(record?.actionId).toBe(`action:${TASK_ID}:evt-0001`);
    expect(record?.step).toBe('supervisor_resumed');
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);

    // The newer request stays pending for its own decision cycle.
    const after = await harness.ctx.tasks.get(TASK_ID);
    expect(after.actionRequest?.eventId).toBe('evt-0002');
    expect(after.actionRequest?.status).toBe('pending');

    // Exactly once: replaying the healed stream event changes nothing.
    const replay = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-14',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(replay.status).toBe('completed');
    expect(connector.appendCalls).toBe(1);
    expect(connector.resumeCalls).toBe(1);
  });

  // TEP-50 fix 2: the comment landed and its run started, but the confirmation
  // stayed remote_write_unknown. The retry finds the marker and must diff
  // against the PERSISTED pre-comment baseline — one comment-triggered run,
  // zero duplicate reruns.
  it('reuses the persisted pre-comment baseline when the append confirmation was unknown', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(waitingTask());
    connector.failureAt = 'append';

    const uncertain = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-15',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(uncertain.status).toBe('remote_write_unknown');

    const held = await ledger.get('stream-evt-15');
    // The proven baseline was persisted BEFORE the comment write.
    expect(held?.baselineRunIds).toEqual(['run-1']);
    expect(held?.runIds).toEqual([]);
    expect(held?.step).toBe('atl_recorded');
    expect(connector.appendCalls).toBe(1);

    // The landed comment triggered exactly one remote run before the retry.
    connector.runs = [...connector.runs, 'run-comment-triggered'];
    connector.failureAt = null;

    const recovered = await processMulticaReply(harness.ctx, dependencies(), {
      streamEventId: 'stream-evt-15',
      senderUserId: SENDER,
      conversationId: CONVERSATION,
      message: `select:retry_with_fixture ${TASK_ID}`,
    });
    expect(recovered.status).toBe('completed');
    expect(recovered.status === 'completed' ? recovered.step : null).toBe('supervisor_resumed');

    const record = await ledger.get('stream-evt-15');
    expect(record?.responseCommentId).toBe('c-marker-stream-evt-15');
    expect(record?.remoteWriteUnknown).toBeNull();
    // The comment-triggered run IS the resumed supervisor run.
    expect(record?.runIds).toEqual(['run-1', 'run-comment-triggered']);
    // Marker found: no second comment write.
    expect(connector.appendCalls).toBe(1);
    // Baseline never re-read: the persisted pre-comment baseline was reused.
    expect(connector.runIdsCalls).toBe(1);
    // Zero duplicate reruns: the connector's trigger never fired.
    expect(connector.rerunRunIds).toEqual([]);
  });
});

// Crash-state ledger record for the failure-injection tests: the step-2
// ledger save never ran, so the reply is still at `received`.
function receivedRecord(
  receivedAt: string,
  input: { streamEventId: string; action: string; message: string },
): MulticaResponseLedgerRecord {
  return {
    schemaVersion: 1,
    streamEventId: input.streamEventId,
    taskId: TASK_ID,
    eventId: 'evt-0001',
    actionId: `action:${TASK_ID}:evt-0001`,
    action: input.action,
    message: input.message,
    trust: { senderUserId: SENDER, conversationId: CONVERSATION, trusted: true },
    step: 'received',
    terminalStep: null,
    rejectedReason: null,
    receivedAt,
    recordedAt: null,
    confirmedAt: null,
    resumedAt: null,
    responseCommentId: null,
    baselineRunIds: null,
    runIds: [],
    remoteWriteUnknown: null,
    lastError: null,
  };
}
