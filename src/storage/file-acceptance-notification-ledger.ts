import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type {
  AcceptanceNotificationLedger,
  AcceptanceNotificationRecord,
} from '../services/notify-acceptance.js';
import {
  acquireSafeFileLock,
  atomicWriteTextFile,
  reclaimExpiredSafeFileLock,
} from './file-io.js';

const LOCK_LEASE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().min(1).max(600),
  objectType: z.enum(['artifact', 'weekly']),
  objectId: z.string().min(1).max(256),
  version: z.number().int().nonnegative(),
  uuid: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
  status: z.enum(['sent', 'failed', 'conflict']),
  attemptedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u).nullable(),
  taskId: z.string().min(1).max(256).nullable(),
  messageId: z.string().min(1).max(256).nullable(),
}).strict().superRefine((record, context) => {
  const expectedKey = `${record.objectType}:${record.objectId}:${record.version}`;
  if (record.idempotencyKey !== expectedKey) {
    context.addIssue({ code: 'custom', message: 'Invalid notification idempotency key' });
  }
  if (
    (record.status === 'sent' && record.errorCode !== null)
    || (record.status !== 'sent' && record.errorCode === null)
  ) {
    context.addIssue({ code: 'custom', message: 'Invalid notification result state' });
  }
});

const ledgerSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(recordSchema),
}).strict();

export class AcceptanceNotificationLedgerLockTimeoutError extends Error {
  readonly code = 'acceptance_ledger_lock_timeout';

  constructor() {
    super('Acceptance notification ledger lock timed out');
    this.name = 'AcceptanceNotificationLedgerLockTimeoutError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileAcceptanceNotificationLedger implements AcceptanceNotificationLedger {
  private readonly path: string;
  private readonly lockRoot: string;

  constructor(private readonly runtimeRoot: string) {
    this.path = join(runtimeRoot, 'acceptance-notifications.json');
    this.lockRoot = join(runtimeRoot, 'acceptance-notification-locks');
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.prepareRuntimeRoot();
    const lockPath = join(this.lockRoot, 'ledger.lock');
    const boundary = {
      vaultRoot: dirname(this.runtimeRoot),
      tasksRoot: this.runtimeRoot,
      subtree: this.lockRoot,
    };
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const now = new Date();
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: now,
        leaseMs: LOCK_LEASE_MS,
      });
      if (lock === null && await reclaimExpiredSafeFileLock(lockPath, boundary, now)) {
        lock = await acquireSafeFileLock(lockPath, boundary, {
          acquiredAt: now,
          leaseMs: LOCK_LEASE_MS,
        });
      }
      if (lock !== null) {
        try {
          return await operation();
        } finally {
          await lock.release();
        }
      }
      if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
    }
    throw new AcceptanceNotificationLedgerLockTimeoutError();
  }

  async get(idempotencyKey: string): Promise<AcceptanceNotificationRecord | null> {
    return (await this.load()).records.find((record) => (
      record.idempotencyKey === idempotencyKey
    )) ?? null;
  }

  async save(record: AcceptanceNotificationRecord): Promise<void> {
    const parsed = recordSchema.parse(record);
    const current = await this.load();
    const records = current.records.filter((candidate) => (
      candidate.idempotencyKey !== parsed.idempotencyKey
    ));
    records.push(parsed);
    records.sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    await atomicWriteTextFile(this.path, `${JSON.stringify({
      schemaVersion: 1,
      records,
    }, null, 2)}\n`);
  }

  async list(): Promise<AcceptanceNotificationRecord[]> {
    return (await this.load()).records;
  }

  private async prepareRuntimeRoot(): Promise<void> {
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const runtimeMetadata = await lstat(this.runtimeRoot);
    if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
      throw new Error('Invalid ATL runtime root');
    }
    await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
  }

  private async load(): Promise<{ schemaVersion: 1; records: AcceptanceNotificationRecord[] }> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return ledgerSchema.parse(parsed);
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        return { schemaVersion: 1, records: [] };
      }
      throw error;
    }
  }
}
