import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { MulticaResponseLedgerRecord } from '../services/process-multica-reply.js';
import {
  acquireSafeFileLock,
  atomicWriteTextFile,
  reclaimExpiredSafeFileLock,
} from './file-io.js';

// PAW-GOAL-003 T2 (TECH §6): the four-step DingTalk response ledger. Every
// durable step transition is saved before the next external write, so a crash
// at any point resumes from the last confirmed step without duplicating the
// Multica comment or the supervisor rerun.
const LOCK_LEASE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  streamEventId: z.string().min(1).max(200),
  // Empty when the reply was rejected before a target could be parsed.
  taskId: z.string().max(256),
  eventId: z.string().min(1).max(200).nullable(),
  actionId: z.string().min(1).max(300).nullable(),
  action: z.string().max(210),
  message: z.string().min(1).max(2_000),
  trust: z.object({
    senderUserId: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    trusted: z.boolean(),
  }).strict(),
  step: z.enum([
    'received',
    'atl_recorded',
    'remote_response_confirmed',
    'supervisor_resumed',
    'completed_without_resume',
    'release_operator_started',
  ]),
  terminalStep: z.enum([
    'supervisor_resumed',
    'completed_without_resume',
    'release_operator_started',
  ]).nullable(),
  rejectedReason: z.string().min(1).max(300).nullable(),
  receivedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  recordedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
  confirmedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
  resumedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
  responseCommentId: z.string().min(1).max(200).nullable(),
  // TEP-50 fix 2: defaulted so records persisted before the field existed
  // load as `null` — the baseline has simply not been proven yet.
  baselineRunIds: z.array(z.string().min(1).max(200)).max(50).nullable().default(null),
  runIds: z.array(z.string().min(1).max(200)).max(50),
  remoteWriteUnknown: z.string().min(1).max(300).nullable(),
  lastError: z.string().min(1).max(300).nullable(),
}).strict().superRefine((record, context) => {
  if (record.step === 'atl_recorded' && record.recordedAt === null) {
    context.addIssue({ code: 'custom', message: 'atl_recorded step requires recordedAt' });
  }
  if (record.step === 'remote_response_confirmed' && record.responseCommentId === null) {
    context.addIssue({ code: 'custom', message: 'confirmed step requires a response comment id' });
  }
  if (
    (record.step === 'supervisor_resumed' || record.step === 'release_operator_started')
    && record.resumedAt === null
  ) {
    context.addIssue({ code: 'custom', message: 'terminal resume step requires resumedAt' });
  }
});

const ledgerSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(recordSchema),
}).strict();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MulticaResponseLedgerLockTimeoutError extends Error {
  readonly code = 'multica_response_ledger_lock_timeout';

  constructor() {
    super('Multica response ledger lock timed out');
    this.name = 'MulticaResponseLedgerLockTimeoutError';
  }
}

export interface MulticaResponseLedger {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  get(streamEventId: string): Promise<MulticaResponseLedgerRecord | null>;
  save(record: MulticaResponseLedgerRecord): Promise<void>;
  list(): Promise<MulticaResponseLedgerRecord[]>;
}

export class FileMulticaResponseLedger implements MulticaResponseLedger {
  private readonly path: string;
  private readonly lockRoot: string;

  constructor(private readonly runtimeRoot: string) {
    this.path = join(runtimeRoot, 'multica-responses.json');
    this.lockRoot = join(runtimeRoot, 'multica-response-locks');
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
    throw new MulticaResponseLedgerLockTimeoutError();
  }

  async get(streamEventId: string): Promise<MulticaResponseLedgerRecord | null> {
    return (await this.load()).records.find((record) => (
      record.streamEventId === streamEventId
    )) ?? null;
  }

  async save(record: MulticaResponseLedgerRecord): Promise<void> {
    const parsed = recordSchema.parse(record);
    const current = await this.load();
    const records = current.records.filter((candidate) => (
      candidate.streamEventId !== parsed.streamEventId
    ));
    records.push(parsed);
    records.sort((left, right) => left.streamEventId.localeCompare(right.streamEventId));
    await atomicWriteTextFile(this.path, `${JSON.stringify({
      schemaVersion: 1,
      records,
    }, null, 2)}\n`);
  }

  async list(): Promise<MulticaResponseLedgerRecord[]> {
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

  private async load(): Promise<{
    schemaVersion: 1;
    records: MulticaResponseLedgerRecord[];
  }> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return ledgerSchema.parse(parsed);
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) return { schemaVersion: 1, records: [] };
      throw error;
    }
  }
}
