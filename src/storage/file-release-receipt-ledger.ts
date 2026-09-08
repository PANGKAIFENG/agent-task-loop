import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { releaseReceiptSchema, type ReleaseReceipt } from '../domain/release-receipt.js';
import {
  acquireSafeFileLock,
  atomicWriteTextFile,
  reclaimExpiredSafeFileLock,
} from './file-io.js';

export const LEGACY_MULTICA_RECEIPT_METADATA_KEY = 'legacy_comment_receipt';

const WRITE_LOCK_LEASE_MS = 5 * 60 * 1000;
const WRITE_LOCK_RETRY_MS = 20;
const WRITE_LOCK_ATTEMPTS = 250;

// A file ledger can be constructed more than once in one process (for
// example, release and completion services use separate instances). The
// filesystem lock below protects other processes, while this shared tail
// prevents same-process instances from racing between load and atomic rename.
const writeTails = new Map<string, Promise<void>>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

class ReleaseReceiptLedgerLockTimeoutError extends Error {
  readonly code = 'release_receipt_ledger_lock_timeout';

  constructor() {
    super('Release receipt ledger lock timed out');
    this.name = 'ReleaseReceiptLedgerLockTimeoutError';
  }
}

function parseStoredReceipt(input: unknown): ReleaseReceipt {
  if (typeof input !== 'object' || input === null) return releaseReceiptSchema.parse(input);
  const candidate = structuredClone(input) as {
    receiptId?: unknown;
    readBack?: { multica?: Record<string, unknown> } | null;
  };
  const multica = candidate.readBack?.multica;
  if (
    multica !== undefined
    && typeof multica.receiptCommentId === 'string'
    && multica.receiptMetadataKey === undefined
    && multica.receiptMetadataValue === undefined
  ) {
    const receiptCommentId = multica.receiptCommentId;
    delete multica.receiptCommentId;
    multica.receiptMetadataKey = LEGACY_MULTICA_RECEIPT_METADATA_KEY;
    multica.receiptMetadataValue = JSON.stringify({
      schema_version: 1,
      receipt_id: candidate.receiptId,
      legacy_receipt_comment_id: receiptCommentId,
    });
  }
  return releaseReceiptSchema.parse(candidate);
}

// PAW-GOAL-003 T3 (TECH §9): durable acceptance-keyed receipt records. The
// final ledger is written only by complete-release; the release-phase subclass
// uses a separate file so publishing can replay without occupying the final
// immutable receipt slot.
export interface ReleaseReceiptLedger {
  get(acceptanceId: string): Promise<ReleaseReceipt | null>;
  save(receipt: ReleaseReceipt): Promise<void>;
  list(): Promise<ReleaseReceipt[]>;
}

export class FileReleaseReceiptLedger implements ReleaseReceiptLedger {
  private readonly path: string;

  constructor(
    private readonly runtimeRoot: string,
    filename = 'multica-release-receipts.json',
  ) {
    this.path = resolve(join(runtimeRoot, filename));
  }

  async get(acceptanceId: string): Promise<ReleaseReceipt | null> {
    return (await this.load()).find((receipt) => (
      receipt.acceptanceId === acceptanceId
    )) ?? null;
  }

  async save(receipt: ReleaseReceipt): Promise<void> {
    const parsed = releaseReceiptSchema.parse(receipt);
    const previous = writeTails.get(this.path) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.saveLocked(parsed));
    writeTails.set(this.path, current);
    await current.finally(() => {
      if (writeTails.get(this.path) === current) {
        writeTails.delete(this.path);
      }
    });
  }

  async list(): Promise<ReleaseReceipt[]> {
    return this.load();
  }

  private async load(): Promise<ReleaseReceipt[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as { receipts?: unknown };
    const receipts = Array.isArray(parsed.receipts) ? parsed.receipts : [];
    return receipts.map(parseStoredReceipt);
  }

  private async saveLocked(parsed: ReleaseReceipt): Promise<void> {
    const lockRoot = join(this.runtimeRoot, '.atl-release-receipt-locks');
    const lockPath = join(
      lockRoot,
      `${createHash('sha256').update(this.path).digest('hex')}.lock`,
    );
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const boundary = {
      vaultRoot: dirname(this.runtimeRoot),
      tasksRoot: this.runtimeRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < WRITE_LOCK_ATTEMPTS; attempt += 1) {
      const acquiredAt = new Date();
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt,
        leaseMs: WRITE_LOCK_LEASE_MS,
      });
      if (lock === null && await reclaimExpiredSafeFileLock(lockPath, boundary, acquiredAt)) {
        lock = await acquireSafeFileLock(lockPath, boundary, {
          acquiredAt,
          leaseMs: WRITE_LOCK_LEASE_MS,
        });
      }
      if (lock !== null) {
        try {
          const receipts = (await this.load()).filter((candidate) => (
            candidate.acceptanceId !== parsed.acceptanceId
          ));
          receipts.push(parsed);
          receipts.sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId));
          await atomicWriteTextFile(this.path, `${JSON.stringify({
            schemaVersion: 1,
            receipts,
          }, null, 2)}\n`);
          return;
        } finally {
          await lock.release();
        }
      }
      if (attempt + 1 < WRITE_LOCK_ATTEMPTS) await delay(WRITE_LOCK_RETRY_MS);
    }
    throw new ReleaseReceiptLedgerLockTimeoutError();
  }
}

export class FileReleasePhaseEvidenceLedger extends FileReleaseReceiptLedger {
  constructor(runtimeRoot: string) {
    super(runtimeRoot, 'multica-release-phase-evidence.json');
  }
}

// A write-ahead journal for post-deployment completion. Unlike the final
// receipt, this record preserves the factual pre-transition ATL read-back
// (`review`) so a crash can resume without asking the caller to claim `done`
// before the task projection has actually persisted.
export class FileReleaseCompletionIntentLedger extends FileReleaseReceiptLedger {
  constructor(runtimeRoot: string) {
    super(runtimeRoot, 'multica-release-completion-intents.json');
  }
}
