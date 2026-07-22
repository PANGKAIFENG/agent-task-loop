export type DingTalkRemoteState = 'active' | 'cancelled';

export interface DingTalkRemoteSnapshot {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  description: string | null;
  location: string | null;
  state: DingTalkRemoteState;
}

export interface DingTalkEventLedgerEntry {
  eventKeyHash: string;
  remoteUid: string;
  recurrenceId: string | null;
  href: string;
  etag: string | null;
  taskPath: string | null;
  remoteSnapshotHash: string;
  remoteSnapshot: DingTalkRemoteSnapshot;
  lastSeenAt: string;
  locallyDeletedAt: string | null;
  cancelledBySync: boolean;
}

export interface DingTalkSyncResult {
  startedAt: string;
  finishedAt: string;
  added: number;
  updated: number;
  cancelled: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

export interface DingTalkCalendarSettings {
  stateVersion: 1;
  enabled: boolean;
  serverUrl: string;
  username: string;
  calendarId: 'primary';
  syncWindowDays: 90;
  intervalMinutes: 15;
  syncToken: string | null;
  autoCompleteThrough: string | null;
  lastSuccessfulSyncAt: string | null;
  lastResult: DingTalkSyncResult | null;
  lastError: string | null;
  events: Record<string, DingTalkEventLedgerEntry>;
}
