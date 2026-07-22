import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../storage/frontmatter.js';

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
}

export interface CreateMeetingNoteInput {
  eventPath: string;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
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
      }));
    } catch (error) {
      const racedPath = await this.existingNotePath(source);
      if (racedPath !== null) return { created: false, path: racedPath };
      throw error;
    }
    return { created: true, path };
  }
}
