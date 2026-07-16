import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectRuntime,
  type RuntimeCommandExecutor,
} from '../../../src/obsidian-plugin/runtime-detection.js';

const roots: string[] = [];

async function executable(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n', 'utf8');
  await chmod(path, 0o700);
  return path;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-runtime-detection-'));
  roots.push(root);
  const home = join(root, 'home');
  const node = await realpath(await executable(join(root, 'bin', 'node')));
  const claude = await realpath(await executable(join(root, 'bin', 'claude')));
  const runner = join(root, 'plugin', 'atl-runner.mjs');
  await mkdir(home, { recursive: true });
  await mkdir(join(root, 'plugin'), { recursive: true });
  await writeFile(runner, 'export {};\n', 'utf8');
  return { root, home, node, claude, runner: await realpath(runner) };
}

function commands(
  responses: Record<string, { stdout: string; exitCode: number }>,
): RuntimeCommandExecutor {
  return {
    execute: vi.fn(async (command, args) => {
      const response = responses[
      `${command} ${args.join(' ')}`
      ];
      return response === undefined
        ? { stdout: '', stderr: 'missing synthetic response', exitCode: 1 }
        : { ...response, stderr: '' };
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('detectRuntime', () => {
  it('accepts saved Node 24, logged-in Claude, and a packaged runner', async () => {
    const paths = await fixture();
    const executor = commands({
      [`${paths.node} --version`]: { stdout: 'v24.15.0', exitCode: 0 },
      [`${paths.claude} auth status`]: {
        stdout: '{"loggedIn":true,"authMethod":"oauth_token"}',
        exitCode: 0,
      },
    });

    const result = await detectRuntime({
      savedNodePath: paths.node,
      savedClaudePath: paths.claude,
      runnerPath: paths.runner,
      homeDirectory: paths.home,
      platform: 'darwin',
      commands: executor,
      candidateFinder: async () => [],
    });

    expect(result).toMatchObject({
      state: 'healthy',
      node: { ok: true, majorVersion: 24 },
      claude: { ok: true, loggedIn: true },
      runner: { ok: true },
    });
    expect(executor.execute).toHaveBeenCalledWith(paths.node, ['--version']);
    expect(executor.execute).toHaveBeenCalledWith(paths.claude, ['auth', 'status']);
  });

  it('reports an unsupported Node without attempting Claude authentication', async () => {
    const paths = await fixture();
    const executor = commands({
      [`${paths.node} --version`]: { stdout: 'v22.17.0', exitCode: 0 },
    });

    const result = await detectRuntime({
      savedNodePath: paths.node,
      savedClaudePath: paths.claude,
      runnerPath: paths.runner,
      homeDirectory: paths.home,
      platform: 'darwin',
      commands: executor,
      candidateFinder: async () => [],
    });

    expect(result.state).toBe('invalid');
    expect(result.node).toMatchObject({ ok: false, reason: 'unsupported_version' });
    expect(executor.execute).not.toHaveBeenCalledWith(paths.claude, ['auth', 'status']);
  });

  it('distinguishes a logged-out Claude from a missing prerequisite', async () => {
    const paths = await fixture();
    const executor = commands({
      [`${paths.node} --version`]: { stdout: 'v24.15.0', exitCode: 0 },
      [`${paths.claude} auth status`]: {
        stdout: '{"loggedIn":false}',
        exitCode: 0,
      },
    });

    const result = await detectRuntime({
      savedNodePath: paths.node,
      savedClaudePath: paths.claude,
      runnerPath: paths.runner,
      homeDirectory: paths.home,
      platform: 'darwin',
      commands: executor,
      candidateFinder: async () => [],
    });

    expect(result.state).toBe('logged_out');
    expect(result.claude).toMatchObject({ ok: false, loggedIn: false });
  });

  it('reports missing executables and runner without throwing', async () => {
    const paths = await fixture();
    const result = await detectRuntime({
      savedNodePath: join(paths.root, 'missing-node'),
      savedClaudePath: join(paths.root, 'missing-claude'),
      runnerPath: join(paths.root, 'missing-runner'),
      homeDirectory: paths.home,
      platform: 'darwin',
      commands: commands({}),
      candidateFinder: async () => [],
    });

    expect(result).toMatchObject({
      state: 'missing',
      node: { ok: false, reason: 'missing' },
      claude: { ok: false, reason: 'missing', loggedIn: false },
      runner: { ok: false, reason: 'missing' },
    });
  });

  it('rejects non-macOS hosts before executing local tools', async () => {
    const paths = await fixture();
    const executor = commands({});

    const result = await detectRuntime({
      savedNodePath: paths.node,
      savedClaudePath: paths.claude,
      runnerPath: paths.runner,
      homeDirectory: paths.home,
      platform: 'linux',
      commands: executor,
      candidateFinder: async () => [],
    });

    expect(result.state).toBe('invalid');
    expect(result.platformSupported).toBe(false);
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
