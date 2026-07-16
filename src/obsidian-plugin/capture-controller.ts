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

export interface CaptureCandidateView extends ExtractedCandidate {
  candidateId: string;
  sourceDate: string;
  sourceNote: string;
  recordedAt: string | null;
}

export interface PreparedCapture {
  scanId: string;
  filesScanned: number;
  recordsConsidered: number;
  candidates: CaptureCandidateView[];
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

function candidateId(candidate: ExtractedCandidate): string {
  return createHash('sha256').update(JSON.stringify({
    sourceRecordFingerprint: candidate.sourceRecordFingerprint,
    title: normalizedCandidateText(candidate.title),
    sourceQuote: normalizedCandidateText(candidate.sourceQuote),
  })).digest('hex');
}

function captureInput(candidate: CaptureCandidateView): CaptureTaskInput {
  return {
    title: candidate.title,
    body: candidate.summary,
    origin: 'obsidian_sync',
    sourceDate: candidate.sourceDate,
    sourceNote: candidate.sourceNote,
    sourceQuote: candidate.sourceQuote,
    sourceKey: `obsidian_sync:${candidate.sourceRecordFingerprint}:${candidate.candidateId}`,
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
    const extracted = await this.dependencies.extractCandidates(sourceResult.records);
    const sourceByFingerprint = new Map(sourceResult.records.map((record) => (
      [record.fingerprint, record] as const
    )));
    const reviewed = new Set(state.reviewedFingerprints);
    const seen = new Set<string>();
    const candidates: CaptureCandidateView[] = [];
    for (const candidate of extracted) {
      const source = sourceByFingerprint.get(candidate.sourceRecordFingerprint);
      if (source === undefined) {
        throw new Error('Candidate references an unknown source record');
      }
      const id = candidateId(candidate);
      if (reviewed.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        ...candidate,
        candidateId: id,
        sourceDate: source.sourceDate,
        sourceNote: source.sourceNote,
        recordedAt: source.recordedAt,
      });
    }
    return {
      scanId: this.createScanId(),
      filesScanned: sourceResult.filesScanned,
      recordsConsidered: sourceResult.records.length,
      candidates,
      completedAt: now.toISOString(),
    };
  }

  async commit(
    prepared: PreparedCapture,
    selectedCandidateIds: readonly string[],
  ): Promise<{ createdTaskIds: string[]; existingTaskIds: string[] }> {
    const selected = new Set(selectedCandidateIds);
    const known = new Set(prepared.candidates.map(({ candidateId: id }) => id));
    if ([...selected].some((id) => !known.has(id))) {
      throw new Error('Selected candidate is not part of this scan');
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

    const state = this.dependencies.getState();
    await this.dependencies.saveState({
      lastSuccessfulScanAt: prepared.completedAt,
      reviewedFingerprints: compactReviewedFingerprints([
        ...state.reviewedFingerprints,
        ...prepared.candidates.map(({ candidateId: id }) => id),
      ]),
    });
    return { createdTaskIds, existingTaskIds };
  }
}
