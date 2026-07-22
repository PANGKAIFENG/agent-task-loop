import type { MeetingType } from './meeting-note.js';

const MEETING_TYPES: readonly MeetingType[] = [
  'interview',
  'discussion',
  'review',
  'other',
];

export interface MeetingTranscriptFormInput {
  meetingType: MeetingType;
  participants: string;
  transcript: string;
}

export interface NormalizedMeetingTranscriptForm {
  meetingType: MeetingType;
  participants: string[];
  transcript: string;
}

export interface MeetingTranscriptFormErrors {
  meetingType?: string;
  transcript?: string;
}

export function validateMeetingTranscriptForm(
  input: MeetingTranscriptFormInput,
): MeetingTranscriptFormErrors {
  const errors: MeetingTranscriptFormErrors = {};
  if (!MEETING_TYPES.includes(input.meetingType)) {
    errors.meetingType = '请选择会议类型';
  }
  if (input.transcript.trim() === '') {
    errors.transcript = '请粘贴会议听记原文';
  }
  return errors;
}

export function normalizeMeetingTranscriptForm(
  input: MeetingTranscriptFormInput,
): NormalizedMeetingTranscriptForm {
  const errors = validateMeetingTranscriptForm(input);
  if (Object.keys(errors).length > 0) {
    throw new Error('会议听记表单无效');
  }
  const participants = [...new Set(input.participants
    .split(/[\n,，;；]+/u)
    .map((participant) => participant.trim())
    .filter((participant) => participant !== ''))];
  return {
    meetingType: input.meetingType,
    participants,
    transcript: input.transcript,
  };
}
