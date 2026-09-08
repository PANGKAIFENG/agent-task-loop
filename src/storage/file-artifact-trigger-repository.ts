import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import {
  ArtifactTriggerConflictError,
  isValidArtifactTriggerReceipt,
  type ArtifactTriggerReceipt,
  type ArtifactTriggerRepository,
} from '../services/start-artifact-trigger.js';
import {
  acquireSafeFileLock,
  atomicCreateTextFile,
  atomicReplaceSafeTextFile,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';

const LOCK_LEASE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

export class ArtifactTriggerRepositoryError extends Error {
  readonly code = 'artifact_trigger_repository_invalid';

  constructor() {
    super('Persisted Artifact Trigger evidence is missing, malformed, or ambiguous');
    this.name = 'ArtifactTriggerRepositoryError';
  }
}

export class ArtifactTriggerRepositoryLockTimeoutError extends Error {
  readonly code = 'artifact_trigger_repository_lock_timeout';

  constructor() {
    super('Artifact Trigger repository lock timed out');
    this.name = 'ArtifactTriggerRepositoryLockTimeoutError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundary(runtimeRoot: string, directoryName: string): StorageReadBoundary {
  return {
    vaultRoot: dirname(runtimeRoot),
    tasksRoot: runtimeRoot,
    subtree: join(runtimeRoot, directoryName),
  };
}

function storageKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

function content(receipt: ArtifactTriggerReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function parse(raw: string): ArtifactTriggerReceipt {
  try {
    const receipt = JSON.parse(raw) as ArtifactTriggerReceipt;
    if (!isValidArtifactTriggerReceipt(receipt)) {
      throw new ArtifactTriggerRepositoryError();
    }
    return receipt;
  } catch (error) {
    if (error instanceof ArtifactTriggerRepositoryError) throw error;
    throw new ArtifactTriggerRepositoryError();
  }
}

function immutableIdentityMatches(
  existing: ArtifactTriggerReceipt,
  candidate: ArtifactTriggerReceipt,
): boolean {
  return existing.receiptId === candidate.receiptId
    && existing.idempotencyKey === candidate.idempotencyKey
    && existing.inputFingerprint === candidate.inputFingerprint
    && existing.executionTarget === candidate.executionTarget
    && existing.taskId === candidate.taskId
    && existing.sourceRunId === candidate.sourceRunId
    && existing.decisionId === candidate.decisionId
    && existing.artifactRef === candidate.artifactRef
    && existing.artifactVersion === candidate.artifactVersion
    && existing.artifactSha256 === candidate.artifactSha256
    && existing.createdAt === candidate.createdAt;
}

function transitionAllowed(
  existing: ArtifactTriggerReceipt,
  candidate: ArtifactTriggerReceipt,
): boolean {
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) return false;
  if (existing.state === 'started') {
    return candidate.state === 'started'
      && candidate.continuationRunId === existing.continuationRunId;
  }
  if (existing.state === 'unknown') {
    return candidate.state === 'unknown' || candidate.state === 'started';
  }
  return candidate.state === 'starting'
    || candidate.state === 'unknown'
    || candidate.state === 'started';
}

export class FileArtifactTriggerRepository implements ArtifactTriggerRepository {
  constructor(private readonly runtimeRoot: string) {}

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (key.trim() === '') throw new ArtifactTriggerRepositoryError();
    const storage = boundary(this.runtimeRoot, 'artifact-trigger-locks');
    const lockPath = join(storage.subtree, `${storageKey(key)}.lock`);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const now = new Date();
      let lock = await acquireSafeFileLock(lockPath, storage, {
        acquiredAt: now,
        leaseMs: LOCK_LEASE_MS,
      });
      if (lock === null && await reclaimExpiredSafeFileLock(lockPath, storage, now)) {
        lock = await acquireSafeFileLock(lockPath, storage, {
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
    throw new ArtifactTriggerRepositoryLockTimeoutError();
  }

  async get(idempotencyKey: string): Promise<ArtifactTriggerReceipt | null> {
    if (idempotencyKey.trim() === '') throw new ArtifactTriggerRepositoryError();
    const storage = boundary(this.runtimeRoot, 'artifact-triggers');
    const raw = await readSafeTextFile(this.receiptPath(storage, idempotencyKey), storage);
    if (raw === null) return null;
    const receipt = parse(raw);
    if (receipt.idempotencyKey !== idempotencyKey) {
      throw new ArtifactTriggerRepositoryError();
    }
    return receipt;
  }

  async create(receipt: ArtifactTriggerReceipt): Promise<void> {
    if (!isValidArtifactTriggerReceipt(receipt)) {
      throw new ArtifactTriggerConflictError();
    }
    const storage = boundary(this.runtimeRoot, 'artifact-triggers');
    const path = this.receiptPath(storage, receipt.idempotencyKey);
    if (await atomicCreateTextFile(path, content(receipt), storage)) return;
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new ArtifactTriggerRepositoryError();
    const existing = parse(raw);
    if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new ArtifactTriggerConflictError();
    }
  }

  async save(receipt: ArtifactTriggerReceipt): Promise<void> {
    if (!isValidArtifactTriggerReceipt(receipt)) {
      throw new ArtifactTriggerConflictError();
    }
    const storage = boundary(this.runtimeRoot, 'artifact-triggers');
    const path = this.receiptPath(storage, receipt.idempotencyKey);
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new ArtifactTriggerRepositoryError();
    const existing = parse(raw);
    if (
      !immutableIdentityMatches(existing, receipt)
      || !transitionAllowed(existing, receipt)
    ) {
      throw new ArtifactTriggerConflictError();
    }
    if (raw === content(receipt)) return;
    if (!await atomicReplaceSafeTextFile(path, raw, content(receipt), storage)) {
      throw new ArtifactTriggerConflictError();
    }
  }

  async findByDecisionArtifact(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactTriggerReceipt | null> {
    const storage = boundary(this.runtimeRoot, 'artifact-triggers');
    const { listSafeRegularFiles } = await import('./file-io.js');
    const matches: ArtifactTriggerReceipt[] = [];
    for (const path of await listSafeRegularFiles(storage, '*.json')) {
      const raw = await readSafeTextFile(path, storage);
      if (raw === null) throw new ArtifactTriggerRepositoryError();
      const receipt = parse(raw);
      if (receipt.decisionId === decisionId && receipt.artifactRef === artifactRef) {
        matches.push(receipt);
      }
    }
    if (matches.length > 1) throw new ArtifactTriggerRepositoryError();
    return matches[0] ?? null;
  }

  private receiptPath(storage: StorageReadBoundary, idempotencyKey: string): string {
    return join(storage.subtree, `${storageKey(idempotencyKey)}.json`);
  }
}
