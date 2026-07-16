import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import fastGlob from 'fast-glob';

export type RuntimeHealthState = 'healthy' | 'missing' | 'invalid' | 'logged_out';
export type RuntimeCheckReason =
  | 'missing'
  | 'not_executable'
  | 'unsupported_version'
  | 'command_failed'
  | 'invalid_response';

export type FileCheck = {
  ok: true;
  path: string;
} | {
  ok: false;
  path: null;
  reason: RuntimeCheckReason;
};

export type ExecutableCheck = FileCheck & { majorVersion?: number };
export type ClaudeCheck = FileCheck & { loggedIn: boolean };

export interface RuntimeDetectionResult {
  state: RuntimeHealthState;
  platformSupported: boolean;
  node: ExecutableCheck;
  claude: ClaudeCheck;
  runner: FileCheck;
}

export interface RuntimeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeCommandExecutor {
  execute(command: string, args: readonly string[]): Promise<RuntimeCommandResult>;
}

export type RuntimeCandidateFinder = (
  kind: 'node' | 'claude',
  homeDirectory: string,
) => Promise<string[]>;

export interface DetectRuntimeOptions {
  savedNodePath?: string;
  savedClaudePath?: string;
  runnerPath: string;
  homeDirectory: string;
  platform?: NodeJS.Platform;
  commands?: RuntimeCommandExecutor;
  candidateFinder?: RuntimeCandidateFinder;
}

const defaultCommands: RuntimeCommandExecutor = {
  async execute(command, args) {
    const result = await execa(command, [...args], {
      reject: false,
      timeout: 10_000,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };
  },
};

const relativeCandidates: Record<'node' | 'claude', string[]> = {
  node: [
    '.nvm/versions/node/*/bin/node',
    '.fnm/node-versions/*/installation/bin/node',
    '.volta/bin/node',
    'Tools/node/*/bin/node',
  ],
  claude: [
    '.nvm/versions/node/*/bin/claude',
    '.fnm/node-versions/*/installation/bin/claude',
    '.volta/bin/claude',
    '.local/bin/claude',
    '.claude/local/claude',
    'Tools/node/*/bin/claude',
  ],
};

const fixedCandidates: Record<'node' | 'claude', string[]> = {
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node'],
  claude: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
};

const defaultCandidateFinder: RuntimeCandidateFinder = async (kind, homeDirectory) => {
  const matches = await fastGlob(relativeCandidates[kind], {
    absolute: true,
    cwd: homeDirectory,
    onlyFiles: true,
    suppressErrors: true,
  });
  return [...fixedCandidates[kind], ...matches.sort().reverse()];
};

function failed(reason: RuntimeCheckReason): FileCheck {
  return { ok: false, path: null, reason };
}

async function safeFile(path: string, executable: boolean): Promise<string | null> {
  if (path.trim() === '') return null;
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) return null;
    if (executable) await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

async function candidates(
  kind: 'node' | 'claude',
  savedPath: string | undefined,
  options: Required<Pick<DetectRuntimeOptions, 'homeDirectory'>> & {
    commands: RuntimeCommandExecutor;
    candidateFinder: RuntimeCandidateFinder;
  },
): Promise<string[]> {
  const values: string[] = [];
  if (savedPath !== undefined && savedPath.trim() !== '') values.push(savedPath);
  const which = await options.commands.execute('/usr/bin/which', [kind]);
  if (which.exitCode === 0 && which.stdout.trim() !== '') {
    values.push(which.stdout.trim().split('\n')[0] ?? '');
  }
  values.push(...await options.candidateFinder(kind, options.homeDirectory));
  return [...new Set(values.filter((value) => value !== ''))];
}

async function firstExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    const canonical = await safeFile(path, true);
    if (canonical !== null) return canonical;
  }
  return null;
}

function emptyResult(platformSupported: boolean): RuntimeDetectionResult {
  return {
    state: platformSupported ? 'missing' : 'invalid',
    platformSupported,
    node: failed('missing'),
    claude: { ...failed('missing'), loggedIn: false },
    runner: failed('missing'),
  };
}

export async function detectRuntime(
  options: DetectRuntimeOptions,
): Promise<RuntimeDetectionResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return emptyResult(false);

  const commands = options.commands ?? defaultCommands;
  const candidateFinder = options.candidateFinder ?? defaultCandidateFinder;
  const runnerPath = await safeFile(options.runnerPath, false);
  const nodePath = await firstExecutable(await candidates('node', options.savedNodePath, {
    homeDirectory: options.homeDirectory,
    commands,
    candidateFinder,
  }));
  if (nodePath === null) {
    return {
      ...emptyResult(true),
      runner: runnerPath === null ? failed('missing') : { ok: true, path: runnerPath },
    };
  }

  const nodeVersion = await commands.execute(nodePath, ['--version']);
  const versionMatch = /^v(\d+)\./.exec(nodeVersion.stdout.trim());
  const majorVersion = versionMatch === null ? null : Number(versionMatch[1]);
  if (nodeVersion.exitCode !== 0 || majorVersion === null) {
    return {
      ...emptyResult(true),
      state: 'invalid',
      node: { ...failed('command_failed') },
      runner: runnerPath === null ? failed('missing') : { ok: true, path: runnerPath },
    };
  }
  if (majorVersion < 24) {
    return {
      ...emptyResult(true),
      state: 'invalid',
      node: { ...failed('unsupported_version'), majorVersion },
      runner: runnerPath === null ? failed('missing') : { ok: true, path: runnerPath },
    };
  }

  const claudePath = await firstExecutable(await candidates(
    'claude',
    options.savedClaudePath,
    { homeDirectory: options.homeDirectory, commands, candidateFinder },
  ));
  if (claudePath === null) {
    return {
      ...emptyResult(true),
      node: { ok: true, path: nodePath, majorVersion },
      runner: runnerPath === null ? failed('missing') : { ok: true, path: runnerPath },
    };
  }

  const auth = await commands.execute(claudePath, ['auth', 'status']);
  let loggedIn = false;
  if (auth.exitCode === 0) {
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown };
      loggedIn = parsed.loggedIn === true;
    } catch {
      return {
        state: 'invalid',
        platformSupported: true,
        node: { ok: true, path: nodePath, majorVersion },
        claude: { ...failed('invalid_response'), loggedIn: false },
        runner: runnerPath === null ? failed('missing') : { ok: true, path: runnerPath },
      };
    }
  }

  const runner = runnerPath === null ? failed('missing') : { ok: true as const, path: runnerPath };
  const claude = loggedIn
    ? { ok: true as const, path: claudePath, loggedIn: true }
    : { ...failed(auth.exitCode === 0 ? 'command_failed' : 'command_failed'), loggedIn: false };
  return {
    state: runner.ok ? (loggedIn ? 'healthy' : 'logged_out') : 'missing',
    platformSupported: true,
    node: { ok: true, path: nodePath, majorVersion },
    claude,
    runner,
  };
}
