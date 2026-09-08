import {
  actionRequestForEvent,
  type ActionRequest,
} from '../domain/action-request.js';
import {
  compareMulticaEvents,
  isNotifiableMulticaState,
  MULTICA_COMMENT_OVERLAP_WINDOW_MS,
  parseMulticaEventComment,
  type MulticaEvent,
} from '../domain/multica-event.js';
import {
  isExecutionLinkBound,
  type ExecutionLink,
} from '../domain/execution-link.js';
import { assertTransition, canTransition } from '../domain/transitions.js';
import { isExternalExecutionTask, type Task } from '../domain/task.js';
import type {
  MulticaCommentRecord,
  MulticaRoundtripConnector,
} from '../connectors/multica-cli-connector.js';
import type { ServiceContext } from './service-context.js';

// PAW-GOAL-003 T2 (TECH §5): atomic event ingestion. Comments are read with an
// overlap window, candidates are ordered by occurred_at + comment id + event
// id, and every event completes "dedup -> state validation -> projection ->
// audit -> watermark" inside one task lock. Natural-language comments, wrong
// task/schema, old events and out-of-order terminals only record rejections.
export interface IngestMulticaEventsDependencies {
  connector: MulticaRoundtripConnector;
  /** Sends the stable-key DingTalk notification for notifiable events. */
  notify?: ((input: {
    taskId: string;
    taskTitle: string;
    issueIdentifier: string;
    event: MulticaEvent;
  }) => Promise<{ messageId: string | null }>) | undefined;
}

export interface IngestMulticaEventsOptions {
  /** Re-read the complete comment history for an explicit parser-upgrade recovery. */
  fullScan?: boolean;
}

export interface IngestEventOutcome {
  eventId: string;
  commentId: string;
  state: string;
  action: 'projected' | 'rejected';
  reason: string | null;
}

export interface IngestMulticaEventsSummary {
  status: 'ingested' | 'not_linked';
  since: string | null;
  commentsRead: number;
  outcomes: IngestEventOutcome[];
  notifications: Array<{ eventId: string; messageId: string | null }>;
}

export class MulticaIngestNotAdmittedError extends Error {
  readonly code = 'multica_ingest_not_admitted';

  constructor(message: string) {
    super(message);
    this.name = 'MulticaIngestNotAdmittedError';
  }
}

interface ConsumedLedger {
  consumedEventIds: Set<string>;
  lastConsumed: { occurredAt: string; commentId: string; eventId: string } | null;
}

async function consumedLedgerFor(
  ctx: ServiceContext,
  taskId: string,
): Promise<ConsumedLedger> {
  const events = await ctx.audit.listForTask(taskId);
  const consumedEventIds = new Set<string>();
  let lastConsumed: ConsumedLedger['lastConsumed'] = null;
  for (const event of events) {
    if (event.event !== 'multica.event_consumed') {
      continue;
    }
    const details = event.details ?? {};
    const eventId = typeof details.eventId === 'string' ? details.eventId : null;
    if (eventId === null) {
      continue;
    }
    consumedEventIds.add(eventId);
    const occurredAt = typeof details.occurredAt === 'string'
      ? details.occurredAt
      : '1970-01-01T00:00:00.000Z';
    const commentId = typeof details.commentId === 'string' ? details.commentId : '';
    const candidate = { occurredAt, commentId, eventId };
    if (
      lastConsumed === null
      || compareMulticaEvents(
        { ...EMPTY_EVENT, eventId: candidate.eventId, occurredAt: candidate.occurredAt },
        { ...EMPTY_EVENT, eventId: lastConsumed.eventId, occurredAt: lastConsumed.occurredAt },
        candidate.commentId,
        lastConsumed.commentId,
      ) > 0
    ) {
      lastConsumed = candidate;
    }
  }
  return { consumedEventIds, lastConsumed };
}

const EMPTY_EVENT: MulticaEvent = {
  schemaVersion: 1,
  eventId: '',
  atlTaskId: '',
  state: 'completed',
  summary: '',
  decision: null,
  recoverability: null,
  artifactRefs: [],
  release: null,
  occurredAt: '1970-01-01T00:00:00.000Z',
};

// TEP-50 fix 1 (TECH §6 step 2): the current action_request is replaceable, so
// replacing a HANDLED one must first carry its durable handled-reply evidence
// (stream event id + terminal step) into the retained history — in the same
// task write as the replacement, where a lost audit append cannot erase it.
function retainHandledRequest(task: Task, previous: ActionRequest): Task {
  if (previous.status !== 'handled') {
    return task;
  }
  const existing = task.handledActionRequests ?? [];
  if (existing.some((request) => request.actionId === previous.actionId)) {
    return task;
  }
  return {
    ...task,
    // Newest kept last; the bound drops the oldest retained request.
    handledActionRequests: [...existing, previous].slice(-20),
  };
}

function notificationEventMatchesRequest(
  event: MulticaEvent,
  request: ActionRequest,
  issueIdentifier: string,
): boolean {
  if (event.state !== request.type) {
    return false;
  }
  const projected = actionRequestForEvent(event, issueIdentifier);
  return projected.actionId === request.actionId
    && projected.eventId === request.eventId
    && projected.type === request.type
    && projected.title === request.title
    && projected.summary === request.summary
    && projected.multicaIssue === request.multicaIssue
    && projected.githubPr === request.githubPr
    && projected.headSha === request.headSha
    && projected.allowedActions.length === request.allowedActions.length
    && projected.allowedActions.every((action, index) => action === request.allowedActions[index]);
}

function statusForState(state: MulticaEvent['state']): string {
  switch (state) {
    case 'needs_decision':
      return 'waiting_for_decision';
    case 'blocked':
    case 'failed':
      return 'blocked';
    case 'release_candidate_ready':
    case 'completed':
      return 'review';
    default:
      return 'agent_executable';
  }
}

export async function ingestMulticaEvents(
  ctx: ServiceContext,
  dependencies: IngestMulticaEventsDependencies,
  taskId: string,
  options: IngestMulticaEventsOptions = {},
): Promise<IngestMulticaEventsSummary> {
  const initial = await ctx.tasks.get(taskId);
  if (!isExternalExecutionTask(initial) || !isExecutionLinkBound(initial.executionLink)) {
    return {
      status: 'not_linked',
      since: null,
      commentsRead: 0,
      outcomes: [],
      notifications: [],
    };
  }
  const issueId = initial.executionLink?.issueId ?? '';
  const recoverPendingNotification = dependencies.notify !== undefined
    && initial.actionRequest?.status === 'pending'
    && initial.actionRequest.notificationId === null;
  const fullScan = options.fullScan === true || recoverPendingNotification;

  // Overlap window: re-read from the last sync minus the overlap so a cursor
  // written slightly late cannot drop a comment; dedup handles the rest. A
  // projected action without a notification receipt scans its event back from
  // full history so reconciliation can heal a crash or missing notifier.
  const lastSyncedAt = initial.executionLink?.lastSyncedAt ?? null;
  let since: string | null = null;
  if (!fullScan && lastSyncedAt !== null) {
    const parsed = Date.parse(lastSyncedAt);
    if (Number.isFinite(parsed)) {
      since = new Date(Math.max(0, parsed - MULTICA_COMMENT_OVERLAP_WINDOW_MS))
        .toISOString();
    }
  }
  const page = await dependencies.connector.listComments(
    issueId,
    fullScan
      ? { full: true }
      : (since === null ? undefined : { since }),
  );

  const notifications: IngestMulticaEventsSummary['notifications'] = [];
  const lockResult = await ctx.tasks.withTaskLock(taskId, async (): Promise<{
    outcomes: IngestEventOutcome[];
    notifiable: MulticaEvent[];
  }> => {
    const current = await ctx.tasks.get(taskId);
    if (!isExternalExecutionTask(current)) {
      throw new MulticaIngestNotAdmittedError(`task ${taskId} is not externally executed`);
    }
    const link = current.executionLink ?? null;
    if (!isExecutionLinkBound(link) || link?.issueId !== issueId) {
      throw new MulticaIngestNotAdmittedError(`task ${taskId} is not bound to issue ${issueId}`);
    }

    const ledger = await consumedLedgerFor(ctx, taskId);
    const collected: IngestEventOutcome[] = [];
    const parsedRejections: IngestEventOutcome[] = [];
    const notifiable: MulticaEvent[] = [];
    const queuedNotificationEventIds = new Set<string>();
    const queueNotification = (event: MulticaEvent): void => {
      if (!queuedNotificationEventIds.has(event.eventId)) {
        queuedNotificationEventIds.add(event.eventId);
        notifiable.push(event);
      }
    };

    interface Candidate {
      event: MulticaEvent;
      commentId: string;
    }
    const candidates: Candidate[] = [];
    for (const comment of page.comments as MulticaCommentRecord[]) {
      const parsed = parseMulticaEventComment(comment.commentId, comment.body);
      for (const event of parsed.events) {
        candidates.push({ event, commentId: comment.commentId });
      }
      for (const rejection of parsed.rejections) {
        parsedRejections.push({
          eventId: `${comment.commentId}#${rejection.blockIndex}`,
          commentId: comment.commentId,
          state: 'unparsed',
          action: 'rejected',
          reason: rejection.reason,
        });
      }
    }
    candidates.sort((left, right) => compareMulticaEvents(
      left.event,
      right.event,
      left.commentId,
      right.commentId,
    ));

    let working: Task = { ...current };
    let workingLink: ExecutionLink = { ...(current.executionLink ?? link!) };
    const audits: Array<{ event: MulticaEvent; commentId: string }> = [];
    const superseded: ActionRequest[] = [];
    let projectedAny = false;

    for (const { event, commentId } of candidates) {
      const reason = admissionRejection({
        event,
        taskId,
        issueId,
        link: workingLink,
        ledger,
      });
      if (reason !== null) {
        const pendingRequest = working.actionRequest ?? null;
        if (
          reason === 'duplicate_event'
          && dependencies.notify !== undefined
          && pendingRequest?.status === 'pending'
          && pendingRequest.notificationId === null
          && pendingRequest.eventId === event.eventId
          && isNotifiableMulticaState(event.state)
          && notificationEventMatchesRequest(
            event,
            pendingRequest,
            workingLink.issueIdentifier ?? '',
          )
        ) {
          queueNotification(event);
        }
        collected.push({
          eventId: event.eventId,
          commentId,
          state: event.state,
          action: 'rejected',
          reason,
        });
        continue;
      }

      const target = statusForState(event.state);
      if (
        target !== working.status
        && !canTransition(working.status, target)
      ) {
        collected.push({
          eventId: event.eventId,
          commentId,
          state: event.state,
          action: 'rejected',
          reason: `invalid_transition: ${working.status} -> ${target}`,
        });
        continue;
      }

      if (target !== working.status) {
        assertTransition(working.status, target);
        working = { ...working, status: target };
      }
      const artifactRefs = [...new Set([
        ...workingLink.artifactRefs,
        ...event.artifactRefs,
      ])].slice(0, 50);
      workingLink = {
        ...workingLink,
        remoteState: event.state,
        summary: event.summary,
        lastCommentId: commentId,
        lastEventId: event.eventId,
        artifactRefs,
      };
      const previousRequest = working.actionRequest ?? null;
      if (isNotifiableMulticaState(event.state)) {
        const request = actionRequestForEvent(event, workingLink.issueIdentifier ?? '');
        if (
          previousRequest !== null
          && previousRequest.eventId !== event.eventId
          && previousRequest.status === 'pending'
        ) {
          superseded.push(previousRequest);
        }
        // TEP-50 fix 1: a handled request being replaced — by a newer event or
        // by the same event re-projected after a lost consumption audit — is
        // retained before the replacement overwrites it.

        // TEP-50 fix 1: a handled request being replaced — by a newer event or
        // by the same event re-projected after a lost consumption audit — is
        // retained before the replacement overwrites it.
        if (previousRequest !== null && previousRequest.status === 'handled') {
          working = retainHandledRequest(working, previousRequest);
        }
        // Preserve a notification id already read back for this same event.
        working = {
          ...working,
          actionRequest: previousRequest?.eventId === event.eventId
            ? { ...request, notificationId: previousRequest.notificationId }
            : request,
        };
      } else if (previousRequest !== null && previousRequest.status === 'pending') {
        superseded.push(previousRequest);
        working = { ...working, actionRequest: null };
      }
      ledger.consumedEventIds.add(event.eventId);
      if (
        ledger.lastConsumed === null
        || compareMulticaEvents(
          { ...EMPTY_EVENT, eventId: event.eventId, occurredAt: event.occurredAt },
          { ...EMPTY_EVENT, eventId: ledger.lastConsumed.eventId, occurredAt: ledger.lastConsumed.occurredAt },
          commentId,
          ledger.lastConsumed.commentId,
        ) > 0
      ) {
        ledger.lastConsumed = {
          occurredAt: event.occurredAt,
          commentId,
          eventId: event.eventId,
        };
      }
      audits.push({ event, commentId });
      projectedAny = true;
      if (isNotifiableMulticaState(event.state)) {
        queueNotification(event);
      }
      collected.push({
        eventId: event.eventId,
        commentId,
        state: event.state,
        action: 'projected',
        reason: null,
      });
    }

    if (projectedAny || page.comments.length > 0 || options.fullScan === true) {
      const timestamp = ctx.clock().toISOString();
      // lastCommentId stays on the comment of the last CONSUMED event — that
      // is the thread a trusted reply must answer on (TECH §6.3). Natural
      // language and rejected payloads must never replace that parent.
      workingLink = {
        ...workingLink,
        lastSyncedAt: timestamp,
        lastCommentId: projectedAny
          ? workingLink.lastCommentId
          : (ledger.lastConsumed?.commentId ?? null),
      };
      working = {
        ...working,
        executionLink: workingLink,
        updatedAt: timestamp,
      };
      await ctx.tasks.save(working);
      // Evidence trail: consumption order, supersessions and parse rejections.
      // Failures here never roll back the projection — the watermark and the
      // audit retry path keep the next cycle correct.
      try {
        for (const { event, commentId } of audits) {
          await ctx.audit.append({
            event: 'multica.event_consumed',
            at: ctx.clock().toISOString(),
            taskId,
            details: {
              eventId: event.eventId,
              commentId,
              state: event.state,
              occurredAt: event.occurredAt,
            },
          });
        }
        for (const request of superseded) {
          await ctx.audit.append({
            event: 'multica.action_superseded',
            at: ctx.clock().toISOString(),
            taskId,
            details: {
              actionId: request.actionId,
              eventId: request.eventId,
            },
          });
        }
        for (const rejection of parsedRejections) {
          await ctx.audit.append({
            event: 'multica.event_rejected',
            at: ctx.clock().toISOString(),
            taskId,
            details: {
              eventId: rejection.eventId,
              commentId: rejection.commentId,
              reason: rejection.reason,
            },
          });
        }
      } catch {
        // The audit trail is evidence, not a gate.
      }
    }
    return { outcomes: collected, notifiable };
  });
  const { outcomes } = lockResult;

  // Stable-key notifications run after the projection lock; the ledger makes
  // them exactly-once per (task, event, state) and the message id is written
  // back onto the pending action_request.
  if (dependencies.notify !== undefined) {
    for (const event of lockResult.notifiable) {
      const latest = await ctx.tasks.get(taskId);
      const request = latest.actionRequest ?? null;
      if (
        request === null
        || request.status !== 'pending'
        || request.notificationId !== null
        || !notificationEventMatchesRequest(
          event,
          request,
          latest.executionLink?.issueIdentifier ?? '',
        )
      ) {
        continue;
      }
      const record = await dependencies.notify({
        taskId,
        taskTitle: latest.title,
        issueIdentifier: latest.executionLink?.issueIdentifier ?? '',
        event,
      }).catch(() => null);
      if (record === null) {
        continue;
      }
      notifications.push({ eventId: event.eventId, messageId: record.messageId });
      if (record.messageId !== null) {
        await ctx.tasks.withTaskLock(taskId, async () => {
          const nowTask = await ctx.tasks.get(taskId);
          const request = nowTask.actionRequest ?? null;
          if (request !== null && request.eventId === event.eventId && request.status === 'pending') {
            const timestamp = ctx.clock().toISOString();
            await ctx.tasks.save({
              ...nowTask,
              actionRequest: { ...request, notificationId: record.messageId },
              updatedAt: timestamp,
            });
          }
        });
      }
    }
  }

  return {
    status: 'ingested',
    since,
    commentsRead: page.comments.length,
    outcomes,
    notifications,
  };
}

function admissionRejection(input: {
  event: MulticaEvent;
  taskId: string;
  issueId: string;
  link: ExecutionLink;
  ledger: ConsumedLedger;
}): string | null {
  const { event, taskId, link, ledger } = input;
  if (event.atlTaskId !== taskId) {
    return `task_mismatch: event targets ${event.atlTaskId}`;
  }
  if (
    ledger.consumedEventIds.has(event.eventId)
    || event.eventId === link.lastEventId
  ) {
    return 'duplicate_event';
  }
  if (
    ledger.lastConsumed !== null
    && compareMulticaEvents(
      { ...EMPTY_EVENT, eventId: event.eventId, occurredAt: event.occurredAt },
      { ...EMPTY_EVENT, eventId: ledger.lastConsumed.eventId, occurredAt: ledger.lastConsumed.occurredAt },
      '',
      '',
    ) < 0
  ) {
    return 'stale_event';
  }
  return null;
}
