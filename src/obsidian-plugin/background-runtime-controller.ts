import { realpath, stat } from 'node:fs/promises';
import { delimiter } from 'node:path';

import {
  inspectLaunchAgent,
  inspectLaunchAgentProcess,
  installLaunchAgent,
  kickstartLaunchAgent,
  type LaunchAgentLifecycleOptions,
  type LaunchAgentProcessOptions,
  type LaunchAgentProcessStatus,
  type LaunchAgentStatus,
  uninstallLaunchAgent,
  type UninstallLaunchAgentOptions,
} from '../scheduler/launch-agent.js';
import {
  detectRuntime,
  type DetectRuntimeOptions,
  type RuntimeDetectionResult,
} from './runtime-detection.js';

export interface BackgroundSettings {
  nodeExecutable: string;
  claudeExecutable: string;
  claudeConfigDirectory: string;
  allowedLocalRoots: string[];
  model: string;
  dailyLimit: number;
}

export type BackgroundState =
  | 'unconfigured'
  | 'installable'
  | 'ready'
  | 'running'
  | 'error';

export interface BackgroundChecks {
  node: 'ok' | 'missing' | 'invalid';
  claude: 'ok' | 'missing' | 'logged_out' | 'invalid';
  runner: 'ok' | 'missing';
  scheduler: 'absent' | 'installed' | 'running' | 'conflict' | 'unknown';
}

export interface BackgroundInspection {
  state: BackgroundState;
  checks: BackgroundChecks;
  errorMessage: string | null;
  detected: {
    nodeExecutable: string;
    claudeExecutable: string;
  };
}

export interface BackgroundRuntimeDependencies {
  vaultRoot: string;
  homeDirectory: string;
  runnerPath: string;
  detectRuntime(options: DetectRuntimeOptions): Promise<RuntimeDetectionResult>;
  inspectScheduler(options: { homeDirectory?: string }): Promise<LaunchAgentStatus>;
  inspectProcess(options: LaunchAgentProcessOptions): Promise<LaunchAgentProcessStatus>;
  installScheduler(options: LaunchAgentLifecycleOptions): Promise<LaunchAgentStatus>;
  kickstartScheduler(options: LaunchAgentProcessOptions): Promise<LaunchAgentProcessStatus>;
  uninstallScheduler(options: UninstallLaunchAgentOptions): Promise<LaunchAgentStatus>;
}

export class BackgroundRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundRuntimeError';
  }
}

const CLAUDE_LOGGED_OUT = 'Claude Code 尚未登录，请先在 Claude Code 中完成登录。';
const SCHEDULER_CONFLICT = '检测到同名但不受 ATL 管理的后台配置，未做任何修改。';

function defaultChecks(runtime: RuntimeDetectionResult): BackgroundChecks {
  return {
    node: runtime.node.ok
      ? 'ok'
      : runtime.node.reason === 'missing' ? 'missing' : 'invalid',
    claude: runtime.claude.ok
      ? 'ok'
      : runtime.state === 'logged_out'
        ? 'logged_out'
        : runtime.claude.reason === 'missing' ? 'missing' : 'invalid',
    runner: runtime.runner.ok ? 'ok' : 'missing',
    scheduler: 'unknown',
  };
}

function runtimeError(runtime: RuntimeDetectionResult): string | null {
  if (!runtime.platformSupported) return '后台执行目前仅支持 macOS 桌面版 Obsidian。';
  if (runtime.state === 'logged_out') return CLAUDE_LOGGED_OUT;
  if (runtime.state === 'invalid') return 'Node.js 或 Claude Code 配置无效，请重新检测环境。';
  return null;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new BackgroundRuntimeError(`${label}不存在或不是文件夹。`);
  }
}

export function createBackgroundRuntimeDependencies(options: {
  vaultRoot: string;
  homeDirectory: string;
  runnerPath: string;
}): BackgroundRuntimeDependencies {
  return {
    ...options,
    detectRuntime,
    inspectScheduler: inspectLaunchAgent,
    inspectProcess: inspectLaunchAgentProcess,
    installScheduler: installLaunchAgent,
    kickstartScheduler: kickstartLaunchAgent,
    uninstallScheduler: uninstallLaunchAgent,
  };
}

export class BackgroundRuntimeController {
  constructor(private readonly dependencies: BackgroundRuntimeDependencies) {}

  private async detect(settings: BackgroundSettings): Promise<RuntimeDetectionResult> {
    return this.dependencies.detectRuntime({
      savedNodePath: settings.nodeExecutable,
      savedClaudePath: settings.claudeExecutable,
      runnerPath: this.dependencies.runnerPath,
      homeDirectory: this.dependencies.homeDirectory,
    });
  }

  async inspect(settings: BackgroundSettings): Promise<BackgroundInspection> {
    try {
      const runtime = await this.detect(settings);
      const checks = defaultChecks(runtime);
      const detected = {
        nodeExecutable: runtime.node.ok ? runtime.node.path : '',
        claudeExecutable: runtime.claude.ok ? runtime.claude.path : '',
      };
      const errorMessage = runtimeError(runtime);
      if (errorMessage !== null) {
        return { state: 'error', checks, errorMessage, detected };
      }
      if (runtime.state !== 'healthy') {
        return {
          state: 'unconfigured',
          checks,
          errorMessage: null,
          detected,
        };
      }

      const scheduler = await this.dependencies.inspectScheduler({
        homeDirectory: this.dependencies.homeDirectory,
      });
      if (scheduler.installed && !scheduler.managed) {
        return {
          state: 'error',
          checks: { ...checks, scheduler: 'conflict' },
          errorMessage: SCHEDULER_CONFLICT,
          detected,
        };
      }
      if (!scheduler.installed) {
        return {
          state: 'installable',
          checks: { ...checks, scheduler: 'absent' },
          errorMessage: null,
          detected,
        };
      }
      const process = await this.dependencies.inspectProcess({
        homeDirectory: this.dependencies.homeDirectory,
      });
      return {
        state: process.running ? 'running' : 'ready',
        checks: {
          ...checks,
          scheduler: process.running ? 'running' : 'installed',
        },
        errorMessage: null,
        detected,
      };
    } catch {
      return {
        state: 'error',
        checks: {
          node: 'invalid',
          claude: 'invalid',
          runner: 'missing',
          scheduler: 'unknown',
        },
        errorMessage: '无法读取后台配置，请稍后重试。',
        detected: { nodeExecutable: '', claudeExecutable: '' },
      };
    }
  }

  async enable(settings: BackgroundSettings): Promise<void> {
    const runtime = await this.detect(settings);
    if (
      runtime.state !== 'healthy'
      || !runtime.node.ok
      || !runtime.claude.ok
      || !runtime.runner.ok
    ) {
      throw new BackgroundRuntimeError(
        runtimeError(runtime) ?? '后台环境尚未配置完整，请先检测环境。',
      );
    }
    const existing = await this.dependencies.inspectScheduler({
      homeDirectory: this.dependencies.homeDirectory,
    });
    if (existing.installed && !existing.managed) {
      throw new BackgroundRuntimeError(SCHEDULER_CONFLICT);
    }
    const [vaultRoot, claudeConfigDirectory, ...allowedLocalRoots] = await Promise.all([
      canonicalDirectory(this.dependencies.vaultRoot, '当前 Vault'),
      canonicalDirectory(settings.claudeConfigDirectory, 'Claude 配置文件夹'),
      ...settings.allowedLocalRoots.map((path) => canonicalDirectory(path, '资料来源文件夹')),
    ]);
    await this.dependencies.installScheduler({
      homeDirectory: this.dependencies.homeDirectory,
      nodeExecutable: runtime.node.path,
      runnerEntry: runtime.runner.path,
      environment: {
        ATL_VAULT_ROOT: vaultRoot,
        ATL_ALLOW_REAL_WRITES: '1',
        ATL_AGENT_DRIVER: 'claude',
        ATL_CLAUDE_BIN: runtime.claude.path,
        ATL_CLAUDE_CONFIG_DIR: claudeConfigDirectory,
        ATL_CLAUDE_MODEL: settings.model,
        ATL_ALLOWED_LOCAL_ROOTS: allowedLocalRoots.join(delimiter),
        ATL_DAILY_LIMIT: String(settings.dailyLimit),
      },
    });
  }

  async runNow(): Promise<void> {
    await this.dependencies.kickstartScheduler({
      homeDirectory: this.dependencies.homeDirectory,
    });
  }

  async disable(): Promise<void> {
    const existing = await this.dependencies.inspectScheduler({
      homeDirectory: this.dependencies.homeDirectory,
    });
    if (existing.installed && !existing.managed) {
      throw new BackgroundRuntimeError(SCHEDULER_CONFLICT);
    }
    await this.dependencies.uninstallScheduler({
      homeDirectory: this.dependencies.homeDirectory,
    });
  }
}
