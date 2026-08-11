import { z } from 'zod';

import type { QianwenRecording } from './qianwen-meeting-sync.js';

export interface QianwenRecordingStageInput {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  sourceUrl: string;
  transcript: string;
  summary: string;
  transcriptComplete?: boolean;
  participants?: readonly string[];
  projectEntities?: readonly string[];
}

const stageInputSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  durationSeconds: z.number().int().positive(),
  sourceUrl: z.string().trim().min(1),
  transcript: z.string(),
  summary: z.string(),
  transcriptComplete: z.boolean().optional(),
  participants: z.array(z.string().trim().min(1)).max(100).optional(),
  projectEntities: z.array(z.string().trim().min(1)).max(100).optional(),
}).strict();

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export function buildQianwenRecording(input: QianwenRecordingStageInput): QianwenRecording {
  const parsed = stageInputSchema.safeParse(input);
  if (!parsed.success || !validDate(parsed.data.createdAt)) {
    throw new Error('千问听记元数据无效');
  }
  if ((parsed.data.transcriptComplete ?? true) && parsed.data.transcript.trim() === '') {
    throw new Error('千问听记原文不能为空');
  }
  const { participants, projectEntities, ...recording } = parsed.data;
  return {
    ...recording,
    transcriptComplete: parsed.data.transcriptComplete ?? true,
    ...(participants === undefined ? {} : { participants }),
    ...(projectEntities === undefined ? {} : { projectEntities }),
  };
}
