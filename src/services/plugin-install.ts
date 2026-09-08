import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  type PluginBackupFileRecord,
  type PluginBackupReceipt,
  type PluginInstallReceipt,
  type PluginRollbackReceipt,
} from '../domain/release-receipt.js';

// PAW-GOAL-003 T3 (Goal §9 / TECH §10): before an install, the existing
// plugin's manifest, main, styles and every packaged background-runtime file
// are copied into a timestamped rollback directory; a failed live loop or
// read-back restores the exact pre-install bytes. The LaunchAgents invoke
// atl-runner.mjs and atl-dingtalk-stream.mjs directly from this directory, so
// installing only the Obsidian UI bundle would leave the running service on an
// older release while the manifest claimed otherwise.
export const PLUGIN_BACKUP_FILES = [
  'manifest.json',
  'main.js',
  'styles.css',
  'atl-runner.mjs',
  'atl-runner.mjs.map',
  'atl-dingtalk-bridge.mjs',
  'atl-dingtalk-stream.mjs',
  'atl-dingtalk-stream.mjs.map',
  'qianwen-accessibility-helper',
] as const;
export const PLUGIN_BACKUP_DIRECTORIES = ['runner', 'bridge'] as const;
export const PLUGIN_REQUIRED_BUILD_FILES = [
  'manifest.json',
  'main.js',
  'atl-runner.mjs',
  'atl-dingtalk-bridge.mjs',
  'atl-dingtalk-stream.mjs',
  'qianwen-accessibility-helper',
] as const;
const PLUGIN_EXECUTABLE_BUILD_FILES = new Set<string>(['qianwen-accessibility-helper']);

export class PluginWriteDisabledError extends Error {
  readonly code = 'plugin_write_disabled';

  constructor(message: string) {
    super(message);
    this.name = 'PluginWriteDisabledError';
  }
}

export class PluginInstallVerificationError extends Error {
  readonly code: string = 'plugin_install_verification_failed';

  constructor(message: string) {
    super(message);
    this.name = 'PluginInstallVerificationError';
  }
}

/**
 * TEP-54 P1-2: an install that already touched the plugin directory failed
 * mid-copy/mid-hash/mid-manifest AND restored the pre-install state. The
 * carried receipt is the restore evidence for the Release Receipt — null only
 * when the rollback itself failed and the plugin directory is NOT verified.
 */
export class PluginInstallPartialWriteError extends PluginInstallVerificationError {
  readonly code = 'plugin_install_partial_write_rolled_back';
  readonly rollbackReceipt: PluginRollbackReceipt | null;

  constructor(message: string, rollbackReceipt: PluginRollbackReceipt | null, cause?: unknown) {
    super(message);
    this.name = 'PluginInstallPartialWriteError';
    this.rollbackReceipt = rollbackReceipt;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Injectable filesystem seam — tests inject mid-copy/mid-hash failures. */
export interface PluginInstallIo {
  copyFile(source: string, target: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
}

export const defaultPluginInstallIo: PluginInstallIo = {
  copyFile: (source, target) => copyFile(source, target),
  readFile: (path) => readFile(path),
};

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

function canonicalize(path: string): string {
  return resolve(path);
}

function permissionMode(mode: number): number {
  return mode & 0o777;
}

/**
 * Writes below `root` are allowed inside OS temp roots (synthetic drills and
 * tests) or behind ATL_ALLOW_REAL_WRITES=1 — the same boundary TECH §10 sets
 * for real vault writes, so no code path can touch the live plugin directory
 * as a side effect of a test or synthetic loop.
 */
export function assertPluginWriteAllowed(root: string): void {
  const canonicalRoot = canonicalize(root);
  if (isWithin(canonicalize(tmpdir()), canonicalRoot)) {
    return;
  }
  if (process.env.ATL_ALLOW_REAL_WRITES === '1') {
    return;
  }
  throw new PluginWriteDisabledError(
    `Plugin writes to ${canonicalRoot} require ATL_ALLOW_REAL_WRITES=1`,
  );
}

async function sha256OfFile(path: string, io: PluginInstallIo): Promise<string> {
  return createHash('sha256').update(await io.readFile(path)).digest('hex');
}

async function listRegularFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function existingBackupTargets(pluginDir: string): Promise<string[]> {
  try {
    const metadata = await lstat(pluginDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PluginInstallVerificationError('Plugin path is not a directory');
    }
  } catch (error) {
    if (
      typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  const relativePaths: string[] = [];
  for (const name of PLUGIN_BACKUP_FILES) {
    try {
      const metadata = await lstat(join(pluginDir, name));
      if (metadata.isFile()) relativePaths.push(name);
    } catch {
      // Absent files are simply not part of the backup.
    }
  }
  for (const directory of PLUGIN_BACKUP_DIRECTORIES) {
    const directoryPath = join(pluginDir, directory);
    try {
      const metadata = await lstat(directoryPath);
      if (!metadata.isDirectory()) continue;
      for (const file of await listRegularFiles(directoryPath)) {
        relativePaths.push(`${directory}/${file}`);
      }
    } catch {
      // Absent directories are not part of the backup.
    }
  }
  return relativePaths;
}

function backupDirectoryName(timestamp: string): string {
  const normalized = timestamp.replace(/[^0-9A-Za-z-]/g, '');
  if (normalized.length < 8) {
    throw new PluginInstallVerificationError('Backup timestamp must be a bounded timestamp');
  }
  return `agent-task-loop-backup-${normalized.slice(0, 32)}`;
}

/**
 * Copies the current plugin files into a timestamped rollback directory and
 * records their SHA-256 hashes, so the rollback drill can prove a byte-equal
 * restore. A missing plugin yields a skipped receipt — nothing to roll back
 * to, and a first-install rollback then removes the installed files.
 */
export async function backupExistingPlugin(input: {
  pluginDir: string;
  backupRoot: string;
  timestamp: string;
}): Promise<PluginBackupReceipt> {
  assertPluginWriteAllowed(input.backupRoot);
  const targets = await existingBackupTargets(input.pluginDir);
  if (targets.length === 0) {
    return {
      backupPath: null,
      createdAt: input.timestamp,
      files: [],
      skippedReason: 'no_existing_plugin',
    };
  }
  const backupPath = join(input.backupRoot, backupDirectoryName(input.timestamp));
  const files = [];
  for (const relativePath of targets) {
    const source = join(input.pluginDir, relativePath);
    const target = join(backupPath, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(source, target);
    files.push({
      path: relativePath,
      sha256: await sha256OfFile(source, defaultPluginInstallIo),
      mode: permissionMode((await lstat(source)).mode),
    });
  }
  return {
    backupPath,
    createdAt: input.timestamp,
    files,
    skippedReason: null,
  };
}

interface PluginManifest {
  id?: unknown;
  version?: unknown;
}

async function readManifestVersion(
  manifestPath: string,
  io: PluginInstallIo,
): Promise<{ id: string; version: string }> {
  let parsed: PluginManifest;
  try {
    parsed = JSON.parse((await io.readFile(manifestPath)).toString('utf8')) as PluginManifest;
  } catch {
    throw new PluginInstallVerificationError('Plugin manifest is not valid JSON');
  }
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (id === '' || version === '') {
    throw new PluginInstallVerificationError('Plugin manifest must declare id and version');
  }
  return { id, version };
}

interface PluginWritePlanEntry {
  path: string;
  existed: boolean;
  backupRecord: PluginBackupFileRecord | null;
}

/**
 * Restores the plugin directory to its pre-install state after a partial
 * install: every planned path either returns byte-for-byte from the backup
 * (hash re-verified) or is removed when it did not exist before. A plugin
 * directory the install itself created is removed once empty (the current
 * write set is top-level files only). The restore always uses the real
 * filesystem — never the injectable install seam, so an injected
 * mid-install failure cannot also break the recovery.
 */
async function restorePreInstallPluginState(input: {
  pluginDir: string;
  backup: PluginBackupReceipt;
  plan: PluginWritePlanEntry[];
  pluginDirExisted: boolean;
  rolledBackAt: string;
}): Promise<PluginRollbackReceipt> {
  const restoredFiles: PluginBackupFileRecord[] = [];
  for (const entry of input.plan) {
    const target = join(input.pluginDir, entry.path);
    if (entry.backupRecord !== null) {
      if (input.backup.backupPath === null) {
        throw new PluginInstallVerificationError(
          `Rollback of ${entry.path} requires a backup path`,
        );
      }
      const source = join(input.backup.backupPath, entry.path);
      await defaultPluginInstallIo.copyFile(source, target);
      if (entry.backupRecord.mode === undefined) {
        throw new PluginInstallVerificationError(
          `Rollback of ${entry.path} requires a recorded file mode`,
        );
      }
      await chmod(target, entry.backupRecord.mode);
      const restoredHash = await sha256OfFile(target, defaultPluginInstallIo);
      if (restoredHash !== entry.backupRecord.sha256) {
        throw new PluginInstallVerificationError(
          `Rolled-back ${entry.path} hash ${restoredHash} differs from backup ${entry.backupRecord.sha256}`,
        );
      }
      const restoredMode = permissionMode((await lstat(target)).mode);
      if (restoredMode !== entry.backupRecord.mode) {
        throw new PluginInstallVerificationError(
          `Rolled-back ${entry.path} mode ${restoredMode.toString(8)} differs from backup ${entry.backupRecord.mode.toString(8)}`,
        );
      }
      restoredFiles.push({ path: entry.path, sha256: restoredHash, mode: restoredMode });
    } else {
      await rm(target, { force: true });
    }
  }
  if (!input.pluginDirExisted) {
    // Best effort: a first install that failed leaves no directory behind.
    await rmdir(input.pluginDir).catch(() => undefined);
  }
  return { restoredFiles, rolledBackAt: input.rolledBackAt };
}

/**
 * Installs the built plugin files and READS THEM BACK: every installed file
 * must hash identically to its build source and the installed manifest must
 * declare the same id/version as the build manifest. The install runs as a
 * provisional partial-install state (TEP-54 P1-2): every path is journaled
 * before its first write, and ANY mid-copy/mid-hash/mid-manifest failure
 * first restores the pre-install byte-for-byte state, then raises with the
 * restore evidence attached.
 */
export async function installPluginBuild(input: {
  buildDir: string;
  pluginDir: string;
  installedAt: string;
  backup: PluginBackupReceipt;
  io?: PluginInstallIo;
}): Promise<PluginInstallReceipt> {
  const io = input.io ?? defaultPluginInstallIo;
  assertPluginWriteAllowed(input.pluginDir);
  for (const required of PLUGIN_REQUIRED_BUILD_FILES) {
    try {
      const metadata = await lstat(join(input.buildDir, required));
      if (!metadata.isFile()) {
        throw new PluginInstallVerificationError(`Build directory lacks ${required}`);
      }
      if (PLUGIN_EXECUTABLE_BUILD_FILES.has(required) && (metadata.mode & 0o111) === 0) {
        throw new PluginInstallVerificationError(`Build file ${required} must be executable`);
      }
    } catch (error) {
      if (error instanceof PluginInstallVerificationError) throw error;
      if (
        typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: string }).code === 'ENOENT'
      ) {
        throw new PluginInstallVerificationError(`Build directory lacks ${required}`);
      }
      throw error;
    }
  }
  const manifest = await readManifestVersion(join(input.buildDir, 'manifest.json'), io);
  const relativePaths = new Set<string>(PLUGIN_REQUIRED_BUILD_FILES);
  for (const optional of PLUGIN_BACKUP_FILES) {
    if (optional === 'manifest.json' || optional === 'main.js') continue;
    try {
      const metadata = await lstat(join(input.buildDir, optional));
      if (metadata.isFile()) relativePaths.add(optional);
    } catch {
      // Optional build output — styles may be absent for this build.
    }
  }

  // Provisional state (TEP-54 P1-2): snapshot the write set BEFORE the first
  // write. A pre-existing file without a backup record fails closed here —
  // bytes without a restore source are never overwritten — and a non-regular
  // file (symlink, directory) is refused outright: copying through it would
  // escape the plugin directory and defeat byte-for-byte restore.
  const plan: PluginWritePlanEntry[] = [];
  for (const relativePath of [...relativePaths].sort()) {
    let existed = false;
    try {
      const metadata = await lstat(join(input.pluginDir, relativePath));
      if (!metadata.isFile()) {
        throw new PluginInstallVerificationError(
          `Plugin path ${relativePath} is occupied by a non-regular file; refusing to install`,
        );
      }
      existed = true;
    } catch (error) {
      if (error instanceof PluginInstallVerificationError) throw error;
      if (
        typeof error !== 'object' || error === null || !('code' in error)
        || (error as { code?: string }).code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    const backupRecord = input.backup.files.find((file) => file.path === relativePath) ?? null;
    if (existed && backupRecord === null) {
      throw new PluginInstallVerificationError(
        `Plugin file ${relativePath} exists in the plugin directory but is missing from the backup receipt; refusing to install without a restore source`,
      );
    }
    plan.push({ path: relativePath, existed, backupRecord: existed ? backupRecord : null });
  }
  let pluginDirExisted = true;
  try {
    await lstat(input.pluginDir);
  } catch (error) {
    if (
      typeof error !== 'object' || error === null || !('code' in error)
      || (error as { code?: string }).code !== 'ENOENT'
    ) {
      throw error;
    }
    pluginDirExisted = false;
  }

  const fileHashes: PluginBackupFileRecord[] = [];
  try {
    for (const entry of plan) {
      const source = join(input.buildDir, entry.path);
      const target = join(input.pluginDir, entry.path);
      await mkdir(join(target, '..'), { recursive: true });
      await io.copyFile(source, target);
      const sourceHash = await sha256OfFile(source, io);
      const installedHash = await sha256OfFile(target, io);
      if (sourceHash !== installedHash) {
        throw new PluginInstallVerificationError(
          `Installed ${entry.path} hash ${installedHash} differs from build ${sourceHash}`,
        );
      }
      const sourceMode = permissionMode((await lstat(source)).mode);
      await chmod(target, sourceMode);
      const installedMetadata = await lstat(target);
      const installedMode = permissionMode(installedMetadata.mode);
      if (sourceMode !== installedMode) {
        throw new PluginInstallVerificationError(
          `Installed ${entry.path} mode ${installedMode.toString(8)} differs from build ${sourceMode.toString(8)}`,
        );
      }
      if (PLUGIN_EXECUTABLE_BUILD_FILES.has(entry.path)) {
        if ((installedMetadata.mode & 0o111) === 0) {
          throw new PluginInstallVerificationError(
            `Installed ${entry.path} is not executable`,
          );
        }
      }
      fileHashes.push({ path: entry.path, sha256: installedHash, mode: installedMode });
    }
    const installedManifest = await readManifestVersion(join(input.pluginDir, 'manifest.json'), io);
    if (
      installedManifest.id !== manifest.id
      || installedManifest.version !== manifest.version
    ) {
      throw new PluginInstallVerificationError('Installed manifest does not match the build manifest');
    }
  } catch (error) {
    const reasonText = error instanceof Error ? error.message : String(error);
    try {
      const rollbackReceipt = await restorePreInstallPluginState({
        pluginDir: input.pluginDir,
        backup: input.backup,
        plan,
        pluginDirExisted,
        rolledBackAt: input.installedAt,
      });
      throw new PluginInstallPartialWriteError(
        `Plugin install failed (${reasonText}); all partial writes were rolled back to the pre-install state`,
        rollbackReceipt,
        error,
      );
    } catch (wrapped) {
      if (wrapped instanceof PluginInstallPartialWriteError) throw wrapped;
      throw new PluginInstallPartialWriteError(
        `Plugin install failed (${reasonText}) and the rollback itself failed (${wrapped instanceof Error ? wrapped.message : String(wrapped)}); the plugin directory is NOT verified`,
        null,
        error,
      );
    }
  }
  return {
    pluginDir: input.pluginDir,
    manifest: manifest.id,
    version: manifest.version,
    fileHashes,
    installedAt: input.installedAt,
  };
}

/**
 * Restores the pre-install plugin state: newly introduced build files are
 * removed, then every recorded file returns byte-for-byte. With a skipped
 * backup (first install), all installed files are removed. Both paths verify
 * the final state by hash.
 */
export async function rollbackPlugin(input: {
  backup: PluginBackupReceipt;
  install: PluginInstallReceipt;
  rolledBackAt: string;
}): Promise<PluginRollbackReceipt> {
  assertPluginWriteAllowed(input.install.pluginDir);
  if (input.backup.skippedReason !== null) {
    for (const file of input.install.fileHashes) {
      await rm(join(input.install.pluginDir, file.path), { force: true });
    }
    return { restoredFiles: [], rolledBackAt: input.rolledBackAt };
  }
  if (input.backup.backupPath === null) {
    throw new PluginInstallVerificationError('Rollback requires a backup path');
  }
  const backedUpPaths = new Set(input.backup.files.map((file) => file.path));
  for (const installed of input.install.fileHashes) {
    if (!backedUpPaths.has(installed.path)) {
      await rm(join(input.install.pluginDir, installed.path), { force: true });
    }
  }
  const restoredFiles = [];
  for (const record of input.backup.files) {
    const source = join(input.backup.backupPath, record.path);
    const target = join(input.install.pluginDir, record.path);
    await mkdir(join(target, '..'), { recursive: true });
    if (record.mode === undefined) {
      throw new PluginInstallVerificationError(
        `Rollback of ${record.path} requires a recorded file mode`,
      );
    }
    await copyFile(source, target);
    await chmod(target, record.mode);
    const restoredHash = await sha256OfFile(target, defaultPluginInstallIo);
    if (restoredHash !== record.sha256) {
      throw new PluginInstallVerificationError(
        `Rolled-back ${record.path} hash ${restoredHash} differs from backup ${record.sha256}`,
      );
    }
    const restoredMode = permissionMode((await lstat(target)).mode);
    if (restoredMode !== record.mode) {
      throw new PluginInstallVerificationError(
        `Rolled-back ${record.path} mode ${restoredMode.toString(8)} differs from backup ${record.mode.toString(8)}`,
      );
    }
    restoredFiles.push({ path: record.path, sha256: restoredHash, mode: restoredMode });
  }
  return { restoredFiles, rolledBackAt: input.rolledBackAt };
}
