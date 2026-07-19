import { createHash, randomUUID } from 'node:crypto';

import {
  captureTask,
  type CaptureTaskInput,
} from '../services/capture-task.js';
import type { ServiceContext } from '../services/service-context.js';
import type { ExtractedCandidate } from './candidate-extractor.js';
import {
  compactReviewedFingerprints,
  type CaptureState,
} from './settings.js';
import type { SyncSourceRecord } from './sync-source-reader.js';

export interface CaptureSourceEvidence {
  sourceRecordFingerprint: string;
  sourceDate: string;
  sourceNote: string;
  recordedAt: string | null;
  sourceQuote: string;
}

export interface CaptureCandidateView extends ExtractedCandidate {
  candidateId: string;
  sourceDate: string;
  sourceNote: string;
  recordedAt: string | null;
  sourceRecordFingerprints: string[];
  sourceEvidence: CaptureSourceEvidence[];
}

export interface PreparedCapture {
  scanId: string;
  filesScanned: number;
  recordsConsidered: number;
  candidates: CaptureCandidateView[];
  processedRecordFingerprints: string[];
  completedAt: string;
}

export interface CaptureControllerDependencies {
  context: ServiceContext;
  readSources(input: {
    now: Date;
    lastSuccessfulScanAt: string | null;
  }): Promise<{ filesScanned: number; records: SyncSourceRecord[] }>;
  extractCandidates(records: readonly SyncSourceRecord[]): Promise<ExtractedCandidate[]>;
  getState(): CaptureState;
  saveState(state: CaptureState): Promise<void>;
  clock?: () => Date;
  scanId?: () => string;
  capture?: typeof captureTask;
}

function normalizedCandidateText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function candidateId(candidate: Omit<CaptureCandidateView, 'candidateId'>): string {
  return createHash('sha256').update(JSON.stringify({
    sourceRecordFingerprints: candidate.sourceRecordFingerprints,
    topicKey: normalizedCandidateText(candidate.topicKey),
    title: normalizedCandidateText(candidate.title),
  })).digest('hex');
}

function clusteredBody(candidate: CaptureCandidateView): string {
  const evidence = candidate.sourceEvidence.map((item) => [
    `### ${item.sourceDate}`,
    `- 来源：${item.sourceNote}`,
    `- 原文：${item.sourceQuote}`,
  ].join('\n')).join('\n\n');
  return `${candidate.summary}\n\n## 来源依据\n\n${evidence}`;
}

function captureInput(candidate: CaptureCandidateView): CaptureTaskInput {
  return {
    title: candidate.title,
    body: clusteredBody(candidate),
    origin: 'obsidian_sync',
    sourceDate: candidate.sourceDate,
    sourceNote: candidate.sourceNote,
    sourceQuote: candidate.sourceQuote,
    sourceKey: `obsidian_sync:${candidate.sourceRecordFingerprints.join(':')}:${candidate.candidateId}`,
    priority: candidate.priority,
  };
}

export class CaptureController {
  private readonly clock: () => Date;
  private readonly createScanId: () => string;
  private readonly capture: typeof captureTask;

  constructor(private readonly dependencies: CaptureControllerDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.createScanId = dependencies.scanId ?? randomUUID;
    this.capture = dependencies.capture ?? captureTask;
  }

  async scan(): Promise<PreparedCapture> {
    const state = this.dependencies.getState();
    const now = this.clock();
    const sourceResult = await this.dependencies.readSources({
      now,
      lastSuccessfulScanAt: state.lastSuccessfulScanAt,
    });
    const processed = new Set(state.processedRecordFingerprints);
    const records = sourceResult.records.filter(({ fingerprint }) => (
      !processed.has(fingerprint)
    ));
    const extracted = await this.dependencies.extractCandidates(records);
    const sourceByFingerprint = new Map(records.map((record) => (
      [record.fingerprint, record] as const
    )));
    const reviewed = new Set(state.reviewedFingerprints);
    const grouped = new Map<string, Omit<CaptureCandidateView, 'candidateId'>>();
    for (const candidate of extracted) {
      const source = sourceByFingerprint.get(candidate.sourceRecordFingerprint);
      if (source === undefined) {
        throw new Error('Candidate references an unknown source record');
      }
      const evidence: CaptureSourceEvidence = {
        sourceRecordFingerprint: source.fingerprint,
        sourceDate: source.sourceDate,
        sourceNote: source.sourceNote,
        recordedAt: source.recordedAt,
        sourceQuote: candidate.sourceQuote,
      };
      const groupKey = normalizedCandidateText(candidate.topicKey);
      const existing = grouped.get(groupKey);
      if (existing !== undefined) {
        if (!existing.sourceRecordFingerprints.includes(source.fingerprint)) {
          existing.sourceRecordFingerprints.push(source.fingerprint);
          existing.sourceEvidence.push(evidence);
        }
        if (!existing.summary.includes(candidate.summary)) {
          existing.summary = `${existing.summary}\n\n${candidate.summary}`.slice(0, 2_000);
        }
        continue;
      }
      grouped.set(groupKey, {
        ...candidate,
        sourceDate: source.sourceDate,
        sourceNote: source.sourceNote,
        recordedAt: source.recordedAt,
        sourceRecordFingerprints: [source.fingerprint],
        sourceEvidence: [evidence],
      });
    }
    const seen = new Set<string>();
    const candidates: CaptureCandidateView[] = [];
    for (const candidate of grouped.values()) {
      const id = candidateId(candidate);
      if (reviewed.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ ...candidate, candidateId: id });
    }
    return {
      scanId: this.createScanId(),
      filesScanned: sourceResult.filesScanned,
      recordsConsidered: records.length,
      candidates,
      processedRecordFingerprints: records.map(({ fingerprint }) => fingerprint),
      completedAt: now.toISOString(),
    };
  }

  async commit(
    prepared: PreparedCapture,
    selectedCandidateIds: readonly string[],
    ignoredCandidateIds: readonly string[] = [],
  ): Promise<{ createdTaskIds: string[]; existingTaskIds: string[] }> {
    const selected = new Set(selectedCandidateIds);
    const ignored = new Set(ignoredCandidateIds);
    const known = new Set(prepared.candidates.map(({ candidateId: id }) => id));
    if (
      [...selected, ...ignored].some((id) => !known.has(id))
      || [...selected].some((id) => ignored.has(id))
    ) {
      throw new Error('Resolved candidate is not part of this scan');
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
        createdTaskIds.push(task.taskId);
        existingIds.add(task.taskId);
      }
    }

    const resolved = new Set([...selected, ...ignored]);
    const candidateIdsByRecord = new Map<string, string[]>();
    for (const candidate of prepared.candidates) {
      for (const fingerprint of candidate.sourceRecordFingerprints) {
        const ids = candidateIdsByRecord.get(fingerprint) ?? [];
        ids.push(candidate.candidateId);
        candidateIdsByRecord.set(fingerprint, ids);
      }
    }
    const resolvedRecordFingerprints = [...candidateIdsByRecord]
      .filter(([, ids]) => ids.every((id) => resolved.has(id)))
      .map(([fingerprint]) => fingerprint);
    const state = this.dependencies.getState();
    await this.dependencies.saveState({
      captureStateVersion: 2,
      lastSuccessfulScanAt: prepared.completedAt,
      reviewedFingerprints: compactReviewedFingerprints([
        ...state.reviewedFingerprints,
        ...resolved,
      ]),
      processedRecordFingerprints: compactReviewedFingerprints([
        ...state.processedRecordFingerprints,
        ...resolvedRecordFingerprints,
      ]),
    });
    return { createdTaskIds, existingTaskIds };
  }
}
