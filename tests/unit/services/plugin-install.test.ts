import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPluginWriteAllowed,
  backupExistingPlugin,
  defaultPluginInstallIo,
  installPluginBuild,
  PluginInstallPartialWriteError,
  PluginInstallVerificationError,
  PluginWriteDisabledError,
  rollbackPlugin,
  type PluginInstallIo,
} from '../../../src/services/plugin-install.js';

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function snapshotFiles(
  dir: string,
  names: readonly string[],
): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};
  for (const name of names) {
    try {
      snapshot[name] = await readFile(join(dir, name), 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: string }).code === 'ENOENT'
      ) {
        snapshot[name] = null;
        continue;
      }
      throw error;
    }
  }
  return snapshot;
}

function manifest(id: string, version: string): string {
  return `${JSON.stringify({ id, version, minAppVersion: '1.0.0' })}\n`;
}

async function seedRuntimeBuild(
  buildDir: string,
  input: { main?: string; styles?: string } = {},
): Promise<void> {
  await writeFile(join(buildDir, 'manifest.json'), manifest('agent-task-loop', '0.9.1'));
  await writeFile(join(buildDir, 'main.js'), input.main ?? 'new main bytes');
  await writeFile(join(buildDir, 'atl-runner.mjs'), 'new runner');
  await writeFile(join(buildDir, 'atl-dingtalk-bridge.mjs'), 'new bridge');
  await writeFile(join(buildDir, 'atl-dingtalk-stream.mjs'), 'new stream');
  await writeFile(join(buildDir, 'qianwen-accessibility-helper'), 'new qianwen helper');
  await chmod(join(buildDir, 'qianwen-accessibility-helper'), 0o755);
  if (input.styles !== undefined) {
    await writeFile(join(buildDir, 'styles.css'), input.styles);
  }
}

describe('plugin backup/install/rollback', () => {
  let pluginDir: string;
  let backupRoot: string;
  let buildDir: string;

  beforeEach(async () => {
    const root = await tempRoot('paw-t3-plugin-');
    pluginDir = join(root, 'plugins', 'agent-task-loop');
    backupRoot = join(root, 'backups');
    buildDir = join(root, 'build');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(pluginDir, '..', '..'), { recursive: true, force: true });
  });

  it('backs up manifest, main, styles and runner/bridge files with hashes', async () => {
    await writeFile(join(pluginDir, 'manifest.json'), manifest('agent-task-loop', '0.8.0'));
    await writeFile(join(pluginDir, 'main.js'), 'old main');
    await writeFile(join(pluginDir, 'styles.css'), 'old styles');
    await writeFile(join(pluginDir, 'atl-runner.mjs'), 'old runner');
    await writeFile(join(pluginDir, 'atl-dingtalk-bridge.mjs'), 'old flat bridge');
    await writeFile(join(pluginDir, 'atl-dingtalk-stream.mjs'), 'old stream');
    await writeFile(join(pluginDir, 'qianwen-accessibility-helper'), 'old qianwen helper');
    await mkdir(join(pluginDir, 'runner'));
    await writeFile(join(pluginDir, 'runner', 'bridge.js'), 'old bridge');
    await mkdir(join(pluginDir, 'unrelated'));
    await writeFile(join(pluginDir, 'unrelated', 'extra.txt'), 'ignored');

    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });
    expect(backup.skippedReason).toBeNull();
    expect(backup.files.map((file) => file.path)).toEqual([
      'manifest.json',
      'main.js',
      'styles.css',
      'atl-runner.mjs',
      'atl-dingtalk-bridge.mjs',
      'atl-dingtalk-stream.mjs',
      'qianwen-accessibility-helper',
      'runner/bridge.js',
    ]);
    for (const file of backup.files) {
      expect(await readFile(join(backup.backupPath!, file.path), 'utf8')).toBe(
        await readFile(join(pluginDir, file.path), 'utf8'),
      );
    }
  });

  it('reports a skipped backup when no plugin exists yet', async () => {
    const backup = await backupExistingPlugin({
      pluginDir: join(pluginDir, 'not-installed'),
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });
    expect(backup.skippedReason).toBe('no_existing_plugin');
    expect(backup.files).toEqual([]);
  });

  it('installs a build and verifies the read-back hashes and manifest version', async () => {
    await seedRuntimeBuild(buildDir, { styles: 'new styles' });
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });

    const install = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    });
    expect(install.version).toBe('0.9.1');
    expect(install.manifest).toBe('agent-task-loop');
    expect(install.fileHashes.map((file) => file.path)).toEqual([
      'atl-dingtalk-bridge.mjs',
      'atl-dingtalk-stream.mjs',
      'atl-runner.mjs',
      'main.js',
      'manifest.json',
      'qianwen-accessibility-helper',
      'styles.css',
    ]);
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('new main bytes');
    expect(await readFile(join(pluginDir, 'atl-runner.mjs'), 'utf8')).toBe('new runner');
  });

  it('rejects a build without a complete background runtime', async () => {
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(buildDir, 'manifest.json'), manifest('agent-task-loop', '0.9.1'));
    await writeFile(join(buildDir, 'main.js'), 'new main');
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });
    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    })).rejects.toThrow(PluginInstallVerificationError);
  });

  it('rejects a runtime build that omits the packaged Qianwen helper', async () => {
    await seedRuntimeBuild(buildDir);
    await rm(join(buildDir, 'qianwen-accessibility-helper'));
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });

    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    })).rejects.toThrow('Build directory lacks qianwen-accessibility-helper');
  });

  it('rejects a packaged Qianwen helper without an executable bit', async () => {
    await seedRuntimeBuild(buildDir);
    await chmod(join(buildDir, 'qianwen-accessibility-helper'), 0o644);
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });

    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    })).rejects.toThrow('Build file qianwen-accessibility-helper must be executable');
  });

  it('restores the backed-up plugin byte-for-byte on rollback', async () => {
    await writeFile(join(pluginDir, 'manifest.json'), manifest('agent-task-loop', '0.8.0'));
    await writeFile(join(pluginDir, 'main.js'), 'old main');
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });

    await seedRuntimeBuild(buildDir, { main: 'new main' });
    await writeFile(join(buildDir, 'atl-dingtalk-stream.mjs.map'), 'new stream map');
    const install = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    });
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('new main');

    const rollback = await rollbackPlugin({
      backup,
      install,
      rolledBackAt: '2026-08-21T02:10:00.000Z',
    });
    expect(rollback.restoredFiles.map((file) => file.path).sort()).toEqual(['main.js', 'manifest.json']);
    expect(await readFile(join(pluginDir, 'main.js'), 'utf8')).toBe('old main');
    expect(await readFile(join(pluginDir, 'manifest.json'), 'utf8')).toBe(manifest('agent-task-loop', '0.8.0'));
    await expect(readFile(join(pluginDir, 'atl-dingtalk-stream.mjs.map'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the backed-up executable mode as well as its bytes', async () => {
    await writeFile(join(pluginDir, 'qianwen-accessibility-helper'), 'old qianwen helper');
    await chmod(join(pluginDir, 'qianwen-accessibility-helper'), 0o700);
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });

    await seedRuntimeBuild(buildDir);
    const install = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    });
    expect((await lstat(join(pluginDir, 'qianwen-accessibility-helper'))).mode & 0o777)
      .toBe(0o755);

    const rollback = await rollbackPlugin({
      backup,
      install,
      rolledBackAt: '2026-08-21T02:10:00.000Z',
    });
    expect(await readFile(join(pluginDir, 'qianwen-accessibility-helper'), 'utf8'))
      .toBe('old qianwen helper');
    expect((await lstat(join(pluginDir, 'qianwen-accessibility-helper'))).mode & 0o777)
      .toBe(0o700);
    expect(rollback.restoredFiles.find((file) => file.path === 'qianwen-accessibility-helper')?.mode)
      .toBe(0o700);
  });

  it('removes installed files when rolling back a first install', async () => {
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T02:06:00.000Z',
    });
    await seedRuntimeBuild(buildDir, { main: 'new main' });
    const install = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T02:08:00.000Z',
      backup,
    });

    await rollbackPlugin({ backup, install, rolledBackAt: '2026-08-21T02:10:00.000Z' });
    await expect(readFile(join(pluginDir, 'main.js'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
    });
    await expect(readFile(join(pluginDir, 'manifest.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fail-closes writes outside temp roots without ATL_ALLOW_REAL_WRITES', async () => {
    const previous = process.env.ATL_ALLOW_REAL_WRITES;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    try {
      expect(() => assertPluginWriteAllowed('/Users/release/plugins/agent-task-loop'))
        .toThrow(PluginWriteDisabledError);
      expect(() => assertPluginWriteAllowed(join(tmpdir(), 'atl-synthetic')))
        .not.toThrow();
      process.env.ATL_ALLOW_REAL_WRITES = '1';
      expect(() => assertPluginWriteAllowed('/Users/release/plugins/agent-task-loop'))
        .not.toThrow();
    } finally {
      if (previous === undefined) {
        delete process.env.ATL_ALLOW_REAL_WRITES;
      } else {
        process.env.ATL_ALLOW_REAL_WRITES = previous;
      }
    }
  });
});

describe('plugin install partial-write rollback (TEP-54 P1-2)', () => {
  let pluginDir: string;
  let backupRoot: string;
  let buildDir: string;
  const watchedFiles = ['manifest.json', 'main.js', 'styles.css'] as const;

  beforeEach(async () => {
    const root = await tempRoot('paw-t3-partial-');
    pluginDir = join(root, 'plugins', 'agent-task-loop');
    backupRoot = join(root, 'backups');
    buildDir = join(root, 'build');
    await mkdir(join(root, 'plugins'), { recursive: true });
    await mkdir(buildDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(pluginDir, '..', '..'), { recursive: true, force: true });
  });

  async function seedExistingPlugin(): Promise<void> {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'manifest.json'), manifest('agent-task-loop', '0.8.0'));
    await writeFile(join(pluginDir, 'main.js'), 'old main bytes');
    await writeFile(join(pluginDir, 'styles.css'), 'old styles bytes');
    await seedRuntimeBuild(buildDir, { styles: 'new styles bytes' });
  }

  it('restores the pre-install bytes when a copy is torn mid-write', async () => {
    await seedExistingPlugin();
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });
    const before = await snapshotFiles(pluginDir, watchedFiles);
    // Sorted copy order starts with main.js: tear it after partial bytes land.
    const tornCopyIo: PluginInstallIo = {
      copyFile: async (source, target) => {
        if (target === join(pluginDir, 'main.js')) {
          await writeFile(target, 'torn partial main');
          throw new Error('EIO: copy torn mid-write');
        }
        await defaultPluginInstallIo.copyFile(source, target);
      },
      readFile: (path) => defaultPluginInstallIo.readFile(path),
    };

    const failure = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
      io: tornCopyIo,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PluginInstallPartialWriteError);
    expect(failure).toBeInstanceOf(PluginInstallVerificationError);
    const partial = failure as PluginInstallPartialWriteError;
    expect(partial.rollbackReceipt?.restoredFiles.map((file) => file.path))
      .toContain('main.js');
    expect(await snapshotFiles(pluginDir, watchedFiles)).toEqual(before);
  });

  it('restores the pre-install bytes when the installed-file hash read fails mid-hash', async () => {
    await seedExistingPlugin();
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });
    const before = await snapshotFiles(pluginDir, watchedFiles);
    const midHashIo: PluginInstallIo = {
      copyFile: (source, target) => defaultPluginInstallIo.copyFile(source, target),
      readFile: async (path) => {
        if (path === join(pluginDir, 'main.js')) {
          throw new Error('EIO: hash read failed');
        }
        return defaultPluginInstallIo.readFile(path);
      },
    };

    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
      io: midHashIo,
    })).rejects.toBeInstanceOf(PluginInstallPartialWriteError);
    expect(await snapshotFiles(pluginDir, watchedFiles)).toEqual(before);
  });

  it('restores the pre-install bytes when the installed manifest read fails mid-manifest', async () => {
    await seedExistingPlugin();
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });
    const before = await snapshotFiles(pluginDir, watchedFiles);
    let copies = 0;
    const midManifestIo: PluginInstallIo = {
      copyFile: async (source, target) => {
        await defaultPluginInstallIo.copyFile(source, target);
        copies += 1;
      },
      readFile: async (path) => {
        // The installed-manifest read only happens after every copy landed.
        if (path === join(pluginDir, 'manifest.json') && copies >= 3) {
          throw new Error('EIO: manifest read failed');
        }
        return defaultPluginInstallIo.readFile(path);
      },
    };

    const failure = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
      io: midManifestIo,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PluginInstallPartialWriteError);
    const partial = failure as PluginInstallPartialWriteError;
    expect(partial.rollbackReceipt?.restoredFiles.map((file) => file.path).sort())
      .toEqual(['main.js', 'manifest.json', 'styles.css']);
    expect(await snapshotFiles(pluginDir, watchedFiles)).toEqual(before);
  });

  it('removes every partial write when a first install fails mid-copy', async () => {
    await seedRuntimeBuild(buildDir);
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });
    expect(backup.skippedReason).toBe('no_existing_plugin');
    const tornCopyIo: PluginInstallIo = {
      copyFile: async (source, target) => {
        if (target === join(pluginDir, 'manifest.json')) {
          await writeFile(target, '{"id":"agent-task-loop","ver');
          throw new Error('EIO: copy torn mid-write');
        }
        await defaultPluginInstallIo.copyFile(source, target);
      },
      readFile: (path) => defaultPluginInstallIo.readFile(path),
    };

    const failure = await installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
      io: tornCopyIo,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PluginInstallPartialWriteError);
    const partial = failure as PluginInstallPartialWriteError;
    expect(partial.rollbackReceipt?.restoredFiles).toEqual([]);
    // Pre-install state: the plugin directory itself did not exist.
    await expect(lstat(pluginDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite a plugin file the backup receipt does not cover', async () => {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'styles.css'), 'precious unbacked styles');
    await seedRuntimeBuild(buildDir, { styles: 'new styles bytes' });
    const backup = await backupExistingPlugin({
      pluginDir: join(pluginDir, 'not-the-real-dir'),
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });

    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
    })).rejects.toThrow('missing from the backup receipt');
    expect(await readFile(join(pluginDir, 'styles.css'), 'utf8'))
      .toBe('precious unbacked styles');
    expect(await snapshotFiles(pluginDir, watchedFiles)).toEqual({
      'manifest.json': null,
      'main.js': null,
      'styles.css': 'precious unbacked styles',
    });
  });

  it('refuses a planned path occupied by a symlink or directory before any write', async () => {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'manifest.json'), manifest('agent-task-loop', '0.8.0'));
    await writeFile(join(pluginDir, 'main.js'), 'old main bytes');
    await symlink(
      join(pluginDir, 'outside-target.js'),
      join(pluginDir, 'styles.css'),
    );
    await writeFile(join(pluginDir, 'outside-target.js'), 'referent bytes');
    await seedRuntimeBuild(buildDir, { styles: 'new styles bytes' });
    const backup = await backupExistingPlugin({
      pluginDir,
      backupRoot,
      timestamp: '2026-08-21T04:30:00.000Z',
    });

    await expect(installPluginBuild({
      buildDir,
      pluginDir,
      installedAt: '2026-08-21T04:31:00.000Z',
      backup,
    })).rejects.toThrow('non-regular file');
    // Nothing was written — through the link or otherwise.
    expect(await readFile(join(pluginDir, 'outside-target.js'), 'utf8'))
      .toBe('referent bytes');
    expect(await readFile(join(pluginDir, 'manifest.json'), 'utf8'))
      .toBe(manifest('agent-task-loop', '0.8.0'));
  });
});
