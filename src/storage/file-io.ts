import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import fastGlob from 'fast-glob';

export class InvalidStorageEntryError extends Error {
  readonly code = 'invalid_storage_entry';

  constructor() {
    super('Invalid storage entry');
    this.name = 'InvalidStorageEntryError';
  }
}

export interface StorageReadBoundary {
  vaultRoot: string;
  tasksRoot: string;
  subtree: string;
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

function isStrictlyWithin(parent: string, target: string): boolean {
  return parent !== target && isWithin(parent, target);
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isUnsafePathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR');
}

export async function listSafeRegularFiles(
  boundary: StorageReadBoundary,
  pattern: string,
): Promise<string[]> {
  if (await canonicalStorageSubtree(boundary) === null) {
    return [];
  }
  const entries = await fastGlob(pattern, {
    cwd: boundary.subtree,
    followSymbolicLinks: false,
    objectMode: true,
    onlyFiles: true,
  });
  // Relative object-mode paths preserve literal POSIX backslashes. Absolute
  // fast-glob output normalizes them into separators.
  const candidates = entries.map((entry) => join(boundary.subtree, entry.path));
  const checked = await Promise.all(candidates.sort().map(async (path) => (
    await isSafeRegularFile(path, boundary) ? path : null
  )));
  return checked.filter((path): path is string => path !== null);
}

export async function readSafeTextFile(
  path: string,
  boundary: StorageReadBoundary,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    const canonicalSubtree = await canonicalStorageSubtree(boundary);
    if (canonicalSubtree === null) {
      return null;
    }
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return null;
    }
    const canonicalPath = await realpath(path);
    if (!isWithin(canonicalSubtree, canonicalPath)) {
      return null;
    }

    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameIdentity(pathStat, openedStat)) {
      return null;
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (isUnsafePathError(error)) {
      return null;
    }
    throw new InvalidStorageEntryError();
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteTextFile(
  targetPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const canonicalParent = await realpath(dirname(targetPath));
  let handle: FileHandle | undefined;
  let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new InvalidStorageEntryError();
    }
    createdIdentity = { dev: openedStat.dev, ino: openedStat.ino };
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    const [pathStat, canonicalTemporaryPath] = await Promise.all([
      lstat(temporaryPath),
      realpath(temporaryPath),
    ]);
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || !sameIdentity(createdIdentity, pathStat)
      || !isWithin(canonicalParent, canonicalTemporaryPath)
    ) {
      throw new InvalidStorageEntryError();
    }
    await rename(temporaryPath, targetPath);
    createdIdentity = undefined;
  } catch (error) {
    await handle?.close();
    if (createdIdentity !== undefined) {
      await unlinkCreatedFile(temporaryPath, createdIdentity);
    }
    throw error;
  }
}

export async function appendSafeTextFile(
  targetPath: string,
  content: Buffer,
  boundary: StorageReadBoundary,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const [canonicalVaultRoot, canonicalTasksRoot] = await Promise.all([
      realpath(boundary.vaultRoot),
      realpath(boundary.tasksRoot),
    ]);
    const [vaultStat, tasksStat, tasksPathStat] = await Promise.all([
      lstat(canonicalVaultRoot),
      lstat(canonicalTasksRoot),
      lstat(boundary.tasksRoot),
    ]);
    if (
      !vaultStat.isDirectory()
      || !tasksStat.isDirectory()
      || tasksPathStat.isSymbolicLink()
      || !tasksPathStat.isDirectory()
      || !sameIdentity(tasksStat, tasksPathStat)
      || !isStrictlyWithin(canonicalVaultRoot, canonicalTasksRoot)
    ) {
      throw new InvalidStorageEntryError();
    }

    await mkdir(boundary.subtree, { recursive: true, mode: 0o700 });
    const [canonicalSubtree, subtreePathStat] = await Promise.all([
      realpath(boundary.subtree),
      lstat(boundary.subtree),
    ]);
    const canonicalSubtreeStat = await lstat(canonicalSubtree);
    if (
      subtreePathStat.isSymbolicLink()
      || !subtreePathStat.isDirectory()
      || !canonicalSubtreeStat.isDirectory()
      || !sameIdentity(canonicalSubtreeStat, subtreePathStat)
      || !isStrictlyWithin(canonicalTasksRoot, canonicalSubtree)
      || resolve(dirname(targetPath)) !== resolve(boundary.subtree)
    ) {
      throw new InvalidStorageEntryError();
    }

    let initialIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
    try {
      const targetStat = await lstat(targetPath);
      if (
        targetStat.isSymbolicLink()
        || !targetStat.isFile()
        || targetStat.nlink !== 1
      ) {
        throw new InvalidStorageEntryError();
      }
      initialIdentity = { dev: targetStat.dev, ino: targetStat.ino };
    } catch (error) {
      if (!isUnsafePathError(error)) {
        throw error;
      }
    }

    handle = await open(
      targetPath,
      constants.O_APPEND
        | constants.O_CREAT
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || openedStat.nlink !== 1
      || (initialIdentity !== undefined && !sameIdentity(initialIdentity, openedStat))
    ) {
      throw new InvalidStorageEntryError();
    }

    const [
      finalPathStat,
      canonicalTarget,
      finalTasksPathStat,
      finalSubtreePathStat,
    ] = await Promise.all([
      lstat(targetPath),
      realpath(targetPath),
      lstat(boundary.tasksRoot),
      lstat(boundary.subtree),
    ]);
    if (
      finalPathStat.isSymbolicLink()
      || !finalPathStat.isFile()
      || finalPathStat.nlink !== 1
      || !sameIdentity(openedStat, finalPathStat)
      || !sameIdentity(tasksStat, finalTasksPathStat)
      || !sameIdentity(canonicalSubtreeStat, finalSubtreePathStat)
      || !isStrictlyWithin(canonicalSubtree, canonicalTarget)
    ) {
      throw new InvalidStorageEntryError();
    }

    await handle.chmod(0o600);
    const { bytesWritten } = await handle.write(content, 0, content.length, null);
    if (bytesWritten !== content.length) {
      throw new InvalidStorageEntryError();
    }
    await handle.sync();
  } catch {
    throw new InvalidStorageEntryError();
  } finally {
    await handle?.close();
  }
}

export async function moveSafeRegularFile(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new InvalidStorageEntryError();
    }
    handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameIdentity(sourceStat, openedStat)) {
      throw new InvalidStorageEntryError();
    }
    try {
      await lstat(targetPath);
      throw new InvalidStorageEntryError();
    } catch (error) {
      if (!isUnsafePathError(error)) {
        throw error;
      }
    }
    const finalSourceStat = await lstat(sourcePath);
    if (
      finalSourceStat.isSymbolicLink()
      || !finalSourceStat.isFile()
      || !sameIdentity(openedStat, finalSourceStat)
    ) {
      throw new InvalidStorageEntryError();
    }
    await handle.close();
    handle = undefined;
    await rename(sourcePath, targetPath);
    // V0.1 syncs file content before rename; directory fsync remains a local limitation.
  } catch {
    throw new InvalidStorageEntryError();
  } finally {
    await handle?.close();
  }
}

async function canonicalStorageSubtree(
  boundary: StorageReadBoundary,
): Promise<string | null> {
  try {
    const [canonicalVaultRoot, canonicalTasksRoot, canonicalSubtree] = await Promise.all([
      realpath(boundary.vaultRoot),
      realpath(boundary.tasksRoot),
      realpath(boundary.subtree),
    ]);
    if (
      !isStrictlyWithin(canonicalVaultRoot, canonicalTasksRoot)
      || !isStrictlyWithin(canonicalTasksRoot, canonicalSubtree)
    ) {
      return null;
    }
    const directoryStats = await Promise.all([
      lstat(canonicalVaultRoot),
      lstat(canonicalTasksRoot),
      lstat(canonicalSubtree),
    ]);
    return directoryStats.every((stats) => stats.isDirectory())
      ? canonicalSubtree
      : null;
  } catch (error) {
    if (isUnsafePathError(error)) {
      return null;
    }
    throw new InvalidStorageEntryError();
  }
}

async function isSafeRegularFile(
  path: string,
  boundary: StorageReadBoundary,
): Promise<boolean> {
  try {
    const canonicalSubtree = await canonicalStorageSubtree(boundary);
    if (canonicalSubtree === null) {
      return false;
    }
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return false;
    }
    return isWithin(canonicalSubtree, await realpath(path));
  } catch (error) {
    if (isUnsafePathError(error)) {
      return false;
    }
    throw new InvalidStorageEntryError();
  }
}

async function unlinkCreatedFile(
  path: string,
  identity: { dev: number | bigint; ino: number | bigint },
): Promise<void> {
  try {
    const pathStat = await lstat(path);
    if (
      !pathStat.isSymbolicLink()
      && pathStat.isFile()
      && sameIdentity(identity, pathStat)
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!isUnsafePathError(error)) {
      throw new InvalidStorageEntryError();
    }
  }
}
