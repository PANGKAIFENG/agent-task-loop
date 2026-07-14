import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AuditEvent, AuditLog } from './contracts.js';
import { listSafeRegularFiles, readSafeTextFile } from './file-io.js';
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
    || Number.isNaN(Date.parse(event.at))
  ) {
    throw new InvalidAuditEventError();
  }
  for (const key of ['taskId', 'projectId', 'runId']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') {
      throw new InvalidAuditEventError();
    }
  }
  if (event.details !== undefined) {
    if (typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) {
      throw new InvalidAuditEventError();
    }
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
    }
  }
  return value as AuditEvent;
}

function parseAuditFile(raw: string): AuditEvent[] {
  return raw.split('\n').filter((line) => line !== '').map((line) => {
    try {
      return validateEvent(JSON.parse(line) as unknown);
    } catch {
      throw new InvalidAuditEventError();
    }
  });
}

async function readAuditFile(path: string, auditRoot: string): Promise<AuditEvent[]> {
  const raw = await readSafeTextFile(path, auditRoot);
  return raw === null ? [] : parseAuditFile(raw);
}

export class FileAuditLog implements AuditLog {
  readonly root: string;
  readonly auditRoot: string;

  constructor(root?: string) {
    this.root = vaultRoot(root);
    this.auditRoot = join(taskStorageRoot(this.root), 'Audit');
  }

  async append(event: AuditEvent): Promise<void> {
    assertVaultWriteAllowed(this.root);
    const validEvent = validateEvent(event);
    const localDate = validEvent.at.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      throw new InvalidAuditEventError();
    }
    const path = auditFilePath(this.root, localDate);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(validEvent)}\n`, 'utf8');
  }

  async count(query: {
    event: string;
    localDate: string;
    mode?: 'automatic' | 'manual';
  }): Promise<number> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.localDate)) {
      throw new InvalidAuditEventError();
    }
    let path: string;
    try {
      path = auditFilePath(this.root, query.localDate);
    } catch {
      return 0;
    }
    const events = await readAuditFile(
      path,
      this.auditRoot,
    );
    return events.filter((event) => (
      event.event === query.event
      && (query.mode === undefined || event.details?.mode === query.mode)
    )).length;
  }

  async listForTask(taskId: string): Promise<AuditEvent[]> {
    const paths = await listSafeRegularFiles(this.auditRoot, '*.jsonl');
    const events = (await Promise.all(
      paths.map((path) => readAuditFile(path, this.auditRoot)),
    )).flat();
    return events
      .filter((event) => event.taskId === taskId)
      .sort((left, right) => (
        Date.parse(left.at) - Date.parse(right.at)
        || left.at.localeCompare(right.at)
      ));
  }
}
