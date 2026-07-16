import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackgroundRuntimeController,
  type BackgroundRuntimeDependencies,
  type BackgroundSettings,
} from '../../../src/obsidian-plugin/background-runtime-controller.js';
import type { RuntimeDetectionResult } from '../../../src/obsidian-plugin/runtime-detection.js';

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-background-controller-'));
  temporaryRoots.push(root);
  const vaultRoot = join(root, 'vault');
  const homeDirectory = join(root, 'home');
  const runnerPath = join(root, 'plugin', 'atl-runner.mjs');
  const sourceRoot = join(root, 'research');
  const claudeConfigDirectory = join(root, 'claude');
  await Promise.all([
    mkdir(vaultRoot, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(join(root, 'plugin'), { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(claudeConfigDirectory, { recursive: true }),
  ]);
  return { root, vaultRoot, homeDirectory, runnerPath, sourceRoot, claudeConfigDirectory };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function settings(paths: Awaited<ReturnType<typeof fixture>>): BackgroundSettings {
  return {
    nodeExecutable: '/resolved/node',
    claudeExecutable: '/resolved/claude',
    claudeConfigDirectory: paths.claudeConfigDirectory,
    allowedLocalRoots: [paths.sourceRoot],
    modelServiceMode: 'inherit',
    model: 'claude-sonnet-4-5',
    baseUrl: '',
    dailyLimit: 3,
  };
}

function dependencies(
  paths: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<BackgroundRuntimeDependencies> = {},
): BackgroundRuntimeDependencies {
  return {
    vaultRoot: paths.vaultRoot,
    homeDirectory: paths.homeDirectory,
    runnerPath: paths.runnerPath,
    detectRuntime: vi.fn(async () => ({
      state: 'healthy',
      platformSupported: true,
      node: { ok: true, path: '/resolved/node', majorVersion: 24 },
      claude: { ok: true, path: '/resolved/claude', loggedIn: true },
      runner: { ok: true, path: paths.runnerPath },
    } satisfies RuntimeDetectionResult)),
    inspectScheduler: vi.fn(async () => ({
      path: join(paths.homeDirectory, 'Library/LaunchAgents/ai.agent-task-loop.runner.plist'),
      installed: false,
      managed: false,
      label: null,
    })),
    inspectProcess: vi.fn(async () => ({ loaded: false, running: false })),
    installScheduler: vi.fn(async () => ({
      path: 'managed.plist',
      installed: true,
      managed: true,
      label: 'ai.agent-task-loop.runner',
    })),
    kickstartScheduler: vi.fn(async () => ({ loaded: true, running: true })),
    uninstallScheduler: vi.fn(async () => ({
      path: 'managed.plist',
      installed: false,
      managed: true,
      label: 'ai.agent-task-loop.runner',
    })),
    ...overrides,
  };
}

describe('BackgroundRuntimeController', () => {
  it('maps healthy prerequisites and an absent scheduler to installable', async () => {
    const paths = await fixture();
    const controller = new BackgroundRuntimeController(dependencies(paths));

    await expect(controller.inspect(settings(paths))).resolves.toMatchObject({
      state: 'installable',
      checks: {
        node: 'ok',
        claude: 'ok',
        runner: 'ok',
        scheduler: 'absent',
      },
      errorMessage: null,
    });
  });

  it('reports ready and running states for the managed scheduler', async () => {
    const paths = await fixture();
    const readyController = new BackgroundRuntimeController(dependencies(paths, {
      inspectScheduler: vi.fn(async () => ({
        path: 'managed.plist',
        installed: true,
        managed: true,
        label: 'ai.agent-task-loop.runner',
      })),
      inspectProcess: vi.fn(async () => ({ loaded: true, running: false })),
    }));
    await expect(readyController.inspect(settings(paths))).resolves.toMatchObject({
      state: 'ready',
      checks: { scheduler: 'installed' },
    });

    const runningController = new BackgroundRuntimeController(dependencies(paths, {
      inspectScheduler: vi.fn(async () => ({
        path: 'managed.plist',
        installed: true,
        managed: true,
        label: 'ai.agent-task-loop.runner',
      })),
      inspectProcess: vi.fn(async () => ({ loaded: true, running: true })),
    }));
    await expect(runningController.inspect(settings(paths))).resolves.toMatchObject({
      state: 'running',
      checks: { scheduler: 'running' },
    });
  });

  it('maps logged-out Claude and scheduler conflicts to stable Chinese errors', async () => {
    const paths = await fixture();
    const loggedOut = new BackgroundRuntimeController(dependencies(paths, {
      detectRuntime: vi.fn(async () => ({
        state: 'logged_out',
        platformSupported: true,
        node: { ok: true, path: '/resolved/node', majorVersion: 24 },
        claude: { ok: false, path: null, reason: 'command_failed', loggedIn: false },
        runner: { ok: true, path: paths.runnerPath },
      } satisfies RuntimeDetectionResult)),
    }));
    await expect(loggedOut.inspect(settings(paths))).resolves.toMatchObject({
      state: 'error',
      checks: { claude: 'logged_out' },
      errorMessage: 'Claude Code 尚未登录，请先在 Claude Code 中完成登录。',
    });

    const conflict = new BackgroundRuntimeController(dependencies(paths, {
      inspectScheduler: vi.fn(async () => ({
        path: 'conflicting.plist',
        installed: true,
        managed: false,
        label: 'example.other-service',
      })),
    }));
    await expect(conflict.inspect(settings(paths))).resolves.toMatchObject({
      state: 'error',
      checks: { scheduler: 'conflict' },
      errorMessage: '检测到同名但不受 ATL 管理的后台配置，未做任何修改。',
    });
  });

  it('enables the scheduler with canonical source roots and fixed ATL environment', async () => {
    const paths = await fixture();
    const deps = dependencies(paths);
    const controller = new BackgroundRuntimeController(deps);

    await controller.enable(settings(paths));

    expect(deps.installScheduler).toHaveBeenCalledWith(expect.objectContaining({
      homeDirectory: paths.homeDirectory,
      nodeExecutable: '/resolved/node',
      runnerEntry: paths.runnerPath,
      environment: expect.objectContaining({
        ATL_VAULT_ROOT: await realpath(paths.vaultRoot),
        ATL_ALLOW_REAL_WRITES: '1',
        ATL_CLAUDE_BIN: '/resolved/claude',
        ATL_CLAUDE_CONFIG_DIR: await realpath(paths.claudeConfigDirectory),
        ATL_ALLOWED_LOCAL_ROOTS: await realpath(paths.sourceRoot),
        ATL_CLAUDE_MODEL: 'claude-sonnet-4-5',
        ATL_DAILY_LIMIT: '3',
      }),
    }));
  });

  it('delegates manual run and refuses to disable a conflicting scheduler', async () => {
    const paths = await fixture();
    const deps = dependencies(paths);
    const controller = new BackgroundRuntimeController(deps);
    await controller.runNow();
    expect(deps.kickstartScheduler).toHaveBeenCalledWith({
      homeDirectory: paths.homeDirectory,
    });

    const conflictDeps = dependencies(paths, {
      inspectScheduler: vi.fn(async () => ({
        path: 'conflicting.plist',
        installed: true,
        managed: false,
        label: 'example.other-service',
      })),
    });
    const conflict = new BackgroundRuntimeController(conflictDeps);
    await expect(conflict.disable()).rejects.toThrow(
      '检测到同名但不受 ATL 管理的后台配置，未做任何修改。',
    );
    expect(conflictDeps.uninstallScheduler).not.toHaveBeenCalled();
  });
});
