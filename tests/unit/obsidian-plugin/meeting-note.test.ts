import { describe, expect, it } from 'vitest';

import {
  buildMeetingNotePath,
  buildStandaloneMeetingNotePath,
  extractQianwenSummary,
  meetingAnalysisInputHash,
  parseDingTalkMeetingSource,
  renderMeetingNote,
  renderStandaloneMeetingNote,
  updateMeetingNote,
} from '../../../src/obsidian-plugin/meeting-note.js';
import type { MeetingAttachment } from '../../../src/obsidian-plugin/meeting-attachment.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';

const EVENT_HASH = `sha256:${'a'.repeat(64)}`;
const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`;

function attachment(overrides: Partial<MeetingAttachment> = {}): MeetingAttachment {
  return {
    id: `sha256:${'b'.repeat(64)}`,
    name: '访谈资料.pdf',
    path: `08_Meetings/2026-07/attachments/${'a'.repeat(64)}/${'b'.repeat(12)}-访谈资料.pdf`,
    mediaType: 'application/pdf',
    size: 128,
    role: 'reference',
    analyzable: true,
    includeInAnalysis: true,
    ...overrides,
  };
}

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
      attachments: [attachment()],
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
      attachments: [{
        id: `sha256:${'b'.repeat(64)}`,
        name: '访谈资料.pdf',
        path: `08_Meetings/2026-07/attachments/${'a'.repeat(64)}/${'b'.repeat(12)}-访谈资料.pdf`,
        media_type: 'application/pdf',
        size: 128,
        role: 'reference',
        analyzable: true,
        include_in_analysis: true,
      }],
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

  it('updates only managed transcript and fields while preserving analysis and manual body', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());
    const originalTranscript = '第一版听记';
    const originalAttachments = [attachment()];
    const analyzedInputHash = meetingAnalysisInputHash({
      source,
      meetingType: 'discussion',
      participants: ['旧参与人'],
      transcript: originalTranscript,
      attachments: originalAttachments,
    });
    const original = renderMeetingNote({
      source,
      meetingType: 'discussion',
      participants: ['旧参与人'],
      transcript: originalTranscript,
      attachments: originalAttachments,
    })
      .replace('analysis_status: pending', [
        'analysis_status: ready_for_confirm',
        `analysis_input_hash: ${analyzedInputHash}`,
      ].join('\n'))
      .replace('尚未分析。', '已有的结构化总结。')
      .concat('\n人工补充，不属于 ATL 管理区。\n');

    const updated = updateMeetingNote(original, {
      source,
      meetingType: 'interview',
      participants: ['新参与人'],
      transcript: '第二版听记',
      attachments: [attachment({ includeInAnalysis: false })],
    });
    const document = parseTaskDocument(updated);

    expect(document.data).toMatchObject({
      meeting_type: 'interview',
      participants: ['新参与人'],
      analysis_status: 'stale',
      analysis_input_hash: analyzedInputHash,
    });
    expect(document.body).toContain('第二版听记');
    expect(document.body).not.toContain('第一版听记');
    expect(document.body).toContain('已有的结构化总结。');
    expect(document.body).toContain('人工补充，不属于 ATL 管理区。');
  });

  it('adds Qianwen metadata and the managed summary when binding an existing meeting note', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());
    const original = `${renderMeetingNote({
      source,
      meetingType: 'discussion',
      participants: ['旧参与人'],
      transcript: '手工粘贴的旧听记',
    })}\n人工补充，不属于 ATL 管理区。\n`;

    const updated = updateMeetingNote(original, {
      source,
      meetingType: 'discussion',
      participants: ['旧参与人'],
      transcript: '千问完整原文',
      qianwen: {
        recordingId: 'recording-existing',
        title: '团队目标讨论',
        createdAt: '2026-07-22T14:42:00+08:00',
        durationSeconds: 720,
        sourceUrl: 'qianwen.com/chat/recording-existing',
        summary: '## 千问结论\n\n- 确认目标。',
      },
    });
    const document = parseTaskDocument(updated);

    expect(document.data).toMatchObject({
      qianwen_recording_id: 'recording-existing',
      qianwen_title: '团队目标讨论',
      qianwen_created_at: '2026-07-22T14:42:00+08:00',
      qianwen_duration_seconds: 720,
      qianwen_source_url: 'qianwen.com/chat/recording-existing',
    });
    expect(extractQianwenSummary(updated)).toBe('## 千问结论\n\n- 确认目标。');
    expect(document.body).toContain('人工补充，不属于 ATL 管理区。');
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
