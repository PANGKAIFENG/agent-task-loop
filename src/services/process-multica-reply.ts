import {
  parseMulticaActionReply,
  validateExternalAction,
  type ActionRequest,
} from '../domain/action-request.js';
import { isExternalExecutionTask, type Task } from '../domain/task.js';
import type {
  MulticaAppendResponseResult,
  MulticaResumeResult,
  MulticaRoundtripConnector,
} from '../connectors/multica-cli-connector.js';
import type { MulticaResponseLedger } from '../storage/file-multica-response-ledger.js';
import type { ServiceContext } from './service-context.js';

// PAW-GOAL-003 T2 (TECH §6): one trusted DingTalk reply walks the four-step
// ledger — received -> atl_recorded -> remote_response_confirmed ->
// supervisor_resumed (or completed_without_resume / release_operator_started).
// Every step is durable before the next external write, retries resume from
// the last confirmed step, and no reply ever duplicates a comment or rerun.
export type MulticaResponseStep =
  | 'received'
  | 'atl_recorded'
  | 'remote_response_confirmed'
  | 'supervisor_resumed'
  | 'completed_without_resume'
  | 'release_operator_started';

export type MulticaTerminalStep =
  | 'supervisor_resumed'
  | 'completed_without_resume'
  | 'release_operator_started';

export interface MulticaResponseLedgerRecord {
  schemaVersion: 1;
  streamEventId: string;
  taskId: string;
  eventId: string | null;
  actionId: string | null;
  action: string;
  message: string;
  trust: {
    senderUserId: string;
    conversationId: string;
    trusted: boolean;
  };
  step: MulticaResponseStep;
  terminalStep: MulticaTerminalStep | null;
  rejectedReason: string | null;
  receivedAt: string;
  recordedAt: string | null;
  confirmedAt: string | null;
  resumedAt: string | null;
  responseCommentId: string | null;
  /**
   * TEP-50 fix 2 (TECH §6.3): the run baseline proven BEFORE the response
   * comment is written. Persisted ahead of `appendResponse` so a retry after
   * an uncertain comment confirmation diffs against the pre-comment baseline —
   * a fresh read would swallow a comment-triggered run and rerun again. Null
   * until the first proven read-back.
   */
  baselineRunIds: string[] | null;
  runIds: string[];
  remoteWriteUnknown: string | null;
  lastError: string | null;
}

export interface MulticaReplyTrustPolicy {
  trustedSenderUserId: string;
  trustedConversationId: string;
}

export interface ProcessMulticaReplyDependencies {
  ledger: MulticaResponseLedger;
  connector: MulticaRoundtripConnector;
  trustPolicy: MulticaReplyTrustPolicy;
}

export interface MulticaReplyInput {
  streamEventId: string;
  senderUserId: string;
  conversationId: string;
  message: string;
}

export type MulticaReplyOutcome =
  | { status: 'completed'; step: MulticaResponseStep; record: MulticaResponseLedgerRecord }
  | { status: 'rejected'; reason: string; record: MulticaResponseLedgerRecord }
  | { status: 'invalid_action'; reason: string; record: MulticaResponseLedgerRecord }
  | { status: 'remote_write_unknown'; reason: string; record: MulticaResponseLedgerRecord }
  | { status: 'duplicate_conflict'; reason: string; record: MulticaResponseLedgerRecord };

const PROGRESS_STEPS: readonly MulticaResponseStep[] = [
  'received',
  'atl_recorded',
  'remote_response_confirmed',
];

export class MulticaReplyInvalidError extends Error {
  readonly code = 'multica_reply_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'MulticaReplyInvalidError';
  }
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });
}

function safeBound(value: string, maxLength: number, field: string): string {
  const trimmed = value.trim();
  if (
    trimmed === ''
    || trimmed.length > maxLength
    || containsControlCharacters(trimmed)
  ) {
    throw new MulticaReplyInvalidError(`Invalid Multica reply ${field}`);
  }
  return trimmed;
}

// Connector exceptions (timeout, unparseable output, budget exhaustion) are
// uncertain remote outcomes, never terminal failures — surface their stable
// code on the ledger's remoteWriteUnknown trail.
function connectorErrorCodeOf(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unexpected_connector_error';
}

// The persisted action_request deterministically encodes everything the
// action matrix needs (option ids from select:* entries, recoverability from
// the rework entry), so the recorded step validates against the projection
// without re-reading the full event from the remote.
function eventProjectionOfRequest(request: ActionRequest): Parameters<typeof validateExternalAction>[0] {
  const optionIds = request.allowedActions
    .filter((action): action is `select:${string}` => action.startsWith('select:'))
    .map((action) => action.slice('select:'.length));
  return {
    schemaVersion: 1,
    eventId: request.eventId,
    atlTaskId: request.actionId.split(':')[1] ?? '',
    state: request.type,
    summary: request.summary,
    decision: optionIds.length > 0
      ? { question: request.title, options: optionIds.map((id) => ({ id, label: id })) }
      : null,
    recoverability: request.type === 'blocked' || request.type === 'failed'
      ? {
        recoverable: request.allowedActions.includes('rework'),
        resumeCondition: request.summary,
        lastSafeStep: request.summary,
      }
      : null,
    artifactRefs: [],
    release: request.type === 'release_candidate_ready'
      ? { repository: null, issue: null, pr: request.githubPr, headSha: request.headSha }
      : null,
    occurredAt: '1970-01-01T00:00:00.000Z',
  };
}

function responseBody(record: {
  taskId: string;
  action: string;
  eventId: string | null;
}): string {
  return [
    'ATL 已记录用户的处理动作。',
    `- action: ${record.action}`,
    `- task: ${record.taskId}`,
    record.eventId === null ? null : `- event: ${record.eventId}`,
  ].filter((line): line is string => line !== null).join('\n');
}

// CR fix 2: deterministic repair evidence for the atl_recorded step. The
// PRIMARY source is the task itself — the handled action_request carries the
// stream event id and the decided terminal step in the same durable write as
// the `handled` transition, so a crash before the audit append (or a failed
// audit append) still heals on retry. TEP-50 fix 1: a newer event may have
// REPLACED that handled request before the retry — the retained
// handled_action_requests history (written atomically with the replacement)
// keeps the evidence reachable. The audit event stays as the last-resort
// secondary source.
async function recordingEvidence(
  ctx: ServiceContext,
  taskId: string,
  streamEventId: string,
): Promise<{
  terminalStep: MulticaTerminalStep | null;
  eventId: string | null;
  actionId: string | null;
} | null> {
  const task = await ctx.tasks.get(taskId);
  const request = task.actionRequest ?? null;
  if (
    request !== null
    && request.status === 'handled'
    && request.handledStreamEventId === streamEventId
  ) {
    return {
      terminalStep: request.handledTerminalStep,
      eventId: request.eventId,
      actionId: request.actionId,
    };
  }
  const retained = (task.handledActionRequests ?? []).find((candidate) => (
    candidate.status === 'handled'
    && candidate.handledStreamEventId === streamEventId
  ));
  if (retained !== undefined) {
    return {
      terminalStep: retained.handledTerminalStep,
      eventId: retained.eventId,
      actionId: retained.actionId,
    };
  }
  const events = await ctx.audit.listForTask(taskId);
  const match = events.find((event) => (
    event.event === 'multica.action_recorded'
    && event.details?.streamEventId === streamEventId
  ));
  if (match === undefined) {
    return null;
  }
  const details = match.details ?? {};
  const action = typeof details.action === 'string' ? details.action : '';
  return {
    terminalStep: details.resumesSupervisor === true
      ? 'supervisor_resumed'
      : action === 'approve'
        ? 'release_operator_started'
        : 'completed_without_resume',
    eventId: typeof details.eventId === 'string' ? details.eventId : null,
    actionId: typeof details.actionId === 'string' ? details.actionId : null,
  };
}

function baseRecord(input: {
  streamEventId: string;
  taskId: string;
  action: string;
  message: string;
  trust: { senderUserId: string; conversationId: string; trusted: boolean };
  receivedAt: string;
  rejectedReason: string | null;
}): MulticaResponseLedgerRecord {
  return {
    schemaVersion: 1,
    streamEventId: input.streamEventId,
    taskId: input.taskId,
    eventId: null,
    actionId: null,
    action: input.action,
    message: input.message,
    trust: input.trust,
    step: 'received',
    terminalStep: null,
    rejectedReason: input.rejectedReason,
    receivedAt: input.receivedAt,
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

export async function processMulticaReply(
  ctx: ServiceContext,
  dependencies: ProcessMulticaReplyDependencies,
  input: MulticaReplyInput,
): Promise<MulticaReplyOutcome> {
  const streamEventId = safeBound(input.streamEventId, 200, 'stream event id');
  const senderUserId = safeBound(input.senderUserId, 200, 'sender');
  const conversationId = safeBound(input.conversationId, 200, 'conversation');
  const message = safeBound(input.message, 2_000, 'message');

  return dependencies.ledger.withLock(async () => {
    const now = () => ctx.clock().toISOString();
    let record = await dependencies.ledger.get(streamEventId);

    // Step 1 — received: global stream-event dedup plus the persisted trust
    // validation result (TECH §6.1). A terminal record replays as-is.
    if (record !== null) {
      if (record.rejectedReason !== null) {
        return { status: 'rejected', reason: record.rejectedReason, record };
      }
      if (
        record.step === 'supervisor_resumed'
        || record.step === 'completed_without_resume'
        || record.step === 'release_operator_started'
      ) {
        return { status: 'completed', step: record.step, record };
      }
    } else {
      const parsedReply = parseMulticaActionReply(message);
      const trusted = senderUserId === dependencies.trustPolicy.trustedSenderUserId
        && conversationId === dependencies.trustPolicy.trustedConversationId;
      if (parsedReply === null) {
        record = baseRecord({
          streamEventId,
          taskId: '',
          action: '',
          message,
          trust: { senderUserId, conversationId, trusted },
          receivedAt: now(),
          rejectedReason: 'unparseable_reply',
        });
        await dependencies.ledger.save(record);
        return { status: 'rejected', reason: 'unparseable_reply', record };
      }
      if (!trusted) {
        record = baseRecord({
          streamEventId,
          taskId: parsedReply.taskId,
          action: parsedReply.action,
          message,
          trust: { senderUserId, conversationId, trusted: false },
          receivedAt: now(),
          rejectedReason: 'untrusted_source',
        });
        await dependencies.ledger.save(record);
        return { status: 'rejected', reason: 'untrusted_source', record };
      }
      record = baseRecord({
        streamEventId,
        taskId: parsedReply.taskId,
        action: parsedReply.action,
        message,
        trust: { senderUserId, conversationId, trusted: true },
        receivedAt: now(),
        rejectedReason: null,
      });
      await dependencies.ledger.save(record);
    }

    if (record.trust.trusted !== true) {
      return { status: 'rejected', reason: record.rejectedReason ?? 'untrusted_source', record };
    }

    // Step 2 — atl_recorded: validate against the current pending
    // action_request, apply the matrix transition, persist under the task
    // lock. The stream-event marker is written with the transition itself, so
    // a crash between the task save and the ledger/audit writes heals on
    // retry instead of degrading to invalid_action.
    if (record.step === 'received') {
      const recorded = await recordAtlStep(ctx, record);
      if (recorded.status === 'invalid') {
        const updated: MulticaResponseLedgerRecord = {
          ...record,
          lastError: recorded.reason.slice(0, 300),
        };
        await dependencies.ledger.save(updated);
        return { status: 'invalid_action', reason: recorded.reason, record: updated };
      }
      record = recorded.record;
      await dependencies.ledger.save(record);
    }

    // Step 3 — remote_response_confirmed: exactly one marker-guarded comment
    // (TECH §6.3). The run baseline is captured before the comment so step 4
    // can tell a comment-triggered run from a missing one.
    if (record.step === 'atl_recorded') {
      const task = await ctx.tasks.get(record.taskId);
      const issueId = task.executionLink?.issueId ?? null;
      if (issueId === null || issueId === '') {
        const reason = 'task is not linked to a Multica issue';
        const updated = { ...record, lastError: reason };
        await dependencies.ledger.save(updated);
        return { status: 'invalid_action', reason, record: updated };
      }
      // CR fix 3: the run baseline must be proven before the comment is
      // written. Degrading a failed read-back to an empty baseline would make
      // step 4 read every existing run as "new" and terminally mark the
      // ledger resumed without a related run — so the failure is preserved as
      // remote_write_unknown and the next cycle reconciles the baseline
      // before any comment/rerun decision.
      //
      // TEP-50 fix 2: the proven baseline is PERSISTED before the comment
      // write and reused verbatim on retry. If the comment landed but its
      // confirmation stayed unknown and a comment-triggered run started, a
      // fresh read-back would fold that run into the baseline and step 4
      // would trigger a duplicate rerun.
      let baselineRunIds: string[] | null = record.baselineRunIds;
      if (baselineRunIds === null) {
        try {
          baselineRunIds = (await dependencies.connector.runIds(issueId)).slice(0, 50);
        } catch (error) {
          const reason = `run baseline read-back: ${connectorErrorCodeOf(error)}`;
          const updated = {
            ...record,
            remoteWriteUnknown: reason.slice(0, 300),
          };
          await dependencies.ledger.save(updated);
          return { status: 'remote_write_unknown', reason, record: updated };
        }
        record = { ...record, baselineRunIds, remoteWriteUnknown: null };
        await dependencies.ledger.save(record);
      }
      let appendResult: MulticaAppendResponseResult;
      try {
        appendResult = await dependencies.connector.appendResponse(issueId, {
          streamEventId: record.streamEventId,
          body: responseBody({
            taskId: record.taskId,
            action: record.action,
            eventId: record.eventId,
          }),
          parentCommentId: task.executionLink?.lastCommentId ?? null,
        });
      } catch (error) {
        const reason = `response comment: ${connectorErrorCodeOf(error)}`;
        const updated = {
          ...record,
          remoteWriteUnknown: reason.slice(0, 300),
        };
        await dependencies.ledger.save(updated);
        return { status: 'remote_write_unknown', reason, record: updated };
      }
      if ('status' in appendResult) {
        const updated = {
          ...record,
          remoteWriteUnknown: appendResult.reason.slice(0, 300),
        };
        await dependencies.ledger.save(updated);
        return {
          status: 'remote_write_unknown',
          reason: appendResult.reason,
          record: updated,
        };
      }
      record = {
        ...record,
        step: 'remote_response_confirmed',
        confirmedAt: now(),
        responseCommentId: appendResult.commentId,
        remoteWriteUnknown: null,
        runIds: baselineRunIds,
      };
      await dependencies.ledger.save(record);
    }

    // Step 4 — supervisor_resumed / completed_without_resume /
    // release_operator_started (TECH §6.4), exactly as decided in step 2.
    if (record.step === 'remote_response_confirmed') {
      const terminal = record.terminalStep ?? 'supervisor_resumed';
      if (terminal !== 'supervisor_resumed') {
        record = {
          ...record,
          step: terminal,
          resumedAt: now(),
          remoteWriteUnknown: null,
          lastError: null,
        };
        await dependencies.ledger.save(record);
        return { status: 'completed', step: terminal, record };
      }

      const task = await ctx.tasks.get(record.taskId);
      const issueId = task.executionLink?.issueId ?? '';
      let resumeResult: MulticaResumeResult;
      try {
        resumeResult = await dependencies.connector.resume(issueId, {
          baselineRunIds: record.runIds,
        });
      } catch (error) {
        const reason = `supervisor resume: ${connectorErrorCodeOf(error)}`;
        const updated = {
          ...record,
          remoteWriteUnknown: reason.slice(0, 300),
        };
        await dependencies.ledger.save(updated);
        return { status: 'remote_write_unknown', reason, record: updated };
      }
      if (resumeResult.status === 'confirmed' || resumeResult.status === 'already_running') {
        record = {
          ...record,
          step: 'supervisor_resumed',
          resumedAt: now(),
          runIds: resumeResult.status === 'confirmed'
            ? resumeResult.newRunIds
            : resumeResult.runIds.slice(0, 50),
          remoteWriteUnknown: null,
          lastError: null,
        };
        await dependencies.ledger.save(record);
        return { status: 'completed', step: 'supervisor_resumed', record };
      }
      if (resumeResult.status === 'duplicate_conflict') {
        const reason = 'duplicate runs observed after the rerun trigger';
        const updated = { ...record, lastError: reason };
        await dependencies.ledger.save(updated);
        return { status: 'duplicate_conflict', reason, record: updated };
      }
      const updated = {
        ...record,
        remoteWriteUnknown: resumeResult.reason.slice(0, 300),
      };
      await dependencies.ledger.save(updated);
      return {
        status: 'remote_write_unknown',
        reason: resumeResult.reason,
        record: updated,
      };
    }

    return { status: 'completed', step: record.step, record };
  });
}

async function recordAtlStep(
  ctx: ServiceContext,
  record: MulticaResponseLedgerRecord,
): Promise<
  | { status: 'ok'; record: MulticaResponseLedgerRecord }
  | { status: 'invalid'; reason: string }
> {
  // Crash heal: the task write landed but the ledger step (and possibly the
  // audit append) did not. The handled action_request — or, after a newer
  // event replaced it, the retained handled history — is the durable marker.
  // TEP-50 fix 1: the ids come from the matched evidence itself, never from
  // the (possibly replaced) current request.
  const evidence = await recordingEvidence(ctx, record.taskId, record.streamEventId);
  if (evidence !== null) {
    return {
      status: 'ok',
      record: {
        ...record,
        step: 'atl_recorded',
        eventId: evidence.eventId ?? record.eventId,
        actionId: evidence.actionId ?? record.actionId,
        terminalStep: evidence.terminalStep,
        recordedAt: ctx.clock().toISOString(),
        lastError: null,
      },
    };
  }

  return ctx.tasks.withTaskLock(record.taskId, async () => {
    const task = await ctx.tasks.get(record.taskId);
    if (!isExternalExecutionTask(task)) {
      return { status: 'invalid', reason: `task ${record.taskId} is not externally executed` };
    }
    const request = task.actionRequest ?? null;
    if (request === null || request.status !== 'pending') {
      return { status: 'invalid', reason: 'no pending action_request on the original task' };
    }
    const verdict = validateExternalAction(
      eventProjectionOfRequest(request),
      request,
      record.action,
      task.status,
    );
    if (verdict.status !== 'ok') {
      return { status: 'invalid', reason: `${verdict.code}: ${verdict.reason}` };
    }
    const timestamp = ctx.clock().toISOString();
    const updatedTask: Task = {
      ...task,
      status: verdict.nextTaskStatus,
      actionRequest: {
        ...request,
        status: 'handled',
        handledStreamEventId: record.streamEventId,
        handledTerminalStep: verdict.terminalStep,
      },
      updatedAt: timestamp,
    };
    // CR fix 2: the stream-event marker is persisted IN this task write —
    // atomically with the `handled` transition — so recovery never depends
    // on the audit append below.
    await ctx.tasks.save(updatedTask);
    try {
      await ctx.audit.append({
        event: 'multica.action_recorded',
        at: timestamp,
        taskId: record.taskId,
        details: {
          streamEventId: record.streamEventId,
          eventId: request.eventId,
          actionId: request.actionId,
          action: record.action,
          nextTaskStatus: verdict.nextTaskStatus,
          resumesSupervisor: verdict.resumesSupervisor,
        },
      });
    } catch {
      // The audit trail is evidence, not a gate: the durable marker lives on
      // the handled action_request saved above.
    }
    return {
      status: 'ok',
      record: {
        ...record,
        step: 'atl_recorded',
        eventId: request.eventId,
        actionId: request.actionId,
        terminalStep: verdict.terminalStep,
        recordedAt: timestamp,
        lastError: null,
      },
    };
  });
}

/**
 * Reconciliation entry (TECH §7): continues every trusted reply that stopped
 * mid-ledger — including remote_write_unknown outcomes — from its last
 * confirmed step. Marker and run-id guards keep the continuation idempotent.
 */
export async function continueMulticaResponses(
  ctx: ServiceContext,
  dependencies: ProcessMulticaReplyDependencies,
  options: { maxResponses?: number } = {},
): Promise<{ processed: number; remaining: number }> {
  const maxResponses = options.maxResponses ?? 10;
  const records = await dependencies.ledger.list();
  const pending = records.filter((record) => (
    record.trust.trusted
    && record.rejectedReason === null
    && PROGRESS_STEPS.includes(record.step)
  ));
  let processed = 0;
  for (const record of pending.slice(0, maxResponses)) {
    processed += 1;
    await processMulticaReply(ctx, dependencies, {
      streamEventId: record.streamEventId,
      senderUserId: record.trust.senderUserId,
      conversationId: record.trust.conversationId,
      message: record.message,
    });
  }
  return { processed, remaining: Math.max(0, pending.length - processed) };
}
