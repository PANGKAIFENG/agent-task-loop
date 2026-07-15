import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

export const RUNNER_LOCK_STALE_MS = 35 * 60 * 1000;

const MAX_LOCK_BYTES = 4 * 1024;

interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface ProcessLockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface AcquireProcessLockOptions {
  runtimeRoot: string;
  clock?: () => Date;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  token?: () => string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ESRCH'
    );
  }
}

function parseLockRecord(raw: string): LockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'pid,startedAt,token'
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.startedAt !== 'string'
    || !Number.isFinite(Date.parse(record.startedAt))
    || typeof record.token !== 'string'
    || record.token === ''
  ) {
    return null;
  }
  return {
    pid: record.pid as number,
    startedAt: record.startedAt,
    token: record.token,
  };
}

function sameIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canReclaim(
  record: LockRecord,
  now: Date,
  isPidAlive: (pid: number) => boolean,
): boolean {
  const age = now.getTime() - Date.parse(record.startedAt);
  return !(
    age <= RUNNER_LOCK_STALE_MS
    || age < 0
    || isPidAlive(record.pid)
  );
}

async function readLock(path: string): Promise<{
  record: LockRecord;
  identity: FileIdentity;
} | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_LOCK_BYTES) {
      return null;
    }
    const raw = await handle.readFile({ encoding: 'utf8' });
    const referenced = await lstat(path);
    const identity = { dev: metadata.dev, ino: metadata.ino };
    if (
      !referenced.isFile()
      || referenced.isSymbolicLink()
      || referenced.nlink !== 1
      || !sameIdentity(identity, referenced)
    ) {
      return null;
    }
    const record = parseLockRecord(raw);
    return record === null ? null : { record, identity };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeIfOwned(
  path: string,
  identity: FileIdentity,
  token: string,
): Promise<boolean> {
  const current = await readLock(path);
  if (
    current === null
    || !sameIdentity(current.identity, identity)
    || current.record.token !== token
  ) {
    return false;
  }
  try {
    const referenced = await lstat(path);
    if (!sameIdentity(referenced, identity)) {
      return false;
    }
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

async function createLock(
  path: string,
  record: LockRecord,
): Promise<ProcessLockHandle | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
    const metadata = await handle.stat();
    const identity = { dev: metadata.dev, ino: metadata.ino };
    let released = false;
    return {
      path,
      async release() {
        if (released) return;
        released = true;
        await removeIfOwned(path, identity, record.token);
      },
    };
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'EEXIST'
    ) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function acquireProcessLock(
  options: AcquireProcessLockOptions,
): Promise<ProcessLockHandle | null> {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const pid = options.pid ?? process.pid;
  if (
    !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(pid)
    || pid <= 0
  ) {
    throw new Error('Invalid process lock input');
  }
  await mkdir(options.runtimeRoot, { recursive: true, mode: 0o700 });
  const runtimeMetadata = await lstat(options.runtimeRoot);
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
    throw new Error('Invalid runtime root');
  }
  const path = join(options.runtimeRoot, 'runner.lock');
  const record: LockRecord = {
    pid,
    startedAt: now.toISOString(),
    token: (options.token ?? randomUUID)(),
  };
  if (record.token === '') {
    throw new Error('Invalid process lock input');
  }

  const created = await createLock(path, record);
  if (created !== null) {
    return created;
  }
  const existing = await readLock(path);
  if (existing === null) {
    return null;
  }
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!canReclaim(existing.record, now, isPidAlive)) {
    return null;
  }

  const reclaimGuard = await createLock(`${path}.reclaim`, record);
  if (reclaimGuard === null) {
    return null;
  }
  try {
    const guardedExisting = await readLock(path);
    if (
      guardedExisting === null
      || !canReclaim(guardedExisting.record, now, isPidAlive)
      || !(await removeIfOwned(
        path,
        guardedExisting.identity,
        guardedExisting.record.token,
      ))
    ) {
      return null;
    }
    return createLock(path, record);
  } finally {
    await reclaimGuard.release();
  }
}
