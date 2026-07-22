import { createHash } from 'node:crypto';

import {
  captureTask,
  type CaptureTaskInput,
} from '../services/capture-task.js';
import type { ServiceContext } from '../services/service-context.js';
import type { MeetingAnalysisResult } from './meeting-analysis.js';
import type {
  CaptureCandidateView,
  PreparedCapture,
} from './capture-controller.js';

export interface PreparedMeetingCandidates extends PreparedCapture {
  meetingNotePath: string;
}

export interface PrepareMeetingCandidatesInput {
  meetingNotePath: string;
  meetingDate: string;
  analysis: MeetingAnalysisResult;
}

export interface MeetingCandidateControllerDependencies {
  context: ServiceContext;
  capture?: typeof captureTask;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function candidateView(
  input: PrepareMeetingCandidatesInput,
  candidate: MeetingAnalysisResult['taskCandidates'][number],
): CaptureCandidateView {
  const sourceRecordFingerprint = digest({
    meetingNotePath: input.meetingNotePath,
    title: normalizedTitle(candidate.title),
    sourceQuote: candidate.sourceQuote,
  });
  const candidateId = digest({
    origin: 'obsidian_meeting',
    sourceRecordFingerprint,
  });
  return {
    candidateId,
    title: candidate.title,
    summary: candidate.explanation,
    priority: candidate.priority,
    topicKey: normalizedTitle(candidate.title),
    sourceRecordFingerprint,
    sourceRecordFingerprints: [sourceRecordFingerprint],
    sourceQuote: candidate.sourceQuote,
    sourceDate: input.meetingDate,
    sourceNote: input.meetingNotePath,
    recordedAt: null,
    sourceEvidence: [{
      sourceRecordFingerprint,
      sourceDate: input.meetingDate,
      sourceNote: input.meetingNotePath,
      recordedAt: null,
      sourceQuote: candidate.sourceQuote,
    }],
  };
}

function captureInput(candidate: CaptureCandidateView): CaptureTaskInput {
  return {
    title: candidate.title,
    body: [
      candidate.summary,
      '',
      '## 会议依据',
      `- 会议笔记：${candidate.sourceNote}`,
      `- 原文：${candidate.sourceQuote}`,
    ].join('\n'),
    origin: 'obsidian_meeting',
    sourceDate: candidate.sourceDate,
    sourceNote: candidate.sourceNote,
    sourceQuote: candidate.sourceQuote,
    sourceKey: `obsidian_meeting:${candidate.candidateId}`,
    priority: candidate.priority,
  };
}

export class MeetingCandidateController {
  private readonly capture: typeof captureTask;

  constructor(private readonly dependencies: MeetingCandidateControllerDependencies) {
    this.capture = dependencies.capture ?? captureTask;
  }

  prepare(input: PrepareMeetingCandidatesInput): PreparedMeetingCandidates {
    if (
      input.meetingNotePath.trim() === ''
      || !/^\d{4}-\d{2}-\d{2}$/u.test(input.meetingDate)
    ) {
      throw new Error('会议候选来源无效');
    }
    const candidates = input.analysis.taskCandidates.map((candidate) => (
      candidateView(input, candidate)
    ));
    const meetingDigest = digest({
      meetingNotePath: input.meetingNotePath,
      meetingDate: input.meetingDate,
      candidateIds: candidates.map(({ candidateId }) => candidateId),
    });
    return {
      scanId: `meeting-${meetingDigest}`,
      meetingNotePath: input.meetingNotePath,
      filesScanned: 1,
      recordsConsidered: candidates.length,
      candidates,
      processedRecordFingerprints: candidates.map((candidate) => (
        candidate.sourceRecordFingerprint
      )),
      completedAt: `${input.meetingDate}T00:00:00.000Z`,
    };
  }

  async commit(
    prepared: PreparedMeetingCandidates,
    selectedCandidateIds: readonly string[],
  ): Promise<{ createdTaskIds: string[]; existingTaskIds: string[] }> {
    const selected = new Set(selectedCandidateIds);
    const known = new Set(prepared.candidates.map(({ candidateId }) => candidateId));
    if ([...selected].some((candidateId) => !known.has(candidateId))) {
      throw new Error('所选候选不属于当前会议');
    }

    const existingIds = new Set(
      (await this.dependencies.context.tasks.list()).map(({ taskId }) => taskId),
    );
    const createdTaskIds: string[] = [];
    const existingTaskIds: string[] = [];
    for (const candidate of prepared.candidates) {
      if (!selected.has(candidate.candidateId)) continue;
      const task = await this.capture(
        this.dependencies.context,
        captureInput(candidate),
      );
      if (existingIds.has(task.taskId)) {
        existingTaskIds.push(task.taskId);
      } else {
        existingIds.add(task.taskId);
        createdTaskIds.push(task.taskId);
      }
    }
    return { createdTaskIds, existingTaskIds };
  }
}
