export type QianwenConnectorStatus =
  | 'connected'
  | 'login_required'
  | 'incompatible'
  | 'network_failed';

export type QianwenRecordingStatus = 'waiting' | 'available' | 'failed';

export interface QianwenSourceRecordingInput {
  id: string;
  title?: string;
  createdAt?: string;
  durationSeconds?: number;
  sourceUrl?: string;
  transcriptComplete: boolean;
  transcript: string;
  summary?: string;
  transcriptionError?: string;
}

export interface QianwenSourceScanInput {
  connectorStatus: QianwenConnectorStatus;
  scannedAt: string;
  range: { startDate: string; endDate: string };
  recordings: readonly QianwenSourceRecordingInput[];
}

export interface QianwenSourceSnapshot {
  connector: {
    status: QianwenConnectorStatus;
    resultKind: 'success' | 'failed';
    scannedAt: string;
    range: { startDate: string; endDate: string };
  };
  recordings: Array<{
    id: string;
    status: QianwenRecordingStatus;
    error: string | null;
  }>;
}

function recordingStatus(input: QianwenSourceRecordingInput): {
  status: QianwenRecordingStatus;
  error: string | null;
} {
  const error = input.transcriptionError?.trim();
  if (error !== undefined && error !== '') return { status: 'failed', error };
  if (!input.transcriptComplete) return { status: 'waiting', error: null };
  if (input.transcript.trim() === '') {
    return { status: 'failed', error: '转写已完成但原文为空' };
  }
  return { status: 'available', error: null };
}

export function normalizeQianwenSourceScan(
  input: QianwenSourceScanInput,
): QianwenSourceSnapshot {
  return {
    connector: {
      status: input.connectorStatus,
      resultKind: input.connectorStatus === 'connected' ? 'success' : 'failed',
      scannedAt: input.scannedAt,
      range: { ...input.range },
    },
    recordings: input.recordings.map((recording) => ({
      id: recording.id,
      ...recordingStatus(recording),
    })),
  };
}

interface ClaimScheduledScanInput {
  now: Date;
  lastAttemptedDate: string | null;
  timeZone: string;
}

interface LocalDateTime {
  date: string;
  hour: number;
}

function localDateTime(date: Date, timeZone: string): LocalDateTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

export function qianwenLocalDate(date: Date, timeZone: string): string {
  return localDateTime(date, timeZone).date;
}

function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - 1));
  return shifted.toISOString().slice(0, 10);
}

export function claimQianwenScheduledScan(input: ClaimScheduledScanInput): {
  targetDate: string;
  checkpoint: { lastAttemptedDate: string };
} | null {
  const local = localDateTime(input.now, input.timeZone);
  const targetDate = local.hour >= 22 ? local.date : previousDate(local.date);
  if (input.lastAttemptedDate !== null && input.lastAttemptedDate >= targetDate) {
    return null;
  }
  return {
    targetDate,
    checkpoint: { lastAttemptedDate: targetDate },
  };
}
