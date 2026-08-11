import { createHash } from 'node:crypto';

import {
  claimQianwenScheduledScan,
  normalizeQianwenSourceScan,
  qianwenLocalDate,
  type QianwenSourceRecordingInput,
  type QianwenSourceScanInput,
} from '../obsidian-plugin/qianwen-source-state.js';
import type {
  QianwenPersistedRecording,
  QianwenPersistedRecordingVersion,
  QianwenSourceRuntimeState,
  QianwenSourceStateRepository,
} from '../storage/qianwen-source-state-repository.js';

export interface QianwenSourceConnector {
  scan(input: {
    startDate: string;
    endDate: string;
  }): Promise<QianwenSourceScanInput>;
}

interface SyncQianwenSourceInput {
  repository: QianwenSourceStateRepository;
  connector: QianwenSourceConnector;
  now: Date;
  timeZone: string;
  mode: 'scheduled' | 'manual';
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

function stateWithCheckpoint(
  state: QianwenSourceRuntimeState,
  targetDate: string,
): QianwenSourceRuntimeState {
  return {
    ...state,
    lastAttemptedDate: targetDate,
  };
}

function recordingFingerprint(recording: QianwenSourceRecordingInput): string {
  return createHash('sha256').update(JSON.stringify({
    id: recording.id,
    title: recording.title ?? null,
    createdAt: recording.createdAt ?? null,
    durationSeconds: recording.durationSeconds ?? null,
    sourceUrl: recording.sourceUrl ?? null,
    transcriptComplete: recording.transcriptComplete,
    transcript: recording.transcript,
    summary: recording.summary ?? '',
    transcriptionError: recording.transcriptionError?.trim() || null,
  })).digest('hex');
}

function persistedVersion(
  recording: QianwenSourceRecordingInput,
  version: number,
  capturedAt: string,
  snapshot: ReturnType<typeof normalizeQianwenSourceScan>,
): QianwenPersistedRecordingVersion {
  const normalized = snapshot.recordings.find(({ id }) => id === recording.id);
  if (normalized === undefined) throw new Error('千问听记状态缺失');
  return {
    id: recording.id,
    version,
    fingerprint: recordingFingerprint(recording),
    capturedAt,
    status: normalized.status,
    error: normalized.error,
    title: recording.title ?? null,
    createdAt: recording.createdAt ?? null,
    durationSeconds: recording.durationSeconds ?? null,
    sourceUrl: recording.sourceUrl ?? null,
    transcriptComplete: recording.transcriptComplete,
    transcript: recording.transcript,
    summary: recording.summary ?? '',
  };
}

function mergeRecordings(
  current: QianwenSourceRuntimeState['recordings'],
  sourceScan: QianwenSourceScanInput,
  snapshot: ReturnType<typeof normalizeQianwenSourceScan>,
): QianwenSourceRuntimeState['recordings'] {
  const next = { ...current };
  for (const recording of sourceScan.recordings) {
    const previous = current[recording.id];
    const fingerprint = recordingFingerprint(recording);
    const currentVersion = previous?.versions.find(({ version }) => (
      version === previous.currentVersion
    ));
    if (currentVersion?.fingerprint === fingerprint) continue;
    const version = (previous?.currentVersion ?? 0) + 1;
    const entry = persistedVersion(recording, version, sourceScan.scannedAt, snapshot);
    const versions = [...(previous?.versions ?? []), entry];
    next[recording.id] = { currentVersion: version, versions } satisfies QianwenPersistedRecording;
  }
  return next;
}

export async function syncQianwenSource(input: SyncQianwenSourceInput): Promise<
  | { status: 'not_due' }
  | { status: 'completed'; snapshot: ReturnType<typeof normalizeQianwenSourceScan> }
> {
  const synchronize = async (): Promise<
    | { status: 'not_due' }
    | { status: 'completed'; snapshot: ReturnType<typeof normalizeQianwenSourceScan> }
  > => {
    const current = await input.repository.load();
    const claim = input.mode === 'manual'
      ? {
          targetDate: qianwenLocalDate(input.now, input.timeZone),
          checkpoint: { lastAttemptedDate: qianwenLocalDate(input.now, input.timeZone) },
        }
      : claimQianwenScheduledScan({
          now: input.now,
          lastAttemptedDate: current.lastAttemptedDate,
          timeZone: input.timeZone,
        });
    if (claim === null) return { status: 'not_due' };

    await input.repository.save(stateWithCheckpoint(current, claim.targetDate));

    let sourceScan: QianwenSourceScanInput;
    try {
      sourceScan = await input.connector.scan({
        startDate: shiftDate(claim.targetDate, -6),
        endDate: claim.targetDate,
      });
    } catch {
      sourceScan = {
        connectorStatus: 'network_failed',
        scannedAt: input.now.toISOString(),
        range: {
          startDate: shiftDate(claim.targetDate, -6),
          endDate: claim.targetDate,
        },
        recordings: [],
      };
    }
    const snapshot = normalizeQianwenSourceScan(sourceScan);
    const next: QianwenSourceRuntimeState = {
      schemaVersion: 2,
      lastAttemptedDate: claim.targetDate,
      lastScan: snapshot,
      lastSuccessfulScan: snapshot.connector.resultKind === 'success'
        ? snapshot
        : current.lastSuccessfulScan,
      recordings: snapshot.connector.resultKind === 'success'
        ? mergeRecordings(current.recordings, sourceScan, snapshot)
        : current.recordings,
    };
    await input.repository.save(next);
    return { status: 'completed', snapshot };
  };
  return input.repository.withLock === undefined
    ? synchronize()
    : input.repository.withLock(synchronize);
}
