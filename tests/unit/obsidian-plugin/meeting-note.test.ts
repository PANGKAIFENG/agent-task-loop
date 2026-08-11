import { describe, expect, it } from 'vitest';

import {
  buildMeetingNotePath,
  buildStandaloneMeetingNotePath,
  extractQianwenSummary,
  parseDingTalkMeetingSource,
  renderMeetingNote,
  renderStandaloneMeetingNote,
} from '../../../src/obsidian-plugin/meeting-note.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';

const EVENT_HASH = `sha256:${'a'.repeat(64)}`;
const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`;

function eventDocument(overrides: Record<string, unknown> = {}): string {
  return [
    '---',
    'type: task',
    'title: 产品面试 / 第二轮',
    'origin: dingtalk_caldav',
    `dingtalk_event_key_hash: ${EVENT_HASH}`,
    'scheduled: 2026-07-22T14:00:00+08:00',
    ...Object.entries(overrides).map(([key, value]) => `${key}: ${String(value)}`),
    '---',
    '',
    '钉钉日程只读正文。',
    '',
  ].join('\n');
}

describe('meeting note source validation', () => {
  it('parses a valid DingTalk mirror without treating its description as a transcript', () => {
    expect(parseDingTalkMeetingSource(EVENT_PATH, eventDocument())).toEqual({
      eventPath: EVENT_PATH,
      eventKeyHash: EVENT_HASH,
      title: '产品面试 / 第二轮',
      scheduled: '2026-07-22T14:00:00+08:00',
      meetingDate: '2026-07-22',
    });
  });

  it.each([
    '../TaskNotes/DingTalk/sha256-a.md',
    'TaskNotes/DingTalk/../../secret.md',
    '10_Tasks/Inbox/event.md',
    `TaskNotes/DingTalk/sha256-${'b'.repeat(64)}.md`,
  ])('rejects an unsafe or mismatched source path: %s', (path) => {
    expect(() => parseDingTalkMeetingSource(path, eventDocument()))
      .toThrow('有效的钉钉日程');
  });

  it.each([
    { origin: 'manual' },
    { dingtalk_event_key_hash: '' },
    { scheduled: 'not-a-date' },
    { title: '' },
  ])('rejects missing event identity data: %j', (overrides) => {
    expect(() => parseDingTalkMeetingSource(EVENT_PATH, eventDocument(overrides)))
      .toThrow('有效的钉钉日程');
  });
});

describe('meeting note rendering', () => {
  it('builds a stable safe path from the occurrence identity', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());

    expect(buildMeetingNotePath(source)).toBe(
      `08_Meetings/2026-07/2026-07-22-产品面试-第二轮-${'a'.repeat(64)}.md`,
    );
  });

  it('keeps the transcript in the body and out of YAML', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());
    const transcript = '候选人：先谈目标。\n\n面试官：好的。\n';
    const raw = renderMeetingNote({
      source,
      meetingType: 'interview',
      participants: ['候选人', '面试官'],
      transcript,
    });
    const document = parseTaskDocument(raw);

    expect(document.data).toMatchObject({
      type: 'meeting',
      title: '产品面试 / 第二轮',
      meeting_type: 'interview',
      meeting_date: '2026-07-22',
      calendar_event: `[[${EVENT_PATH.slice(0, -3)}]]`,
      dingtalk_event_key_hash: EVENT_HASH,
      participants: ['候选人', '面试官'],
      analysis_status: 'pending',
    });
    expect(JSON.stringify(document.data)).not.toContain('先谈目标');
    expect(document.body).toContain('> [!note]- 会议听记原文');
    expect(document.body).toContain('<!-- ATL_MEETING_TRANSCRIPT_START -->');
    expect(document.body).toContain('<!-- ATL_MEETING_TRANSCRIPT_END -->');
    expect(document.body).toContain('<!-- ATL_MEETING_ANALYSIS_START -->');
    expect(document.body).toContain('<!-- ATL_MEETING_ANALYSIS_END -->');
  });

  it('stores the original Qianwen summary in its own managed region', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());
    const raw = renderMeetingNote({
      source,
      meetingType: 'discussion',
      participants: ['庞凯烽'],
      transcript: '发言人1：确认目标。',
      qianwen: {
        recordingId: 'recording-1',
        title: '团队目标讨论',
        createdAt: '2026-07-22T14:42:00+08:00',
        durationSeconds: 720,
        sourceUrl: 'qianwen.com/chat/recording-1',
        summary: '## 千问结论\n\n- 确认目标。',
      },
    });
    const document = parseTaskDocument(raw);

    expect(document.data).toMatchObject({
      qianwen_recording_id: 'recording-1',
      qianwen_title: '团队目标讨论',
      qianwen_created_at: '2026-07-22T14:42:00+08:00',
      qianwen_duration_seconds: 720,
      qianwen_source_url: 'qianwen.com/chat/recording-1',
    });
    expect(document.body).toContain('<!-- ATL_QIANWEN_SUMMARY_START -->');
    expect(document.body).toContain('<!-- ATL_QIANWEN_SUMMARY_END -->');
    expect(extractQianwenSummary(raw)).toBe('## 千问结论\n\n- 确认目标。');
  });

  it('rejects a blank transcript', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());

    expect(() => renderMeetingNote({
      source,
      meetingType: 'discussion',
      participants: [],
      transcript: '  \n ',
    })).toThrow('会议听记不能为空');
  });

  it('renders a traceable meeting note when a recording has no calendar event', () => {
    const qianwen = {
      recordingId: 'recording-without-calendar',
      title: '精恭纺验收推进会议',
      createdAt: '2026-08-10T17:42:00+08:00',
      durationSeconds: 1200,
      sourceUrl: 'qianwen.com/chat/recording-without-calendar',
      summary: '确认四类验收口径。',
    };

    const raw = renderStandaloneMeetingNote({
      meetingType: 'discussion',
      participants: [],
      transcript: '发言人：确认四类验收口径。',
      qianwen,
    });
    const document = parseTaskDocument(raw);

    expect(buildStandaloneMeetingNotePath(qianwen)).toMatch(
      /^08_Meetings\/2026-08\/2026-08-10-精恭纺验收推进会议-[a-f0-9]{16}\.md$/u,
    );
    expect(document.data).toMatchObject({
      type: 'meeting',
      title: '精恭纺验收推进会议',
      meeting_date: '2026-08-10',
      calendar_event: null,
      match_status: 'no_calendar',
      qianwen_recording_id: 'recording-without-calendar',
    });
    expect(document.body).toContain('发言人：确认四类验收口径。');
  });
});
