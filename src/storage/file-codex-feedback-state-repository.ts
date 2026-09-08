import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  codexFeedbackStateSchema,
  emptyCodexFeedbackState,
  type CodexFeedbackState,
  type CodexArtifactSnapshot,
  type CodexTaskBinding,
} from '../domain/codex-feedback.js';
import {
  acquireSafeFileLock,
  atomicCreateTextFile,
  atomicReplaceSafeTextFile,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  sameFileVersion,
  type StorageReadBoundary,
} from './file-io.js';
import { withCodexArtifactLock } from './codex-artifact-lock.js';
import {
  assertVaultWriteAllowed,
  type VaultWriteAuthorization,
} from './task-paths.js';

const LOCK_LEASE_MS = 5 * 60 * 1_000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;
const processTails = new Map<string, Promise<void>>();

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference !== '' && !difference.startsWith('..') && !isAbsolute(difference);
}

function sourcePathFromRef(root: string, sourceRef: string): string | null {
  const trimmed = sourceRef.trim();
  const anchorIndex = trimmed.indexOf('#');
  const pathRef = anchorIndex === -1 ? trimmed : trimmed.slice(0, anchorIndex);
  if (!pathRef.endsWith('.md') || pathRef.includes('\\')) return null;
  const segments = pathRef.split('/');
  if (segments.some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
  ))) return null;
  const path = resolve(root, pathRef);
  return isWithin(resolve(root), path) ? path : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class CodexFeedbackStateInvalidError extends Error {
  readonly code = 'codex_feedback_state_invalid';

  constructor() {
    super('Codex feedback state is missing or invalid');
    this.name = 'CodexFeedbackStateInvalidError';
  }
}

export class CodexFeedbackStateLockTimeoutError extends Error {
  readonly code = 'codex_feedback_state_lock_timeout';

  constructor() {
    super('Codex feedback state lock timed out');
    this.name = 'CodexFeedbackStateLockTimeoutError';
  }
}

export class FileCodexFeedbackStateRepository {
  private readonly runtimeRoot: string;
  private readonly statePath: string;
  private readonly lockRoot: string;
  private readonly vaultRoot: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(
    runtimeRoot: string,
    options: {
      vaultRoot?: string;
      writeAuthorization?: VaultWriteAuthorization;
    } = {},
  ) {
    this.runtimeRoot = resolve(runtimeRoot);
    this.statePath = join(this.runtimeRoot, 'state.json');
    this.lockRoot = join(this.runtimeRoot, '.locks');
    this.vaultRoot = resolve(options.vaultRoot ?? dirname(dirname(this.runtimeRoot)));
    this.writeAuthorization = options.writeAuthorization;
    if (this.runtimeRoot !== join(this.vaultRoot, '.atl-runtime', 'codex-feedback')) {
      throw new CodexFeedbackStateInvalidError();
    }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    assertVaultWriteAllowed(this.vaultRoot, this.writeAuthorization);
    let resolveTail: (() => void) | undefined;
    const previous = processTails.get(this.statePath) ?? Promise.resolve();
    const current = new Promise<void>((resolvePromise) => {
      resolveTail = resolvePromise;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    processTails.set(this.statePath, tail);
    await previous.catch(() => undefined);

    try {
      return await this.withFileLock(operation);
    } finally {
      resolveTail?.();
      if (processTails.get(this.statePath) === tail) {
        processTails.delete(this.statePath);
      }
    }
  }

  withArtifactLock<T>(artifactPath: string, operation: () => Promise<T>): Promise<T> {
    return withCodexArtifactLock(this.vaultRoot, artifactPath, operation);
  }

  async read(): Promise<CodexFeedbackState> {
    const raw = await readSafeTextFile(this.statePath, this.stateBoundary());
    if (raw === null) {
      try {
        await lstat(this.statePath);
      } catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'ENOENT'
        ) return emptyCodexFeedbackState();
      }
      throw new CodexFeedbackStateInvalidError();
    }
    try {
      return codexFeedbackStateSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new CodexFeedbackStateInvalidError();
    }
  }

  async save(
    state: CodexFeedbackState,
    options: { beforeCommit?: () => Promise<void> } = {},
  ): Promise<void> {
    assertVaultWriteAllowed(this.vaultRoot, this.writeAuthorization);
    const parsed = codexFeedbackStateSchema.safeParse(state);
    if (!parsed.success) throw new CodexFeedbackStateInvalidError();
    const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
    const boundary = this.stateBoundary();
    const current = await readSafeTextFile(this.statePath, boundary);
    if (current === null) {
      try {
        await lstat(this.statePath);
        throw new CodexFeedbackStateInvalidError();
      } catch (error) {
        if (
          error instanceof CodexFeedbackStateInvalidError
          || typeof error !== 'object'
          || error === null
          || !('code' in error)
          || error.code !== 'ENOENT'
        ) throw error;
      }
      await options.beforeCommit?.();
      if (!await atomicCreateTextFile(this.statePath, content, boundary)) {
        throw new CodexFeedbackStateInvalidError();
      }
    } else {
      const replaceOptions = options.beforeCommit === undefined
        ? {}
        : { beforeRename: options.beforeCommit };
      if (!await atomicReplaceSafeTextFile(
        this.statePath,
        current,
        content,
        boundary,
        replaceOptions,
      )) {
        throw new CodexFeedbackStateInvalidError();
      }
    }
    if (await readSafeTextFile(this.statePath, boundary) !== content) {
      throw new CodexFeedbackStateInvalidError();
    }
  }

  async listBindings(): Promise<CodexTaskBinding[]> {
    return (await this.read()).bindings;
  }

  async listArtifactSnapshots(): Promise<CodexArtifactSnapshot[]> {
    return (await this.read()).artifactSnapshots;
  }

  async readSourceSha256(sourceRef: string): Promise<string | null> {
    const path = sourcePathFromRef(this.vaultRoot, sourceRef);
    if (path === null) return null;
    let handle: FileHandle | undefined;
    try {
      const [canonicalRoot, referencedStat] = await Promise.all([
        realpath(this.vaultRoot),
        lstat(path),
      ]);
      if (referencedStat.isSymbolicLink() || !referencedStat.isFile()) return null;
      const canonicalPath = await realpath(path);
      if (!isWithin(canonicalRoot, canonicalPath)) return null;
      handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [openedStat, currentPath, currentStat] = await Promise.all([
        handle.stat(),
        realpath(path),
        stat(path),
      ]);
      if (
        !openedStat.isFile()
        || currentPath !== canonicalPath
        || !sameFileVersion(openedStat, referencedStat)
        || !sameFileVersion(openedStat, currentStat)
      ) return null;
      const content = await handle.readFile();
      const [finalOpenedStat, finalPathStat, finalCanonicalPath, finalPathStatFollowed] = await Promise.all([
        handle.stat(),
        lstat(path),
        realpath(path),
        stat(path),
      ]);
      if (
        finalPathStat.isSymbolicLink()
        || !finalPathStat.isFile()
        || finalCanonicalPath !== canonicalPath
        || !sameFileVersion(openedStat, finalOpenedStat)
        || !sameFileVersion(openedStat, finalPathStat)
        || !sameFileVersion(openedStat, finalPathStatFollowed)
      ) return null;
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const boundary: StorageReadBoundary = {
      vaultRoot: this.vaultRoot,
      tasksRoot: this.runtimeRoot,
      subtree: this.lockRoot,
    };
    const lockPath = join(this.lockRoot, 'state.lock');
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
    throw new CodexFeedbackStateLockTimeoutError();
  }

  private stateBoundary(): StorageReadBoundary {
    return {
      vaultRoot: this.vaultRoot,
      tasksRoot: join(this.vaultRoot, '.atl-runtime'),
      subtree: this.runtimeRoot,
    };
  }
}
