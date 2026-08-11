import { createHash } from 'node:crypto';

import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../storage/frontmatter.js';

const DINGTALK_EVENT_PATH = /^TaskNotes\/DingTalk\/sha256-([0-9a-f]{64})\.md$/u;
const EVENT_KEY_HASH = /^sha256:([0-9a-f]{64})$/u;
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u;

export const MEETING_TRANSCRIPT_START = '<!-- ATL_MEETING_TRANSCRIPT_START -->';
export const MEETING_TRANSCRIPT_END = '<!-- ATL_MEETING_TRANSCRIPT_END -->';
export const QIANWEN_SUMMARY_START = '<!-- ATL_QIANWEN_SUMMARY_START -->';
export const QIANWEN_SUMMARY_END = '<!-- ATL_QIANWEN_SUMMARY_END -->';
export const MEETING_ANALYSIS_START = '<!-- ATL_MEETING_ANALYSIS_START -->';
export const MEETING_ANALYSIS_END = '<!-- ATL_MEETING_ANALYSIS_END -->';

export type MeetingType = 'interview' | 'discussion' | 'review' | 'other';

export interface DingTalkMeetingSource {
  eventPath: string;
  eventKeyHash: string;
  title: string;
  scheduled: string;
  meetingDate: string;
  durationMinutes?: number;
  participants?: readonly string[];
  projectEntities?: readonly string[];
}

export interface QianwenMeetingEvidence {
  recordingId: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  sourceUrl: string;
  summary: string;
}

export interface RenderMeetingNoteInput {
  source: DingTalkMeetingSource;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  qianwen?: QianwenMeetingEvidence;
}

export interface CreateMeetingNoteInput {
  eventPath: string;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  qianwen?: QianwenMeetingEvidence;
}

export interface CreateStandaloneMeetingNoteInput {
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  qianwen: QianwenMeetingEvidence;
}

export interface MeetingNoteFileSystem {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  listMarkdownFiles(path: string): Promise<string[]>;
  ensureDirectory(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
}

export interface CreateMeetingNoteResult {
  created: boolean;
  path: string;
}

export function isDingTalkMeetingPath(path: string): boolean {
  return DINGTALK_EVENT_PATH.test(path);
}

function invalidSource(): never {
  throw new Error('请选择有效的钉钉日程');
}

function validDate(value: string): boolean {
  const match = ISO_DATE_PREFIX.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parseDingTalkMeetingSource(
  eventPath: string,
  raw: string,
): DingTalkMeetingSource {
  const pathMatch = DINGTALK_EVENT_PATH.exec(eventPath);
  if (pathMatch === null) invalidSource();

  let data: Record<string, unknown>;
  try {
    data = parseTaskDocument(raw).data;
  } catch {
    invalidSource();
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const scheduled = typeof data.scheduled === 'string' ? data.scheduled.trim() : '';
  const eventKeyHash = typeof data.dingtalk_event_key_hash === 'string'
    ? data.dingtalk_event_key_hash.trim()
    : '';
  const hashMatch = EVENT_KEY_HASH.exec(eventKeyHash);
  const dateMatch = ISO_DATE_PREFIX.exec(scheduled);
  const durationMinutes = typeof data.timeEstimate === 'number'
    && Number.isFinite(data.timeEstimate)
    && data.timeEstimate > 0
    ? data.timeEstimate
    : undefined;
  if (
    data.origin !== 'dingtalk_caldav'
    || title === ''
    || hashMatch === null
    || hashMatch[1] !== pathMatch[1]
    || dateMatch === null
    || !validDate(scheduled)
  ) {
    invalidSource();
  }

  return {
    eventPath,
    eventKeyHash,
    title,
    scheduled,
    meetingDate: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
  };
}

function titleSlug(title: string): string {
  const segments = title.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  const compact = [...segments.join('-')].slice(0, 48).join('').replace(/-+$/u, '');
  return compact === '' ? 'meeting' : compact;
}

export function buildMeetingNotePath(source: DingTalkMeetingSource): string {
  const hash = EVENT_KEY_HASH.exec(source.eventKeyHash)?.[1];
  if (hash === undefined || !validDate(source.meetingDate)) invalidSource();
  const month = source.meetingDate.slice(0, 7);
  return `08_Meetings/${month}/${source.meetingDate}-${titleSlug(source.title)}-${hash}.md`;
}

function validQianwenEvidence(qianwen: QianwenMeetingEvidence): boolean {
  return qianwen.recordingId.trim() !== ''
    && qianwen.title.trim() !== ''
    && validDate(qianwen.createdAt)
    && Number.isInteger(qianwen.durationSeconds)
    && qianwen.durationSeconds > 0
    && qianwen.sourceUrl.trim() !== '';
}

export function buildStandaloneMeetingNotePath(qianwen: QianwenMeetingEvidence): string {
  if (!validQianwenEvidence(qianwen)) throw new Error('千问听记证据无效');
  const meetingDate = qianwen.createdAt.slice(0, 10);
  const recordingHash = createHash('sha256')
    .update(qianwen.recordingId)
    .digest('hex')
    .slice(0, 16);
  return `08_Meetings/${meetingDate.slice(0, 7)}/${meetingDate}-${titleSlug(qianwen.title)}-${recordingHash}.md`;
}

function normalizedParticipants(participants: readonly string[]): string[] {
  return [...new Set(participants.map((value) => value.trim()).filter((value) => value !== ''))];
}

function transcriptCallout(transcript: string): string {
  return [
    '> [!note]- 会议听记原文',
    ...transcript.split('\n').map((line) => `> ${line}`),
  ].join('\n');
}

export function extractMeetingTranscript(raw: string): string {
  const body = parseTaskDocument(raw).body;
  const start = body.indexOf(MEETING_TRANSCRIPT_START);
  const analysisStart = body.lastIndexOf(MEETING_ANALYSIS_START);
  const end = body.lastIndexOf(
    MEETING_TRANSCRIPT_END,
    analysisStart === -1 ? body.length : analysisStart,
  );
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('会议听记区域无效');
  }

  const region = body
    .slice(start + MEETING_TRANSCRIPT_START.length, end)
    .replace(/^\n/u, '')
    .replace(/\n$/u, '');
  const lines = region.split('\n');
  if (lines.shift() !== '> [!note]- 会议听记原文') {
    throw new Error('会议听记区域无效');
  }
  if (lines.some((line) => !line.startsWith('> '))) {
    throw new Error('会议听记区域无效');
  }
  return lines.map((line) => line.slice(2)).join('\n');
}

function managedQianwenSummary(summary: string): string {
  return summary
    .replaceAll(QIANWEN_SUMMARY_START, '&lt;!-- ATL_QIANWEN_SUMMARY_START --&gt;')
    .replaceAll(QIANWEN_SUMMARY_END, '&lt;!-- ATL_QIANWEN_SUMMARY_END --&gt;');
}

function qianwenSummaryRegion(qianwen?: QianwenMeetingEvidence): string[] {
  if (qianwen === undefined) return [];
  return [
    QIANWEN_SUMMARY_START,
    '## 千问 AI 纪要',
    '',
    managedQianwenSummary(qianwen.summary),
    QIANWEN_SUMMARY_END,
    '',
  ];
}

export function extractQianwenSummary(raw: string): string {
  const body = parseTaskDocument(raw).body;
  const start = body.indexOf(QIANWEN_SUMMARY_START);
  const end = body.indexOf(QIANWEN_SUMMARY_END, start + QIANWEN_SUMMARY_START.length);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('千问 AI 纪要区域无效');
  }
  const region = body
    .slice(start + QIANWEN_SUMMARY_START.length, end)
    .replace(/^\n## 千问 AI 纪要\n\n/u, '')
    .replace(/\n$/u, '');
  return region;
}

export function renderMeetingNote(input: RenderMeetingNoteInput): string {
  if (input.transcript.trim() === '') {
    throw new Error('会议听记不能为空');
  }
  const data: Record<string, unknown> = {
    type: 'meeting',
    title: input.source.title,
    meeting_type: input.meetingType,
    meeting_date: input.source.meetingDate,
    calendar_event: `[[${input.source.eventPath.slice(0, -3)}]]`,
    dingtalk_event_key_hash: input.source.eventKeyHash,
    participants: normalizedParticipants(input.participants),
    analysis_status: 'pending',
    ...(input.qianwen === undefined ? {} : {
      qianwen_recording_id: input.qianwen.recordingId,
      qianwen_title: input.qianwen.title,
      qianwen_created_at: input.qianwen.createdAt,
      qianwen_duration_seconds: input.qianwen.durationSeconds,
      qianwen_source_url: input.qianwen.sourceUrl,
    }),
  };
  const body = [
    '',
    `# ${input.source.title}`,
    '',
    MEETING_TRANSCRIPT_START,
    transcriptCallout(input.transcript),
    MEETING_TRANSCRIPT_END,
    '',
    ...qianwenSummaryRegion(input.qianwen),
    MEETING_ANALYSIS_START,
    '## AI 分析',
    '',
    '尚未分析。',
    MEETING_ANALYSIS_END,
    '',
  ].join('\n');
  return serializeTaskDocument(data, body);
}

export function renderStandaloneMeetingNote(input: CreateStandaloneMeetingNoteInput): string {
  if (input.transcript.trim() === '') throw new Error('会议听记不能为空');
  if (!validQianwenEvidence(input.qianwen)) throw new Error('千问听记证据无效');
  const data: Record<string, unknown> = {
    type: 'meeting',
    title: input.qianwen.title,
    meeting_type: input.meetingType,
    meeting_date: input.qianwen.createdAt.slice(0, 10),
    calendar_event: null,
    match_status: 'no_calendar',
    participants: normalizedParticipants(input.participants),
    analysis_status: 'pending',
    qianwen_recording_id: input.qianwen.recordingId,
    qianwen_title: input.qianwen.title,
    qianwen_created_at: input.qianwen.createdAt,
    qianwen_duration_seconds: input.qianwen.durationSeconds,
    qianwen_source_url: input.qianwen.sourceUrl,
  };
  const body = [
    '',
    `# ${input.qianwen.title}`,
    '',
    MEETING_TRANSCRIPT_START,
    transcriptCallout(input.transcript),
    MEETING_TRANSCRIPT_END,
    '',
    ...qianwenSummaryRegion(input.qianwen),
    MEETING_ANALYSIS_START,
    '## AI 分析',
    '',
    '尚未分析。',
    MEETING_ANALYSIS_END,
    '',
  ].join('\n');
  return serializeTaskDocument(data, body);
}

export class MeetingNoteController {
  constructor(private readonly fileSystem: MeetingNoteFileSystem) {}

  private async existingNotePath(source: DingTalkMeetingSource): Promise<string | null> {
    const calendarEvent = `[[${source.eventPath.slice(0, -3)}]]`;
    const paths = await this.fileSystem.listMarkdownFiles('08_Meetings');
    for (const path of paths.sort()) {
      if (!path.startsWith('08_Meetings/') || !path.endsWith('.md')) continue;
      try {
        const data = parseTaskDocument(await this.fileSystem.read(path)).data;
        if (
          data.type === 'meeting'
          && (
            data.dingtalk_event_key_hash === source.eventKeyHash
            || data.calendar_event === calendarEvent
          )
        ) {
          return path;
        }
      } catch {
        // A malformed unrelated note must not block creation for this event.
      }
    }
    return null;
  }

  private async existingRecordingNotePath(recordingId: string): Promise<string | null> {
    const paths = await this.fileSystem.listMarkdownFiles('08_Meetings');
    for (const path of paths.sort()) {
      if (!path.startsWith('08_Meetings/') || !path.endsWith('.md')) continue;
      try {
        const data = parseTaskDocument(await this.fileSystem.read(path)).data;
        if (data.type === 'meeting' && data.qianwen_recording_id === recordingId) {
          return path;
        }
      } catch {
        // A malformed unrelated note must not block recording evidence creation.
      }
    }
    return null;
  }

  async create(input: CreateMeetingNoteInput): Promise<CreateMeetingNoteResult> {
    if (input.transcript.trim() === '') {
      throw new Error('会议听记不能为空');
    }
    const source = parseDingTalkMeetingSource(
      input.eventPath,
      await this.fileSystem.read(input.eventPath),
    );
    const existingPath = await this.existingNotePath(source);
    if (existingPath !== null) return { created: false, path: existingPath };
    const path = buildMeetingNotePath(source);
    if (await this.fileSystem.exists(path)) {
      return { created: false, path };
    }
    const directory = path.slice(0, path.lastIndexOf('/'));
    await this.fileSystem.ensureDirectory(directory);
    try {
      await this.fileSystem.create(path, renderMeetingNote({
        source,
        meetingType: input.meetingType,
        participants: input.participants,
        transcript: input.transcript,
        ...(input.qianwen === undefined ? {} : { qianwen: input.qianwen }),
      }));
    } catch (error) {
      const racedPath = await this.existingNotePath(source);
      if (racedPath !== null) return { created: false, path: racedPath };
      throw error;
    }
    return { created: true, path };
  }

  async createStandalone(
    input: CreateStandaloneMeetingNoteInput,
  ): Promise<CreateMeetingNoteResult> {
    if (input.transcript.trim() === '') throw new Error('会议听记不能为空');
    if (!validQianwenEvidence(input.qianwen)) throw new Error('千问听记证据无效');
    const existingPath = await this.existingRecordingNotePath(input.qianwen.recordingId);
    if (existingPath !== null) return { created: false, path: existingPath };
    const path = buildStandaloneMeetingNotePath(input.qianwen);
    if (await this.fileSystem.exists(path)) return { created: false, path };
    await this.fileSystem.ensureDirectory(path.slice(0, path.lastIndexOf('/')));
    try {
      await this.fileSystem.create(path, renderStandaloneMeetingNote(input));
    } catch (error) {
      const racedPath = await this.existingRecordingNotePath(input.qianwen.recordingId);
      if (racedPath !== null) return { created: false, path: racedPath };
      throw error;
    }
    return { created: true, path };
  }
}
