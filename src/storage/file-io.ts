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
import { dirname, isAbsolute, join, relative } from 'node:path';

import fastGlob from 'fast-glob';

export class InvalidStorageEntryError extends Error {
  readonly code = 'invalid_storage_entry';

  constructor() {
    super('Invalid storage entry');
    this.name = 'InvalidStorageEntryError';
  }
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
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
    && (error.code === 'ENOENT' || error.code === 'ELOOP');
}

export async function listSafeRegularFiles(
  subtree: string,
  pattern: string,
): Promise<string[]> {
  const entries = await fastGlob(pattern, {
    cwd: subtree,
    followSymbolicLinks: false,
    objectMode: true,
    onlyFiles: true,
  });
  // Relative object-mode paths preserve literal POSIX backslashes. Absolute
  // fast-glob output normalizes them into separators.
  const candidates = entries.map((entry) => join(subtree, entry.path));
  const checked = await Promise.all(candidates.sort().map(async (path) => (
    await isSafeRegularFile(path, subtree) ? path : null
  )));
  return checked.filter((path): path is string => path !== null);
}

export async function readSafeTextFile(
  path: string,
  subtree: string,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return null;
    }
    const [canonicalSubtree, canonicalPath] = await Promise.all([
      realpath(subtree),
      realpath(path),
    ]);
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

async function isSafeRegularFile(path: string, subtree: string): Promise<boolean> {
  try {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return false;
    }
    const [canonicalSubtree, canonicalPath] = await Promise.all([
      realpath(subtree),
      realpath(path),
    ]);
    return isWithin(canonicalSubtree, canonicalPath);
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
