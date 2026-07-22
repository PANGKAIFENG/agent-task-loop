import { describe, expect, it } from 'vitest';

import {
  buildMeetingNotePath,
  parseDingTalkMeetingSource,
  renderMeetingNote,
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

  it('rejects a blank transcript', () => {
    const source = parseDingTalkMeetingSource(EVENT_PATH, eventDocument());

    expect(() => renderMeetingNote({
      source,
      meetingType: 'discussion',
      participants: [],
      transcript: '  \n ',
    })).toThrow('会议听记不能为空');
  });
});
