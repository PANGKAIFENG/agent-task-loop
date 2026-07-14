import { join } from 'node:path';

import type { AuditEvent, AuditLog } from './contracts.js';
import {
  appendSafeTextFile,
  InvalidStorageEntryError,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import {
  assertVaultWriteAllowed,
  auditFilePath,
  taskStorageRoot,
  vaultRoot,
} from './task-paths.js';

export class InvalidAuditEventError extends Error {
  readonly code = 'invalid_audit_event';

  constructor() {
    super('Invalid audit event');
    this.name = 'InvalidAuditEventError';
  }
}

export class AuditEventTooLargeError extends Error {
  readonly code = 'audit_event_too_large';

  constructor() {
    super('Audit event exceeds size limit');
    this.name = 'AuditEventTooLargeError';
  }
}

export class AuditCorruptionError extends Error {
  readonly code = 'audit_corruption';

  constructor() {
    super('Audit data is corrupted');
    this.name = 'AuditCorruptionError';
  }
}

const MAX_AUDIT_EVENT_BYTES = 64 * 1024;
const RFC_3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isRfc3339Timestamp(value: string): boolean {
  const match = RFC_3339_TIMESTAMP.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= (daysInMonth[month - 1] ?? 0)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function isLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  return isRfc3339Timestamp(`${value}T00:00:00Z`);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'boolean';
}

function validateEvent(value: unknown): AuditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidAuditEventError();
  }
  const event = value as Record<string, unknown>;
  const allowedKeys = new Set(['event', 'at', 'taskId', 'projectId', 'runId', 'details']);
  if (
    Object.keys(event).some((key) => !allowedKeys.has(key))
    || typeof event.event !== 'string'
    || event.event === ''
    || typeof event.at !== 'string'
    || !isRfc3339Timestamp(event.at)
  ) {
    throw new InvalidAuditEventError();
  }
  for (const key of ['taskId', 'projectId', 'runId']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') {
      throw new InvalidAuditEventError();
    }
  }
  const validEvent: AuditEvent = {
    event: event.event,
    at: event.at,
  };
  if (typeof event.taskId === 'string') {
    validEvent.taskId = event.taskId;
  }
  if (typeof event.projectId === 'string') {
    validEvent.projectId = event.projectId;
  }
  if (typeof event.runId === 'string') {
    validEvent.runId = event.runId;
  }
  if (event.details !== undefined) {
    if (typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) {
      throw new InvalidAuditEventError();
    }
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, detail] of Object.entries(event.details)) {
      const normalizedKey = key.toLowerCase();
      const compactKey = normalizedKey.replaceAll(/[^a-z0-9]/g, '');
      const sensitive = compactKey.includes('prompt')
        || compactKey.includes('apikey')
        || compactKey.includes('authorization')
        || compactKey.includes('credential')
        || compactKey.includes('cookie')
        || compactKey.includes('secret')
        || compactKey.includes('password')
        || compactKey.includes('token')
        || compactKey.includes('env')
        || compactKey.includes('note')
        || compactKey.includes('body')
        || compactKey.includes('content');
      if (!isScalar(detail) || (sensitive && detail !== null)) {
        throw new InvalidAuditEventError();
      }
      details[key] = detail;
    }
    validEvent.details = details;
  }
  return validEvent;
}

function parseAuditFile(raw: string): AuditEvent[] {
  if (raw === '') {
    return [];
  }
  if (!raw.endsWith('\n')) {
    throw new AuditCorruptionError();
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.some((line) => line === '')) {
    throw new AuditCorruptionError();
  }
  return lines.map((line) => {
    try {
      return validateEvent(JSON.parse(line) as unknown);
    } catch {
      throw new AuditCorruptionError();
    }
  });
}

async function readAuditFile(
  path: string,
  boundary: StorageReadBoundary,
): Promise<AuditEvent[]> {
  const raw = await readSafeTextFile(path, boundary);
  return raw === null ? [] : parseAuditFile(raw);
}

export class FileAuditLog implements AuditLog {
  readonly root: string;
  readonly tasksRoot: string;
  readonly auditRoot: string;
  readonly dateFormatter: Intl.DateTimeFormat;

  constructor(root?: string, options: { timeZone?: string } = {}) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.auditRoot = join(this.tasksRoot, 'Audit');
    try {
      this.dateFormatter = new Intl.DateTimeFormat('en-CA', {
        calendar: 'iso8601',
        day: '2-digit',
        month: '2-digit',
        numberingSystem: 'latn',
        timeZone: options.timeZone
          ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        year: 'numeric',
      });
    } catch {
      throw new InvalidAuditEventError();
    }
  }

  async append(event: AuditEvent): Promise<void> {
    assertVaultWriteAllowed(this.root);
    const validEvent = validateEvent(event);
    const localDate = this.localDate(validEvent.at);
    let path: string;
    try {
      path = auditFilePath(this.root, localDate);
    } catch {
      throw new InvalidStorageEntryError();
    }
    const serialized = JSON.stringify(validEvent);
    const content = Buffer.from(`${serialized}\n`, 'utf8');
    if (content.length > MAX_AUDIT_EVENT_BYTES) {
      throw new AuditEventTooLargeError();
    }
    await appendSafeTextFile(path, content, this.readBoundary());
  }

  async count(query: {
    event: string;
    localDate: string;
    mode?: 'automatic' | 'manual';
  }): Promise<number> {
    if (!isLocalDate(query.localDate)) {
      throw new InvalidAuditEventError();
    }
    let path: string;
    try {
      path = auditFilePath(this.root, query.localDate);
    } catch {
      return 0;
    }
    const events = await readAuditFile(path, this.readBoundary());
    return events.filter((event) => (
      event.event === query.event
      && (query.mode === undefined || event.details?.mode === query.mode)
    )).length;
  }

  async listForTask(taskId: string): Promise<AuditEvent[]> {
    const boundary = this.readBoundary();
    const paths = await listSafeRegularFiles(boundary, '*.jsonl');
    const events = (await Promise.all(
      paths.map((path) => readAuditFile(path, boundary)),
    )).flat();
    return events
      .filter((event) => event.taskId === taskId)
      .sort((left, right) => (
        Date.parse(left.at) - Date.parse(right.at)
        || left.at.localeCompare(right.at)
      ));
  }

  private readBoundary(): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: this.auditRoot,
    };
  }

  private localDate(timestamp: string): string {
    const parts = Object.fromEntries(this.dateFormatter.formatToParts(
      new Date(timestamp),
    ).map(({ type, value }) => [type, value]));
    const localDate = `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
    if (!isLocalDate(localDate)) {
      throw new InvalidAuditEventError();
    }
    return localDate;
  }
}
