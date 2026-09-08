import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  acquireSafeFileLock,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';

const LOCK_LEASE_MS = 5 * 60 * 1_000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;
const processTails = new Map<string, Promise<void>>();

export class CodexArtifactLockTimeoutError extends Error {
  readonly code = 'codex_artifact_lock_timeout';

  constructor() {
    super('Codex Artifact lock timed out');
    this.name = 'CodexArtifactLockTimeoutError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function artifactLockPath(vaultRoot: string, artifactPath: string): string {
  const key = createHash('sha256')
    .update(resolve(artifactPath))
    .digest('hex');
  return join(
    resolve(vaultRoot),
    '.atl-runtime',
    'codex-feedback',
    '.locks',
    `artifact-${key}.lock`,
  );
}

/**
 * Serialize every PAW-owned read or publish of one Codex Artifact. The
 * filesystem lock makes the constraint effective across processes; the tail
 * avoids needless lock-file churn for concurrent calls in this process.
 */
export async function withCodexArtifactLock<T>(
  vaultRoot: string,
  artifactPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = artifactLockPath(vaultRoot, artifactPath);
  let resolveTail: (() => void) | undefined;
  const previous = processTails.get(lockPath) ?? Promise.resolve();
  const current = new Promise<void>((resolvePromise) => {
    resolveTail = resolvePromise;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  processTails.set(lockPath, tail);
  await previous.catch(() => undefined);

  const resolvedVaultRoot = resolve(vaultRoot);
  const runtimeRoot = join(resolvedVaultRoot, '.atl-runtime');
  const lockRoot = join(runtimeRoot, 'codex-feedback', '.locks');
  const boundary: StorageReadBoundary = {
    vaultRoot: resolvedVaultRoot,
    tasksRoot: runtimeRoot,
    subtree: lockRoot,
  };

  try {
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
    throw new CodexArtifactLockTimeoutError();
  } finally {
    resolveTail?.();
    if (processTails.get(lockPath) === tail) {
      processTails.delete(lockPath);
    }
  }
}
