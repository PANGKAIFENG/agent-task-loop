import { describe, expect, it } from 'vitest';

import {
  buildQianwenRecording,
  type QianwenRecordingStageInput,
} from '../../../src/obsidian-plugin/qianwen-recording-staging.js';

const input: QianwenRecordingStageInput = {
  id: 'recording-1',
  title: '团队目标设定与AI产品能力建设讨论',
  createdAt: '2026-08-10T19:56:00+08:00',
  durationSeconds: 701,
  sourceUrl: 'qianwen.com/chat/recording-1?entry=audio_qianwen',
  transcript: '[00:01] 发言人1: 嗯。\n',
  summary: '## 会议结论\n\n- 确认 OKR 草案。',
};

describe('qianwen recording staging', () => {
  it('builds a validated recording manifest from captured content', () => {
    expect(buildQianwenRecording(input)).toEqual({
      ...input,
      transcriptComplete: true,
    });
  });

  it('marks a recording incomplete when the capture has not finished', () => {
    expect(buildQianwenRecording({
      ...input,
      transcript: '',
      transcriptComplete: false,
    })).toMatchObject({
      transcript: '',
      transcriptComplete: false,
    });
  });

  it('rejects missing content and invalid metadata before writing staging', () => {
    expect(() => buildQianwenRecording({ ...input, transcript: '  ' }))
      .toThrow('千问听记原文不能为空');
    expect(() => buildQianwenRecording({ ...input, durationSeconds: 0 }))
      .toThrow('千问听记元数据无效');
  });
});
