import { z } from 'zod';

import {
  isPostDeploymentAcceptance,
  postDeploymentAcceptanceSchema,
  type PostDeploymentAcceptance,
} from '../domain/post-deployment-acceptance.js';
import {
  releaseCandidateAcceptanceSchema,
  type ReleaseCandidateAcceptance,
} from '../domain/release-acceptance.js';
import type { MulticaEvent } from '../domain/multica-event.js';
import {
  releaseReceiptGaps,
  releasePhaseEvidenceGaps,
  releaseReceiptSchema,
  type ReleaseReadBack,
  type ReleaseReceipt,
} from '../domain/release-receipt.js';
import type { Task } from '../domain/task.js';
import { canTransition } from '../domain/transitions.js';
import type { MulticaActionNotificationLedger } from '../storage/file-multica-action-notification-ledger.js';
import type { MulticaResponseLedger } from '../storage/file-multica-response-ledger.js';
import type { ReleaseReceiptLedger } from '../storage/file-release-receipt-ledger.js';
import type { ServiceContext } from './service-context.js';

export interface PostDeploymentCompletionEvidence {
  schemaVersion: 1;
  acceptance: ReleaseCandidateAcceptance | PostDeploymentAcceptance;
  completedEvent: MulticaEvent;
  receipt: ReleaseReceipt;
}

export interface CompleteReleaseDependencies {
  ledger: ReleaseReceiptLedger;
  completionIntents: ReleaseReceiptLedger;
  phaseEvidence?: ReleaseReceiptLedger;
  notifications: MulticaActionNotificationLedger;
  responses: MulticaResponseLedger;
  atlReadBack(task: Task): ReleaseReadBack['atl'] | Promise<ReleaseReadBack['atl']>;
}

export type CompleteReleaseOutcome =
  | { status: 'completed'; receipt: ReleaseReceipt }
  | { status: 'replayed'; receipt: ReleaseReceipt }
  | { status: 'rejected'; reason: string };

const evidenceEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  acceptance: z.union([
    releaseCandidateAcceptanceSchema,
    postDeploymentAcceptanceSchema,
  ]),
  completedEvent: z.object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1).max(200),
    atlTaskId: z.string().min(1).max(200),
    state: z.literal('completed'),
    summary: z.string().min(1).max(2_000),
    decision: z.null(),
    recoverability: z.null(),
    artifactRefs: z.array(z.string().min(1).max(300)).max(50),
    release: z.null(),
    occurredAt: z.string().datetime({ offset: true }),
  }).strict(),
  receipt: releaseReceiptSchema,
}).strict();

export function parsePostDeploymentCompletionEvidence(
  input: unknown,
): PostDeploymentCompletionEvidence {
  return evidenceEnvelopeSchema.parse(input);
}

function sameReceipt(left: ReleaseReceipt, right: ReleaseReceipt): boolean {
  return JSON.stringify(releaseReceiptSchema.parse(left))
    === JSON.stringify(releaseReceiptSchema.parse(right));
}

function sameCompletionLineage(intent: ReleaseReceipt, finalReceipt: ReleaseReceipt): boolean {
  const normalize = (receipt: ReleaseReceipt, expectedStatus: 'review' | 'done') => {
    const parsed = releaseReceiptSchema.parse(receipt);
    const atl = parsed.readBack?.atl;
    if (atl === undefined || atl.taskStatus !== expectedStatus) return null;
    return {
      ...parsed,
      readBack: {
        ...parsed.readBack,
        atl: {
          taskId: atl.taskId,
          finalSummary: atl.finalSummary,
        },
      },
    };
  };
  const normalizedIntent = normalize(intent, 'review');
  const normalizedFinal = normalize(finalReceipt, 'done');
  return normalizedIntent !== null
    && normalizedFinal !== null
    && JSON.stringify(normalizedIntent) === JSON.stringify(normalizedFinal);
}

function sameReleasePhase(left: ReleaseReceipt, right: ReleaseReceipt): boolean {
  const normalize = (receipt: ReleaseReceipt) => ({
    ...releaseReceiptSchema.parse(receipt),
    completedAt: null,
    postDeployment: undefined,
    readBack: receipt.readBack === null
      ? null
      : { ...receipt.readBack, atl: null },
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function completionGaps(
  task: Task,
  evidence: PostDeploymentCompletionEvidence,
  notification: Awaited<ReturnType<MulticaActionNotificationLedger['get']>>,
  response: Awaited<ReturnType<MulticaResponseLedger['get']>>,
  expectedAtlTaskStatus: 'review' | 'done',
): string[] {
  const { acceptance, completedEvent, receipt } = evidence;
  // The caller supplies a factual receipt. For the normal review path this is
  // the pre-transition read-back; the service derives a projected `done`
  // read-back before persisting the immutable final receipt, then persists the
  // task projection only after that receipt is confirmed.
  const gaps = isPostDeploymentAcceptance(acceptance)
    ? releaseReceiptGaps(receipt, acceptance, { expectedAtlTaskStatus })
    : releasePhaseEvidenceGaps(receipt, acceptance);
  const completion = receipt.postDeployment;
  const link = task.executionLink;
  const action = task.actionRequest;
  const alreadyPublished = isPostDeploymentAcceptance(acceptance);

  if (receipt.readBack?.atl.taskStatus !== expectedAtlTaskStatus) {
    gaps.push(`completion evidence ATL read-back must describe the current ${expectedAtlTaskStatus} state`);
  }

  if (acceptance.atlTaskId !== task.taskId || receipt.atlTaskId !== task.taskId) {
    gaps.push('acceptance and receipt must bind the current ATL task');
  }
  if (completedEvent.atlTaskId !== task.taskId) {
    gaps.push('current Multica event must bind the current ATL task');
  }
  if (
    link === null
    || link === undefined
    || link.issueId === null
    || link.issueIdentifier === null
    || link.remoteState !== 'completed'
    || link.lastEventId !== completedEvent.eventId
  ) {
    gaps.push('ATL execution link must bind the completed Multica issue and event');
  }
  if (alreadyPublished) {
    if (
      action === null
      || action === undefined
      || action.type !== 'needs_decision'
      || action.status !== 'handled'
      || action.eventId !== acceptance.eventId
      || action.headSha !== null
      || action.githubPr !== null
      || !action.allowedActions.includes('select:accept')
      || action.handledStreamEventId !== acceptance.streamEventId
      || action.handledTerminalStep !== 'supervisor_resumed'
    ) {
      gaps.push('handled post-deployment decision must match the already-published acceptance');
    }
  } else if (
    action === null
    || action === undefined
    || action.type !== 'release_candidate_ready'
    || action.status !== 'handled'
    || action.eventId !== acceptance.eventId
    || action.headSha !== acceptance.headSha
    || action.githubPr !== acceptance.githubPr
    || action.handledStreamEventId !== acceptance.streamEventId
    || action.handledTerminalStep !== 'release_operator_started'
  ) {
    gaps.push('handled release approval must match the accepted RC evidence');
  }
  if (completion === undefined) {
    gaps.push('post-deployment completion evidence is required');
    return gaps;
  }
  if (
    completion.completedEventId !== completedEvent.eventId
    || completion.completedEventOccurredAt !== completedEvent.occurredAt
  ) {
    gaps.push('post-deployment evidence must bind the current completed event');
  }
  if (
    link?.issueId !== completion.multicaIssueId
    || link?.issueIdentifier !== completion.multicaIssueIdentifier
  ) {
    gaps.push('post-deployment evidence must bind the terminal Multica issue state');
  }
  const expectedNotificationState = alreadyPublished ? 'needs_decision' : 'release_candidate_ready';
  const expectedNotificationKey = `multica:${task.taskId}:${acceptance.eventId}:${expectedNotificationState}`;
  if (
    completion.notificationLedgerKey !== expectedNotificationKey
    || completion.notificationMessageId !== action?.notificationId
  ) {
    gaps.push('trusted DingTalk notification ledger evidence is missing or conflicting');
  }
  if (
    notification === null
    || notification.status !== 'sent'
    || notification.taskId !== task.taskId
    || notification.eventId !== acceptance.eventId
    || notification.state !== expectedNotificationState
    || notification.messageId !== completion.notificationMessageId
  ) {
    gaps.push('trusted DingTalk notification ledger record is missing or conflicting');
  }
  if (
    completion.responseLedgerStreamEventId !== acceptance.streamEventId
    || completion.responseLedgerStreamEventId !== action?.handledStreamEventId
    || completion.responseLedgerStreamEventId !== receipt.readBack?.dingtalk.streamEventId
  ) {
    gaps.push('trusted DingTalk response ledger evidence is missing or conflicting');
  }
  const expectedResponseStep = alreadyPublished ? 'supervisor_resumed' : 'release_operator_started';
  const expectedResponseAction = alreadyPublished ? 'select:accept' : 'approve';
  if (
    response === null
    || !response.trust.trusted
    || response.taskId !== task.taskId
    || response.eventId !== acceptance.eventId
    || response.action !== expectedResponseAction
    || response.step !== expectedResponseStep
    || response.terminalStep !== expectedResponseStep
    || response.responseCommentId !== completion.responseCommentId
    || (alreadyPublished && response.receivedAt !== acceptance.acceptedAt)
  ) {
    gaps.push('trusted DingTalk response ledger record is missing or conflicting');
  }
  if (completion.independentReviewRef !== acceptance.freshReviewRef) {
    gaps.push('independent CR reference differs from the accepted release');
  }
  if (
    completion.receiptMetadataKey !== receipt.readBack?.multica.receiptMetadataKey
    || completion.receiptMetadataValue !== receipt.readBack?.multica.receiptMetadataValue
  ) {
    gaps.push('stable Multica receipt metadata read-back is missing or conflicting');
  }
  let metadataReceiptId: string | null = null;
  try {
    const metadata = JSON.parse(completion.receiptMetadataValue) as {
      schema_version?: unknown;
      receipt_id?: unknown;
    };
    if (metadata.schema_version === 1 && typeof metadata.receipt_id === 'string') {
      metadataReceiptId = metadata.receipt_id;
    }
  } catch {
    metadataReceiptId = null;
  }
  if (metadataReceiptId !== receipt.receiptId) {
    gaps.push('stable Multica receipt metadata must bind the immutable receipt id');
  }
  if (
    Date.parse(completion.readAt) < Date.parse(completedEvent.occurredAt)
    || Date.parse(receipt.completedAt) < Date.parse(completion.readAt)
  ) {
    gaps.push('post-deployment evidence is stale');
  }
  return gaps;
}

function completedTask(task: Task, completedAt: string): Task {
  if (task.status !== 'review' || !canTransition(task.status, 'done')) {
    throw new Error(`post-deployment completion requires task in review, found ${task.status}`);
  }
  return { ...task, status: 'done', updatedAt: completedAt };
}

export async function completeRelease(
  ctx: ServiceContext,
  dependencies: CompleteReleaseDependencies,
  rawEvidence: PostDeploymentCompletionEvidence,
): Promise<CompleteReleaseOutcome> {
  const evidence = parsePostDeploymentCompletionEvidence(rawEvidence);
  return ctx.tasks.withTaskLock(evidence.acceptance.atlTaskId, async () => {
    const task = await ctx.tasks.get(evidence.acceptance.atlTaskId);
    const phase = dependencies.phaseEvidence === undefined
      ? null
      : await dependencies.phaseEvidence.get(evidence.acceptance.acceptanceId);
    const alreadyPublished = isPostDeploymentAcceptance(evidence.acceptance);
    if (!alreadyPublished && dependencies.phaseEvidence !== undefined && phase === null) {
      return { status: 'rejected', reason: 'release-phase evidence is missing' };
    }
    if (alreadyPublished && phase !== null) {
      return { status: 'rejected', reason: 'already-published completion must not consume release-phase evidence' };
    }
    if (phase !== null && !sameReleasePhase(phase, evidence.receipt)) {
      return { status: 'rejected', reason: 'post-deployment receipt conflicts with release-phase evidence' };
    }
    const receipt = evidence.receipt;
    const completion = receipt.postDeployment;
    const [notification, response] = completion === undefined
      ? [null, null]
      : await Promise.all([
        dependencies.notifications.get(completion.notificationLedgerKey),
        dependencies.responses.get(completion.responseLedgerStreamEventId),
      ]);
    const acceptanceId = evidence.acceptance.acceptanceId;
    const [intent, existing] = await Promise.all([
      dependencies.completionIntents.get(acceptanceId),
      dependencies.ledger.get(acceptanceId),
    ]);
    if (intent !== null && !sameReceipt(intent, receipt)) {
      return {
        status: 'rejected',
        reason: `immutable completion intent conflict for ${acceptanceId}`,
      };
    }
    if (intent !== null && existing !== null && !sameCompletionLineage(intent, existing)) {
      return {
        status: 'rejected',
        reason: `completion intent and final release receipt conflict for ${acceptanceId}`,
      };
    }
    if (task.status !== 'review' && task.status !== 'done') {
      return {
        status: 'rejected',
        reason: `post-deployment completion requires task in review, found ${task.status}`,
      };
    }

    const intentEvidence = intent === null
      ? evidence
      : { ...evidence, receipt: intent };
    const legacyReceiptOnly = task.status === 'review'
      && intent === null
      && existing !== null;
    const reviewGaps = task.status === 'review' && !legacyReceiptOnly
      ? completionGaps(task, intentEvidence, notification, response, 'review')
      : [];
    if (reviewGaps.length > 0) {
      return { status: 'rejected', reason: reviewGaps.join('; ').slice(0, 2_000) };
    }

    // A receipt written by the previous implementation is a valid immutable
    // terminal record. Permit exact replay even though it has no intent row.
    if (task.status === 'done' && existing !== null && intent === null) {
      if (!sameReceipt(existing, receipt)) {
        return {
          status: 'rejected',
          reason: `legacy immutable release receipt conflict for ${acceptanceId}`,
        };
      }
      if (existing.readBack?.atl.taskStatus !== 'done') {
        return {
          status: 'rejected',
          reason: 'legacy done task requires a done-shaped immutable release receipt',
        };
      }
      const legacyGaps = completionGaps(
        task,
        { ...evidence, receipt: existing },
        notification,
        response,
        'done',
      );
      if (legacyGaps.length > 0) {
        return { status: 'rejected', reason: legacyGaps.join('; ').slice(0, 2_000) };
      }
      let currentAtl: ReleaseReadBack['atl'];
      try {
        currentAtl = await dependencies.atlReadBack(task);
      } catch (error) {
        return { status: 'rejected', reason: `ATL read-back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
      if (existing.readBack?.atl === null || existing.readBack?.atl === undefined
        || JSON.stringify(existing.readBack.atl) !== JSON.stringify(currentAtl)) {
        return { status: 'rejected', reason: 'legacy immutable release receipt ATL read-back conflicts with the current task' };
      }
      return { status: 'replayed', receipt: existing };
    }

    if (task.status === 'done' && existing !== null) {
      const finalGaps = completionGaps(
        task,
        { ...evidence, receipt: existing },
        notification,
        response,
        'done',
      );
      if (finalGaps.length > 0) {
        return { status: 'rejected', reason: finalGaps.join('; ').slice(0, 2_000) };
      }
      let currentAtl: ReleaseReadBack['atl'];
      try {
        currentAtl = await dependencies.atlReadBack(task);
      } catch (error) {
        return { status: 'rejected', reason: `ATL read-back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
      if (existing.readBack?.atl === null || existing.readBack?.atl === undefined
        || JSON.stringify(existing.readBack.atl) !== JSON.stringify(currentAtl)) {
        return { status: 'rejected', reason: 'immutable release receipt ATL read-back conflicts with the current task' };
      }
      return { status: 'replayed', receipt: existing };
    }

    if (task.status === 'review' && existing !== null) {
      if (intent === null) {
        // The pre-intent implementation persisted the final done-shaped
        // receipt before projecting the task. Recover that exact crash window
        // without rewriting the immutable legacy row or synthesizing an intent.
        if (!sameReceipt(existing, receipt)) {
          return {
            status: 'rejected',
            reason: `legacy immutable release receipt conflict for ${acceptanceId}`,
          };
        }
        const finalGaps = completionGaps(
          task,
          { ...evidence, receipt: existing },
          notification,
          response,
          'done',
        );
        if (finalGaps.length > 0) {
          return { status: 'rejected', reason: finalGaps.join('; ').slice(0, 2_000) };
        }
        const projected = completedTask(task, existing.completedAt);
        let currentAtl: ReleaseReadBack['atl'];
        try {
          currentAtl = await dependencies.atlReadBack(projected);
        } catch (error) {
          return { status: 'rejected', reason: `ATL read-back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
        }
        if (existing.readBack?.atl === null || existing.readBack?.atl === undefined
          || JSON.stringify(existing.readBack.atl) !== JSON.stringify(currentAtl)) {
          return { status: 'rejected', reason: 'legacy immutable release receipt ATL read-back conflicts with the current task' };
        }
        try {
          const persistedTask = await ctx.tasks.save(projected);
          if (persistedTask.status !== 'done') {
            return { status: 'rejected', reason: `post-deployment task projection did not persist, found ${persistedTask.status}` };
          }
        } catch (error) {
          const recovered = await ctx.tasks.get(task.taskId).catch(() => null);
          if (recovered?.status === 'done') {
            return { status: 'completed', receipt: existing };
          }
          return { status: 'rejected', reason: `task done projection failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
        }
        return { status: 'completed', receipt: existing };
      }
      const finalGaps = completionGaps(
        task,
        { ...evidence, receipt: existing },
        notification,
        response,
        'done',
      );
      if (finalGaps.length > 0) {
        return { status: 'rejected', reason: finalGaps.join('; ').slice(0, 2_000) };
      }
      const projected = completedTask(task, existing.completedAt);
      let projectedAtl: ReleaseReadBack['atl'];
      try {
        projectedAtl = await dependencies.atlReadBack(projected);
      } catch (error) {
        return { status: 'rejected', reason: `ATL projected read-back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
      if (existing.readBack?.atl === null || existing.readBack?.atl === undefined
        || JSON.stringify(existing.readBack.atl) !== JSON.stringify(projectedAtl)) {
        return { status: 'rejected', reason: 'immutable release receipt ATL read-back conflicts with the projected task' };
      }
      try {
        const persistedTask = await ctx.tasks.save(projected);
        if (persistedTask.status !== 'done') {
          return { status: 'rejected', reason: `post-deployment task projection did not persist, found ${persistedTask.status}` };
        }
      } catch (error) {
        const recovered = await ctx.tasks.get(task.taskId).catch(() => null);
        if (recovered?.status === 'done') {
          return { status: 'replayed', receipt: existing };
        }
        return { status: 'rejected', reason: `task done projection failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
      return { status: 'replayed', receipt: existing };
    }

    if (task.status === 'done' && existing === null && intent === null) {
      return { status: 'rejected', reason: 'done task has no immutable completion intent or final receipt' };
    }

    const factualReceipt = intent ?? receipt;
    if (intent === null) {
      try {
        await dependencies.completionIntents.save(factualReceipt);
      } catch (error) {
        return { status: 'rejected', reason: `completion intent persistence failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
    }

    const projectedTask = task.status === 'review'
      ? completedTask(task, factualReceipt.completedAt)
      : task;
    let projectedAtl: ReleaseReadBack['atl'];
    try {
      projectedAtl = await dependencies.atlReadBack(projectedTask);
    } catch (error) {
      return { status: 'rejected', reason: `ATL projected read-back failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
    }
    const finalReceipt = releaseReceiptSchema.parse({
      ...factualReceipt,
      readBack: factualReceipt.readBack === null
        ? null
        : { ...factualReceipt.readBack, atl: projectedAtl },
    });
    const finalGaps = releaseReceiptGaps(finalReceipt, evidence.acceptance);
    if (finalGaps.length > 0) {
      return { status: 'rejected', reason: `final release receipt is incomplete: ${finalGaps.join('; ')}`.slice(0, 2_000) };
    }

    try {
      const concurrent = await dependencies.ledger.get(acceptanceId);
      if (concurrent !== null && !sameReceipt(concurrent, finalReceipt)) {
        return { status: 'rejected', reason: `immutable release receipt conflict for ${acceptanceId}` };
      }
      if (concurrent === null) await dependencies.ledger.save(finalReceipt);
      const persisted = await dependencies.ledger.get(acceptanceId);
      if (persisted === null || !sameReceipt(persisted, finalReceipt)) {
        return { status: 'rejected', reason: 'immutable release receipt persistence could not be confirmed' };
      }
    } catch (error) {
      return { status: 'rejected', reason: `final release receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
    }

    // The immutable final receipt is durable before the legal review -> done
    // projection. If this write fails, the task remains review and a retry
    // resumes through the existing-receipt branch above.
    if (task.status === 'review') {
      try {
        const persistedTask = await ctx.tasks.save(projectedTask);
        if (persistedTask.status !== 'done') {
          return { status: 'rejected', reason: `post-deployment task projection did not persist, found ${persistedTask.status}` };
        }
      } catch (error) {
        const recovered = await ctx.tasks.get(task.taskId).catch(() => null);
        if (recovered?.status === 'done') {
          return { status: 'completed', receipt: finalReceipt };
        }
        return { status: 'rejected', reason: `task done projection failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000) };
      }
    }
    return {
      status: 'completed',
      receipt: finalReceipt,
    };
  });
}
