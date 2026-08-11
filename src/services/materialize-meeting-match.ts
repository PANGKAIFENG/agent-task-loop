import type {
  CreateMeetingNoteResult,
  DingTalkMeetingSource,
  MeetingNoteController,
  QianwenMeetingEvidence,
} from '../obsidian-plugin/meeting-note.js';
import type { MeetingMatchDecision } from '../domain/meeting-match-decision.js';
import type { MeetingMatchDecisionRepository } from '../storage/meeting-match-decision-repository.js';
import type { QianwenSourceStateRepository } from '../storage/qianwen-source-state-repository.js';
import { parseTaskDocument } from '../storage/frontmatter.js';
import {
  confirmMeetingMatch,
  markRecordingWithoutCalendar,
  revokeMeetingMatchDecision,
} from './decide-meeting-match.js';

export interface MaterializeMeetingMatchContext {
  sourceRepository: QianwenSourceStateRepository;
  decisionRepository: MeetingMatchDecisionRepository;
  meetingNotes: Pick<MeetingNoteController, 'create' | 'createStandalone' | 'rollback'>;
  listCalendarSources(): Promise<DingTalkMeetingSource[]>;
  readCalendarSource(path: string): Promise<string>;
  readMeetingNote(path: string): Promise<string>;
  clock(): Date;
  id(): string;
}

export interface MaterializedMeetingMatch {
  decision: MeetingMatchDecision;
  meetingPath: string;
  meetingCreated: boolean;
}

export class MeetingEvidenceUnavailableError extends Error {
  readonly code = 'meeting_evidence_unavailable';

  constructor() {
    super('The selected recording cannot be materialized as meeting evidence');
    this.name = 'MeetingEvidenceUnavailableError';
  }
}

async function recordingEvidence(
  context: MaterializeMeetingMatchContext,
  recordingId: string,
): Promise<{ qianwen: QianwenMeetingEvidence; transcript: string }> {
  const state = await context.sourceRepository.load();
  const recording = state.recordings[recordingId];
  const version = recording?.versions.find(({ version: candidate }) => (
    candidate === recording.currentVersion
  ));
  if (
    version === undefined
    || version.status !== 'available'
    || version.title === null
    || version.createdAt === null
    || version.durationSeconds === null
    || version.sourceUrl === null
    || !version.transcriptComplete
    || version.transcript.trim() === ''
  ) throw new MeetingEvidenceUnavailableError();
  return {
    qianwen: {
      recordingId: version.id,
      title: version.title,
      createdAt: version.createdAt,
      durationSeconds: version.durationSeconds,
      sourceUrl: version.sourceUrl,
      summary: version.summary,
    },
    transcript: version.transcript,
  };
}

async function assertMeetingLinked(
  context: MaterializeMeetingMatchContext,
  path: string,
  recordingId: string,
): Promise<void> {
  const data = parseTaskDocument(await context.readMeetingNote(path)).data;
  if (data.type !== 'meeting' || data.qianwen_recording_id !== recordingId) {
    throw new MeetingEvidenceUnavailableError();
  }
}

async function compensateNewDecision(
  context: MaterializeMeetingMatchContext,
  previousDecisionId: string | null,
  decision: MeetingMatchDecision,
): Promise<void> {
  if (previousDecisionId === decision.decisionId) return;
  try {
    await revokeMeetingMatchDecision({
      repository: context.decisionRepository,
      clock: context.clock,
      id: context.id,
    }, { decisionId: decision.decisionId });
  } catch {
    // The original evidence error remains the actionable failure.
  }
}

export async function confirmMeetingMatchWithEvidence(
  context: MaterializeMeetingMatchContext,
  input: { recordingId: string; eventKeyHash: string },
): Promise<MaterializedMeetingMatch> {
  const evidence = await recordingEvidence(context, input.recordingId);
  const calendar = (await context.listCalendarSources())
    .find(({ eventKeyHash }) => eventKeyHash === input.eventKeyHash);
  if (calendar === undefined) throw new MeetingEvidenceUnavailableError();
  const sourceBefore = await context.readCalendarSource(calendar.eventPath);
  const previousDecisionId = (await context.decisionRepository.listActive())
    .find(({ recordingId }) => recordingId === input.recordingId)?.decisionId ?? null;
  const decision = await confirmMeetingMatch({
    repository: context.decisionRepository,
    clock: context.clock,
    id: context.id,
  }, input);
  let meeting: CreateMeetingNoteResult | undefined;
  try {
    meeting = await context.meetingNotes.create({
      eventPath: calendar.eventPath,
      meetingType: 'discussion',
      participants: calendar.participants ?? [],
      transcript: evidence.transcript,
      qianwen: evidence.qianwen,
    });
    const sourceAfter = await context.readCalendarSource(calendar.eventPath);
    if (sourceAfter !== sourceBefore) throw new MeetingEvidenceUnavailableError();
    await assertMeetingLinked(context, meeting.path, input.recordingId);
    return {
      decision,
      meetingPath: meeting.path,
      meetingCreated: meeting.created,
    };
  } catch (error) {
    if (meeting !== undefined) {
      try {
        await context.meetingNotes.rollback(meeting);
      } catch {
        // The original evidence error remains the actionable failure.
      }
    }
    await compensateNewDecision(context, previousDecisionId, decision);
    throw error;
  }
}

export async function markRecordingWithoutCalendarWithEvidence(
  context: MaterializeMeetingMatchContext,
  input: { recordingId: string },
): Promise<MaterializedMeetingMatch> {
  const evidence = await recordingEvidence(context, input.recordingId);
  const previousDecisionId = (await context.decisionRepository.listActive())
    .find(({ recordingId }) => recordingId === input.recordingId)?.decisionId ?? null;
  const decision = await markRecordingWithoutCalendar({
    repository: context.decisionRepository,
    clock: context.clock,
    id: context.id,
  }, input);
  let meeting: CreateMeetingNoteResult | undefined;
  try {
    meeting = await context.meetingNotes.createStandalone({
      meetingType: 'discussion',
      participants: [],
      transcript: evidence.transcript,
      qianwen: evidence.qianwen,
    });
    await assertMeetingLinked(context, meeting.path, input.recordingId);
    return {
      decision,
      meetingPath: meeting.path,
      meetingCreated: meeting.created,
    };
  } catch (error) {
    if (meeting !== undefined) {
      try {
        await context.meetingNotes.rollback(meeting);
      } catch {
        // The original evidence error remains the actionable failure.
      }
    }
    await compensateNewDecision(context, previousDecisionId, decision);
    throw error;
  }
}
