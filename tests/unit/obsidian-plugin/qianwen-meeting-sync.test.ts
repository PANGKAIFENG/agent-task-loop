import { describe, expect, it } from 'vitest';

import {
  buildQianwenMeetingPreviews,
  buildQianwenMeetingPreview,
  parseQianwenRecording,
  type QianwenRecording,
} from '../../../src/obsidian-plugin/qianwen-meeting-sync.js';
import type { DingTalkMeetingSource } from '../../../src/obsidian-plugin/meeting-note.js';

const source: DingTalkMeetingSource = {
  eventPath: `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`,
  eventKeyHash: `sha256:${'a'.repeat(64)}`,
  title: '钟炜彬okr',
  scheduled: '2026-08-10T19:00:00+08:00',
  meetingDate: '2026-08-10',
};

function recording(overrides: Partial<QianwenRecording> = {}): QianwenRecording {
  return {
    id: '263f970d557740e89b97e9ef9e7c3122',
    title: '团队目标设定与AI产品能力建设讨论',
    createdAt: '2026-08-10T19:56:00+08:00',
    durationSeconds: 701,
    sourceUrl: 'qianwen.com/chat/263f970d557740e89b97e9ef9e7c3122?entry=audio_qianwen',
    transcript: '[10:34] 发言人2：两条也无所谓，也可以写三条。',
    summary: '会议明确了两个月 OKR，需要写目标、指标描述和衡量标准。',
    transcriptComplete: true,
    ...overrides,
  };
}

describe('qianwen meeting sync', () => {
  it('keeps an in-window OKR recording pending when all evidence is weak', () => {
    const preview = buildQianwenMeetingPreview(source, [recording()]);

    expect(preview.confidence).toBe('high');
    expect(preview.conflict).toBe(false);
    expect(preview.recording?.id).toBe('263f970d557740e89b97e9ef9e7c3122');
    expect(preview.readyToWrite).toBe(false);
    expect(preview.reason).toContain('独立强证据不足');
    expect(preview.plannedNotePath).toContain('08_Meetings/2026-08/');
  });

  it('automatically matches only when two independent strong evidence types agree', () => {
    const preview = buildQianwenMeetingPreview({
      ...source,
      participants: ['钟炜彬'],
      projectEntities: ['Agent Task Loop'],
    }, [recording({
      participants: ['钟炜彬'],
      projectEntities: ['Agent Task Loop'],
    })]);

    expect(preview.readyToWrite).toBe(true);
    expect(preview.candidates[0]?.strongEvidence).toEqual([
      '共同参会人：钟炜彬',
      '明确项目实体：Agent Task Loop',
    ]);
  });

  it('stops on a close competing recording instead of choosing silently', () => {
    const preview = buildQianwenMeetingPreview(source, [
      recording(),
      recording({
        id: 'second',
        title: '团队 OKR 与 AI 能力讨论',
        createdAt: '2026-08-10T19:55:00+08:00',
        sourceUrl: 'qianwen.com/chat/second',
      }),
    ]);

    expect(preview.conflict).toBe(true);
    expect(preview.readyToWrite).toBe(false);
  });

  it('marks an unfinished transcript as pending rather than writable', () => {
    const preview = buildQianwenMeetingPreview(source, [
      recording({ transcriptComplete: false }),
    ]);

    expect(preview.confidence).toBe('high');
    expect(preview.readyToWrite).toBe(false);
    expect(preview.reason).toContain('未完成');
  });

  it('rejects malformed recording manifests and empty transcripts', () => {
    expect(() => parseQianwenRecording('{}')).toThrow('千问听记清单无效');
    expect(() => parseQianwenRecording(JSON.stringify(recording({ transcript: '' })))).toThrow(
      '千问听记原文不能为空',
    );
    expect(parseQianwenRecording(JSON.stringify(recording({
      transcript: '',
      transcriptComplete: false,
    })))).toMatchObject({ transcript: '', transcriptComplete: false });
  });

  it('assigns one recording to at most one calendar event', () => {
    const otherSource: DingTalkMeetingSource = {
      ...source,
      eventPath: `TaskNotes/DingTalk/sha256-${'b'.repeat(64)}.md`,
      eventKeyHash: `sha256:${'b'.repeat(64)}`,
      title: 'AI产品能力讨论',
      scheduled: '2026-08-10T18:00:00+08:00',
    };
    const previews = buildQianwenMeetingPreviews([source, otherSource], [recording()]);
    expect(previews.filter((preview) => preview.recording !== null)).toHaveLength(1);
    expect(previews.some((preview) => preview.reason.includes('已匹配其他日程'))).toBe(true);
  });

  it('does not expose low-score recordings as matches', () => {
    const preview = buildQianwenMeetingPreviews([source], [recording({
      title: '完全无关的录音',
      summary: '无关内容',
      transcript: '无关内容',
      createdAt: '2026-08-01T10:00:00+08:00',
    })])[0];
    expect(preview?.recording).toBeNull();
    expect(preview?.readyToWrite).toBe(false);
  });
});
