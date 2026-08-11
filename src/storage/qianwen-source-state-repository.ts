import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type {
  QianwenRecordingStatus,
  QianwenSourceSnapshot,
} from '../obsidian-plugin/qianwen-source-state.js';
import {
  assertVaultWriteAllowed,
  type VaultWriteAuthorization,
} from './task-paths.js';
import {
  acquireSafeFileLock,
  reclaimExpiredSafeFileLock,
} from './file-io.js';

export interface QianwenPersistedRecordingVersion {
  id: string;
  version: number;
  fingerprint: string;
  capturedAt: string;
  status: QianwenRecordingStatus;
  error: string | null;
  title: string | null;
  createdAt: string | null;
  durationSeconds: number | null;
  sourceUrl: string | null;
  transcriptComplete: boolean;
  transcript: string;
  summary: string;
}

export interface QianwenPersistedRecording {
  currentVersion: number;
  versions: QianwenPersistedRecordingVersion[];
}

export interface QianwenSourceRuntimeState {
  schemaVersion: 2;
  lastAttemptedDate: string | null;
  lastScan: QianwenSourceSnapshot | null;
  lastSuccessfulScan: QianwenSourceSnapshot | null;
  recordings: Record<string, QianwenPersistedRecording>;
}

export interface QianwenSourceStateRepository {
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
  load(): Promise<QianwenSourceRuntimeState>;
  save(state: QianwenSourceRuntimeState): Promise<void>;
}

const LOCK_LEASE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

export class QianwenSourceStateLockTimeoutError extends Error {
  readonly code = 'qianwen_source_state_lock_timeout';

  constructor() {
    super('千问听记同步正在运行，请稍后重试');
    this.name = 'QianwenSourceStateLockTimeoutError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const EMPTY_STATE: QianwenSourceRuntimeState = {
  schemaVersion: 2,
  lastAttemptedDate: null,
  lastScan: null,
  lastSuccessfulScan: null,
  recordings: {},
};

const connectorSchema = z.object({
  status: z.enum(['connected', 'login_required', 'incompatible', 'network_failed']),
  resultKind: z.enum(['success', 'failed']),
  scannedAt: z.string(),
  range: z.object({ startDate: z.string(), endDate: z.string() }).strict(),
}).strict();

const snapshotSchema = z.object({
  connector: connectorSchema,
  recordings: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['waiting', 'available', 'failed']),
    error: z.string().nullable(),
  }).strict()),
}).strict();

const persistedVersionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  capturedAt: z.string().min(1),
  status: z.enum(['waiting', 'available', 'failed']),
  error: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.string().nullable(),
  durationSeconds: z.number().int().positive().nullable(),
  sourceUrl: z.string().nullable(),
  transcriptComplete: z.boolean(),
  transcript: z.string(),
  summary: z.string(),
}).strict();

const stateV2Schema = z.object({
  schemaVersion: z.literal(2),
  lastAttemptedDate: z.string().nullable(),
  lastScan: snapshotSchema.nullable(),
  lastSuccessfulScan: snapshotSchema.nullable(),
  recordings: z.record(z.string(), z.object({
    currentVersion: z.number().int().positive(),
    versions: z.array(persistedVersionSchema).min(1),
  }).strict()),
}).strict();

const stateV1Schema = z.object({
  schemaVersion: z.literal(1),
  lastAttemptedDate: z.string().nullable(),
  lastScan: snapshotSchema.nullable(),
  lastSuccessfulScan: snapshotSchema.nullable(),
}).passthrough();

function parseState(value: unknown): QianwenSourceRuntimeState {
  const current = stateV2Schema.safeParse(value);
  if (current.success) return current.data;
  const legacy = stateV1Schema.safeParse(value);
  if (legacy.success) {
    return {
      schemaVersion: 2,
      lastAttemptedDate: legacy.data.lastAttemptedDate,
      lastScan: legacy.data.lastScan,
      lastSuccessfulScan: legacy.data.lastSuccessfulScan,
      recordings: {},
    };
  }
  throw new Error('千问来源状态无效');
}

export class FileQianwenSourceStateRepository implements QianwenSourceStateRepository {
  private readonly path: string;
  private readonly lockRoot: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(
    private readonly runtimeRoot: string,
    options: { writeAuthorization?: VaultWriteAuthorization } = {},
  ) {
    this.path = join(runtimeRoot, 'qianwen-source-state.json');
    this.lockRoot = join(runtimeRoot, 'qianwen-source-locks');
    this.writeAuthorization = options.writeAuthorization;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    assertVaultWriteAllowed(this.runtimeRoot, this.writeAuthorization);
    const lockPath = join(this.lockRoot, 'sync.lock');
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
    throw new QianwenSourceStateLockTimeoutError();
  }

  async load(): Promise<QianwenSourceRuntimeState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return parseState(parsed);
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        return { ...EMPTY_STATE };
      }
      throw error;
    }
  }

  async save(state: QianwenSourceRuntimeState): Promise<void> {
    assertVaultWriteAllowed(this.runtimeRoot, this.writeAuthorization);
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
  }
}
