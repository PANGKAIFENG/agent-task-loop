import { createHash } from 'node:crypto';

import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../storage/frontmatter.js';
import {
  deduplicateMeetingAttachments,
  type MeetingAttachment,
} from './meeting-attachment.js';

const DINGTALK_EVENT_PATH = /^TaskNotes\/DingTalk\/sha256-([0-9a-f]{64})\.md$/u;
const EVENT_KEY_HASH = /^sha256:([0-9a-f]{64})$/u;
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u;

export const MEETING_TRANSCRIPT_START = '<!-- ATL_MEETING_TRANSCRIPT_START -->';
export const MEETING_TRANSCRIPT_END = '<!-- ATL_MEETING_TRANSCRIPT_END -->';
export const MEETING_ANALYSIS_START = '<!-- ATL_MEETING_ANALYSIS_START -->';
export const MEETING_ANALYSIS_END = '<!-- ATL_MEETING_ANALYSIS_END -->';

export type MeetingType = 'interview' | 'discussion' | 'review' | 'other';

export interface DingTalkMeetingSource {
  eventPath: string;
  eventKeyHash: string;
  title: string;
  scheduled: string;
  meetingDate: string;
}

export interface RenderMeetingNoteInput {
  source: DingTalkMeetingSource;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  attachments?: readonly MeetingAttachment[];
}

export interface CreateMeetingNoteInput {
  eventPath: string;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  attachments?: readonly MeetingAttachment[];
}

export interface MeetingNoteFileSystem {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  listMarkdownFiles(path: string): Promise<string[]>;
  ensureDirectory(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  process(path: string, transform: (content: string) => string): Promise<string>;
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

function normalizedParticipants(participants: readonly string[]): string[] {
  return [...new Set(participants.map((value) => value.trim()).filter((value) => value !== ''))];
}

function normalizedAttachments(
  attachments: readonly MeetingAttachment[] = [],
): MeetingAttachment[] {
  return deduplicateMeetingAttachments(attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mediaType: attachment.mediaType,
    size: attachment.size,
    role: attachment.role,
    analyzable: attachment.analyzable,
    includeInAnalysis: attachment.analyzable
      && (attachment.role === 'transcript' || attachment.includeInAnalysis),
  })));
}

function attachmentFrontmatter(attachment: MeetingAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    media_type: attachment.mediaType,
    size: attachment.size,
    role: attachment.role,
    analyzable: attachment.analyzable,
    include_in_analysis: attachment.includeInAnalysis,
  };
}

export function parseMeetingAttachments(data: Record<string, unknown>): MeetingAttachment[] {
  if (data.attachments === undefined) return [];
  if (!Array.isArray(data.attachments)) throw new Error('会议附件元数据无效');
  return deduplicateMeetingAttachments(data.attachments.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('会议附件元数据无效');
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== 'string'
      || !EVENT_KEY_HASH.test(item.id)
      || typeof item.name !== 'string'
      || item.name.trim() === ''
      || typeof item.path !== 'string'
      || item.path.includes('..')
      || typeof item.media_type !== 'string'
      || typeof item.size !== 'number'
      || !Number.isSafeInteger(item.size)
      || item.size < 0
      || (item.role !== 'transcript' && item.role !== 'reference')
      || typeof item.analyzable !== 'boolean'
      || typeof item.include_in_analysis !== 'boolean'
    ) {
      throw new Error('会议附件元数据无效');
    }
    return {
      id: item.id,
      name: item.name,
      path: item.path,
      mediaType: item.media_type,
      size: item.size,
      role: item.role,
      analyzable: item.analyzable,
      includeInAnalysis: item.include_in_analysis,
    };
  }));
}

export function meetingAnalysisInputHash(input: RenderMeetingNoteInput): string {
  const selectedAttachments = normalizedAttachments(input.attachments)
    .filter((attachment) => attachment.analyzable && attachment.includeInAnalysis)
    .map((attachment) => ({ id: attachment.id, path: attachment.path }))
    .sort((left, right) => (
      left.path.localeCompare(right.path) || left.id.localeCompare(right.id)
    ));
  const payload = {
    title: input.source.title,
    meetingType: input.meetingType,
    meetingDate: input.source.meetingDate,
    participants: normalizedParticipants(input.participants),
    transcript: input.transcript,
    attachments: selectedAttachments,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
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
    attachments: normalizedAttachments(input.attachments).map(attachmentFrontmatter),
    analysis_status: 'pending',
  };
  const body = [
    '',
    `# ${input.source.title}`,
    '',
    MEETING_TRANSCRIPT_START,
    transcriptCallout(input.transcript),
    MEETING_TRANSCRIPT_END,
    '',
    MEETING_ANALYSIS_START,
    '## AI 分析',
    '',
    '尚未分析。',
    MEETING_ANALYSIS_END,
    '',
  ].join('\n');
  return serializeTaskDocument(data, body);
}

function replaceTranscriptRegion(body: string, transcript: string): string {
  const start = body.indexOf(MEETING_TRANSCRIPT_START);
  const analysisStart = body.lastIndexOf(MEETING_ANALYSIS_START);
  const end = body.lastIndexOf(
    MEETING_TRANSCRIPT_END,
    analysisStart === -1 ? body.length : analysisStart,
  );
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('会议听记区域无效');
  }
  return [
    body.slice(0, start + MEETING_TRANSCRIPT_START.length),
    '\n',
    transcriptCallout(transcript),
    '\n',
    body.slice(end),
  ].join('');
}

function existingInputHash(
  raw: string,
  data: Record<string, unknown>,
): string | null {
  const title = typeof data.title === 'string' ? data.title : null;
  const meetingType = typeof data.meeting_type === 'string' ? data.meeting_type : null;
  const meetingDate = typeof data.meeting_date === 'string' ? data.meeting_date : null;
  const participants = Array.isArray(data.participants)
    && data.participants.every((value) => typeof value === 'string')
    ? data.participants
    : null;
  if (
    title === null
    || !['interview', 'discussion', 'review', 'other'].includes(meetingType ?? '')
    || meetingDate === null
    || participants === null
  ) return null;

  let attachments: MeetingAttachment[];
  try {
    attachments = parseMeetingAttachments(data);
  } catch {
    return null;
  }
  return meetingAnalysisInputHash({
    source: {
      eventPath: '',
      eventKeyHash: '',
      title,
      scheduled: meetingDate,
      meetingDate,
    },
    meetingType: meetingType as MeetingType,
    participants,
    transcript: extractMeetingTranscript(raw),
    attachments,
  });
}

export function updateMeetingNote(raw: string, input: RenderMeetingNoteInput): string {
  if (input.transcript.trim() === '') throw new Error('会议听记不能为空');
  const document = parseTaskDocument(raw);
  const expectedCalendarEvent = `[[${input.source.eventPath.slice(0, -3)}]]`;
  if (
    document.data.type !== 'meeting'
    || (
      document.data.dingtalk_event_key_hash !== input.source.eventKeyHash
      && document.data.calendar_event !== expectedCalendarEvent
    )
  ) {
    throw new Error('会议笔记与钉钉日程不匹配');
  }

  const previousStatus = document.data.analysis_status;
  const previousSuccessfulHash = typeof document.data.analysis_input_hash === 'string'
    ? document.data.analysis_input_hash
    : null;
  const nextInputHash = meetingAnalysisInputHash(input);
  const comparisonHash = previousSuccessfulHash ?? existingInputHash(raw, document.data);
  let analysisStatus = previousStatus;
  if (previousStatus === 'ready_for_confirm' || previousStatus === 'stale') {
    analysisStatus = comparisonHash === nextInputHash ? 'ready_for_confirm' : 'stale';
  }
  if (!['pending', 'failed', 'ready_for_confirm', 'stale'].includes(String(analysisStatus))) {
    analysisStatus = 'pending';
  }

  const data: Record<string, unknown> = {
    ...document.data,
    title: input.source.title,
    meeting_type: input.meetingType,
    meeting_date: input.source.meetingDate,
    calendar_event: expectedCalendarEvent,
    dingtalk_event_key_hash: input.source.eventKeyHash,
    participants: normalizedParticipants(input.participants),
    attachments: normalizedAttachments(input.attachments).map(attachmentFrontmatter),
    analysis_status: analysisStatus,
  };
  return serializeTaskDocument(data, replaceTranscriptRegion(document.body, input.transcript));
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

  async findExistingPath(source: DingTalkMeetingSource): Promise<string | null> {
    return this.existingNotePath(source);
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
    const updateInput = { ...input, source };
    if (existingPath !== null) {
      await this.fileSystem.process(existingPath, (raw) => updateMeetingNote(raw, updateInput));
      return { created: false, path: existingPath };
    }
    const path = buildMeetingNotePath(source);
    if (await this.fileSystem.exists(path)) {
      await this.fileSystem.process(path, (raw) => updateMeetingNote(raw, updateInput));
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
        attachments: input.attachments ?? [],
      }));
    } catch (error) {
      const racedPath = await this.existingNotePath(source);
      if (racedPath !== null) {
        await this.fileSystem.process(racedPath, (raw) => updateMeetingNote(raw, updateInput));
        return { created: false, path: racedPath };
      }
      throw error;
    }
    return { created: true, path };
  }
}
