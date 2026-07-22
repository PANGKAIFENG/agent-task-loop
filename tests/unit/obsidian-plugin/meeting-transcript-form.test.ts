import { describe, expect, it } from 'vitest';

import {
  normalizeMeetingTranscriptForm,
  validateMeetingTranscriptForm,
} from '../../../src/obsidian-plugin/meeting-transcript-form.js';

describe('meeting transcript form', () => {
  it('requires a non-blank transcript and a known meeting type', () => {
    expect(validateMeetingTranscriptForm({
      meetingType: 'discussion',
      participants: '',
      transcript: '  \n ',
    })).toEqual({ transcript: '请粘贴会议听记原文' });

    expect(validateMeetingTranscriptForm({
      meetingType: 'unknown' as never,
      participants: '',
      transcript: '有效听记',
    })).toEqual({ meetingType: '请选择会议类型' });
  });

  it('normalizes and deduplicates participants without changing transcript bytes', () => {
    const transcript = '第一行\n\n第二行\n';

    expect(normalizeMeetingTranscriptForm({
      meetingType: 'interview',
      participants: '候选人，面试官\n候选人; HR ',
      transcript,
    })).toEqual({
      meetingType: 'interview',
      participants: ['候选人', '面试官', 'HR'],
      transcript,
    });
  });
});
