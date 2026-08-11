import { z } from 'zod';

import {
  buildMeetingNotePath,
  type DingTalkMeetingSource,
  type QianwenMeetingEvidence,
} from './meeting-note.js';

export type QianwenMatchConfidence = 'high' | 'medium' | 'low';

export interface QianwenRecording {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  sourceUrl: string;
  transcript: string;
  summary: string;
  transcriptComplete: boolean;
  participants?: readonly string[];
  projectEntities?: readonly string[];
}

export interface QianwenMatchCandidate {
  recording: QianwenRecording;
  score: number;
  evidence: string[];
  strongEvidence: string[];
}

export interface QianwenMeetingPreview {
  source: DingTalkMeetingSource;
  recording: QianwenRecording | null;
  confidence: QianwenMatchConfidence;
  score: number;
  conflict: boolean;
  readyToWrite: boolean;
  reason: string;
  plannedNotePath: string;
  candidates: QianwenMatchCandidate[];
}

const qianwenRecordingSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  durationSeconds: z.number().int().positive(),
  sourceUrl: z.string().trim().min(1),
  transcript: z.string(),
  summary: z.string(),
  transcriptComplete: z.boolean(),
  participants: z.array(z.string().trim().min(1)).max(100).optional(),
  projectEntities: z.array(z.string().trim().min(1)).max(100).optional(),
}).strict();

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export function parseQianwenRecording(raw: string): QianwenRecording {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('千问听记清单无效');
  }
  const parsed = qianwenRecordingSchema.safeParse(value);
  if (!parsed.success || !validDate(parsed.data.createdAt)) {
    throw new Error('千问听记清单无效');
  }
  if (parsed.data.transcriptComplete && parsed.data.transcript.trim() === '') {
    throw new Error('千问听记原文不能为空');
  }
  const { participants, projectEntities, ...recording } = parsed.data;
  return {
    ...recording,
    ...(participants === undefined ? {} : { participants }),
    ...(projectEntities === undefined ? {} : { projectEntities }),
  };
}

function tokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
}

function normalized(value: string): string {
  return tokens(value).join('');
}

function firstSharedValue(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string | undefined {
  const normalizedRight = new Set((right ?? []).map(normalized).filter(Boolean));
  return (left ?? []).find((value) => normalizedRight.has(normalized(value)));
}

function eventEnd(source: DingTalkMeetingSource): number {
  const start = new Date(source.scheduled).getTime();
  return start + (source.durationMinutes ?? 60) * 60_000;
}

function matchScore(
  source: DingTalkMeetingSource,
  recording: QianwenRecording,
): QianwenMatchCandidate {
  let score = 0;
  const evidence: string[] = [];
  const strongEvidence: string[] = [];
  const created = new Date(recording.createdAt).getTime();
  const start = new Date(source.scheduled).getTime();
  const end = eventEnd(source);

  if (recording.createdAt.slice(0, 10) === source.meetingDate) {
    score += 0.2;
    evidence.push('日期一致');
  }
  if (created >= start - 15 * 60_000 && created <= end) {
    score += 0.45;
    evidence.push('听记创建时间位于日程时间窗内');
  } else if (created > end && created <= end + 24 * 60 * 60_000) {
    score += 0.2;
    evidence.push('听记在日程结束后 24 小时内创建');
  }

  const sourceTokens = new Set(tokens(source.title));
  const evidenceText = `${recording.title}\n${recording.summary}\n${recording.transcript}`;
  const recordingTokens = new Set(tokens(evidenceText));
  const matchedTokens = [...sourceTokens].filter((token) => recordingTokens.has(token));
  if (sourceTokens.size > 0 && matchedTokens.length > 0) {
    score += 0.2 * (matchedTokens.length / sourceTokens.size);
    evidence.push(`主题词匹配：${matchedTokens.join('、')}`);
  }
  const normalizedSource = normalized(source.title);
  const normalizedRecording = normalized(evidenceText);
  if (
    normalizedSource !== ''
    && (
      normalizedRecording.includes(normalizedSource)
      || normalizedSource.includes(normalized(recording.title))
    )
  ) {
    score += 0.1;
    evidence.push('标题或主题完整包含');
  }

  const sharedParticipant = firstSharedValue(source.participants, recording.participants);
  if (sharedParticipant !== undefined) {
    score += 0.1;
    const label = `共同参会人：${sharedParticipant}`;
    evidence.push(label);
    strongEvidence.push(label);
  }
  const sharedProjectEntity = firstSharedValue(
    source.projectEntities,
    recording.projectEntities,
  );
  if (sharedProjectEntity !== undefined) {
    score += 0.1;
    const label = `明确项目实体：${sharedProjectEntity}`;
    evidence.push(label);
    strongEvidence.push(label);
  }

  const eventDurationSeconds = (end - start) / 1_000;
  if (recording.durationSeconds <= eventDurationSeconds + 5 * 60) {
    score += 0.05;
    evidence.push('录音时长与日程长度相容');
  }
  if (recording.transcriptComplete) {
    score += 0.05;
    evidence.push('原文已完成转写');
  }

  return {
    recording,
    score: Math.min(1, Number(score.toFixed(3))),
    evidence,
    strongEvidence,
  };
}

function confidence(score: number): QianwenMatchConfidence {
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

export function qianwenEvidence(recording: QianwenRecording): QianwenMeetingEvidence {
  return {
    recordingId: recording.id,
    title: recording.title,
    createdAt: recording.createdAt,
    durationSeconds: recording.durationSeconds,
    sourceUrl: recording.sourceUrl,
    summary: recording.summary,
  };
}

function previewFromCandidates(
  source: DingTalkMeetingSource,
  candidates: readonly QianwenMatchCandidate[],
  selectedIndex = 0,
): QianwenMeetingPreview {
  const selected = candidates[selectedIndex];
  if (selected === undefined) {
    return {
      source,
      recording: null,
      confidence: 'low',
      score: 0,
      conflict: false,
      readyToWrite: false,
      reason: '未找到千问听记候选，加入最近 3 天补扫队列',
      plannedNotePath: buildMeetingNotePath(source),
      candidates: [...candidates],
    };
  }
  const matchConfidence = confidence(selected.score);
  const conflict = candidates.some((candidate, index) => index !== selectedIndex
    && candidate.score >= 0.55
    && Math.abs(selected.score - candidate.score) <= 0.08);
  const readyToWrite = matchConfidence === 'high'
    && !conflict
    && selected.recording.transcriptComplete
    && selected.strongEvidence.length >= 2;
  const reason = !selected.recording.transcriptComplete
      ? '千问听记尚未完成转写，加入最近 3 天补扫队列'
      : conflict
        ? '存在多个接近候选，需要人工确认'
      : selected.strongEvidence.length < 2
        ? '独立强证据不足，需要人工确认'
        : matchConfidence === 'high'
          ? '高置信度且强证据充分，可以写入会议笔记'
        : matchConfidence === 'medium'
          ? '中置信度，需要人工确认'
          : '低置信度，不写入会议笔记';
  return {
    source,
    recording: selected.recording,
    confidence: matchConfidence,
    score: selected.score,
    conflict,
    readyToWrite,
    reason,
    plannedNotePath: buildMeetingNotePath(source),
    candidates: [...candidates],
  };
}

export function buildQianwenMeetingPreview(
  source: DingTalkMeetingSource,
  recordings: readonly QianwenRecording[],
): QianwenMeetingPreview {
  const candidates = recordings
    .map((recording) => matchScore(source, recording))
    .sort((left, right) => right.score - left.score || left.recording.id.localeCompare(
      right.recording.id,
    ));
  return previewFromCandidates(source, candidates);
}

/**
 * Assigns each recording to at most one calendar event. Independent matching
 * would otherwise attach the same Qianwen recording to every nearby event.
 */
export function buildQianwenMeetingPreviews(
  sources: readonly DingTalkMeetingSource[],
  recordings: readonly QianwenRecording[],
): QianwenMeetingPreview[] {
  const scored = sources.map((source) => {
    const candidates = recordings
      .map((recording) => matchScore(source, recording))
      .sort((left, right) => right.score - left.score || left.recording.id.localeCompare(
        right.recording.id,
      ));
    return { source, candidates };
  }).sort((left, right) => {
    const leftScore = left.candidates[0]?.score ?? 0;
    const rightScore = right.candidates[0]?.score ?? 0;
    return rightScore - leftScore || left.source.scheduled.localeCompare(right.source.scheduled)
      || left.source.eventPath.localeCompare(right.source.eventPath);
  });

  const usedRecordings = new Set<string>();
  const previews = new Map<string, QianwenMeetingPreview>();
  for (const item of scored) {
    const selectedIndex = item.candidates.findIndex((candidate) =>
      candidate.score >= 0.55 && !usedRecordings.has(candidate.recording.id));
    if (selectedIndex === -1) {
      const base = previewFromCandidates(item.source, item.candidates);
      const best = item.candidates[0];
      if (best !== undefined && best.score < 0.55) {
        previews.set(item.source.eventPath, {
          ...base,
          recording: null,
          conflict: false,
          readyToWrite: false,
          reason: '没有达到最低匹配阈值，不写入会议笔记',
        });
      } else if (best !== undefined && usedRecordings.has(best.recording.id)) {
        previews.set(item.source.eventPath, {
          ...base,
          recording: null,
          conflict: true,
          readyToWrite: false,
          reason: '最佳听记已匹配其他日程，需要人工确认',
        });
      } else {
        previews.set(item.source.eventPath, base);
      }
      continue;
    }
    const selected = item.candidates[selectedIndex];
    if (selected === undefined) continue;
    usedRecordings.add(selected.recording.id);
    previews.set(
      item.source.eventPath,
      previewFromCandidates(item.source, item.candidates, selectedIndex),
    );
  }
  return sources.map((source) => previews.get(source.eventPath)
    ?? previewFromCandidates(source, []));
}
