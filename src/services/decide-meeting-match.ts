import {
  meetingMatchDecisionSchema,
  type MeetingMatchDecision,
} from '../domain/meeting-match-decision.js';
import type { MeetingMatchDecisionRepository } from '../storage/meeting-match-decision-repository.js';

export interface MeetingMatchDecisionServiceContext {
  repository: MeetingMatchDecisionRepository;
  clock: () => Date;
  id: () => string;
}

export class MeetingMatchConflictError extends Error {
  readonly code = 'meeting_match_conflict';

  constructor() {
    super('Recording or calendar event already has an active decision');
    this.name = 'MeetingMatchConflictError';
  }
}

function decision(
  context: MeetingMatchDecisionServiceContext,
  input: Omit<MeetingMatchDecision, 'schemaVersion' | 'decisionId' | 'decidedAt'>,
): MeetingMatchDecision {
  return meetingMatchDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: context.id(),
    decidedAt: context.clock().toISOString(),
    ...input,
  });
}

export async function confirmMeetingMatch(
  context: MeetingMatchDecisionServiceContext,
  input: { recordingId: string; eventKeyHash: string },
): Promise<MeetingMatchDecision> {
  const active = await context.repository.listActive();
  const recordingDecision = active.find(({ recordingId }) => recordingId === input.recordingId);
  if (
    recordingDecision?.action === 'confirmed'
    && recordingDecision.eventKeyHash === input.eventKeyHash
  ) {
    return recordingDecision;
  }
  if (
    recordingDecision !== undefined
    || active.some(({ eventKeyHash }) => eventKeyHash === input.eventKeyHash)
  ) {
    throw new MeetingMatchConflictError();
  }
  return context.repository.create(decision(context, {
    action: 'confirmed',
    recordingId: input.recordingId,
    eventKeyHash: input.eventKeyHash,
    supersedesDecisionId: null,
  }));
}

export async function markRecordingWithoutCalendar(
  context: MeetingMatchDecisionServiceContext,
  input: { recordingId: string },
): Promise<MeetingMatchDecision> {
  const active = (await context.repository.listActive())
    .find(({ recordingId }) => recordingId === input.recordingId);
  if (active?.action === 'no_calendar') return active;
  if (active !== undefined) throw new MeetingMatchConflictError();
  return context.repository.create(decision(context, {
    action: 'no_calendar',
    recordingId: input.recordingId,
    eventKeyHash: null,
    supersedesDecisionId: null,
  }));
}

export async function revokeMeetingMatchDecision(
  context: MeetingMatchDecisionServiceContext,
  input: { decisionId: string },
): Promise<MeetingMatchDecision> {
  const active = (await context.repository.listActive())
    .find(({ decisionId }) => decisionId === input.decisionId);
  if (active === undefined) throw new MeetingMatchConflictError();
  return context.repository.create(decision(context, {
    action: 'revoked',
    recordingId: active.recordingId,
    eventKeyHash: active.eventKeyHash,
    supersedesDecisionId: active.decisionId,
  }));
}
