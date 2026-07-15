import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { ContextBundle } from './context-bundle.js';
import type {
  ResearchDriver,
  ResearchDriverInput,
} from './research-driver.js';
import {
  researchResultJsonSchema,
  researchResultSchema,
  type ResearchResult,
} from './result-contract.js';

export const CLAUDE_RESEARCH_TIMEOUT_MS = 30 * 60 * 1000;

const HELP_TIMEOUT_MS = 10_000;
const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const PROCESS_TERMINATION_SETTLE_MS = 250;
const REQUIRED_HELP_MARKERS = [
  '--print',
  '--safe-mode',
  '--no-session-persistence',
  '--permission-mode',
  '--tools',
  '--output-format',
  '--json-schema',
  '--max-budget-usd',
] as const;

const ERROR_MESSAGES = {
  invalid_claude_binary: 'Claude executable is not safely configured',
  invalid_driver_input: 'Research driver input is invalid',
  unsupported_claude_cli:
    'Claude CLI does not support the required restricted mode',
  claude_timeout: 'Claude research execution timed out',
  invalid_claude_json: 'Claude returned invalid JSON',
  invalid_research_result: 'Claude returned an invalid research result',
  claude_process_failed: 'Claude process failed',
} as const;

export type ClaudeDriverErrorCode = keyof typeof ERROR_MESSAGES;

export class ClaudeDriverError extends Error {
  constructor(readonly code: ClaudeDriverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ClaudeDriverError';
  }
}

export interface ProcessExecution {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ProcessExecutor {
  execute(execution: ProcessExecution): Promise<ProcessResult>;
}

interface FileMetadata {
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
}

export interface ClaudeDriverFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileMetadata>;
  lstat(path: string): Promise<FileMetadata>;
  access(path: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

export interface CreateClaudeResearchDriverOptions {
  environment?: NodeJS.ProcessEnv;
  executor?: ProcessExecutor;
  fileSystem?: ClaudeDriverFileSystem;
  maxProcessOutputBytes?: number;
}

const defaultFileSystem: ClaudeDriverFileSystem = {
  realpath,
  stat,
  lstat,
  access,
  mkdtemp,
  rm,
};

function createDefaultExecutor(maxOutputBytes: number): ProcessExecutor {
  return {
    async execute(execution) {
      return new Promise((resolve, reject) => {
        const child = spawn(execution.command, [...execution.args], {
          cwd: execution.cwd,
          detached: process.platform !== 'win32',
          env: execution.environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timedOut = false;
        let settled = false;
        let stdinComplete = false;
        let processFailure: Error | undefined;
        let closeResult: { exitCode: number } | undefined;
        let terminationWatchdog: NodeJS.Timeout | undefined;

        const finish = () => {
          if (
            settled
            || closeResult === undefined
            || (!stdinComplete && processFailure === undefined)
          ) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(terminationWatchdog);
          if (processFailure !== undefined) {
            reject(processFailure);
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: closeResult.exitCode,
            timedOut,
          });
        };

        const killProcessTree = () => {
          let killedProcessGroup = false;
          if (process.platform !== 'win32' && child.pid !== undefined) {
            try {
              process.kill(-child.pid, 'SIGKILL');
              killedProcessGroup = true;
            } catch {
              // Fall back to the direct child when no process group exists.
            }
          }
          if (!killedProcessGroup) {
            child.kill('SIGKILL');
          }
        };

        const terminate = (failureMessage?: string) => {
          if (
            failureMessage !== undefined
            && processFailure === undefined
            && !timedOut
          ) {
            processFailure = new Error(failureMessage);
          }
          killProcessTree();
          terminationWatchdog ??= setTimeout(() => {
            stdinComplete = true;
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            closeResult ??= { exitCode: 1 };
            finish();
          }, PROCESS_TERMINATION_SETTLE_MS);
          finish();
        };

        const stopForProcessFailure = (message: string) => {
          if (processFailure === undefined && !timedOut) {
            processFailure = new Error(message);
          }
          terminate();
        };

        const collect = (
          chunks: Buffer[],
          chunk: Buffer,
          currentBytes: number,
        ): number => {
          if (processFailure !== undefined) return currentBytes;
          const nextBytes = currentBytes + chunk.byteLength;
          if (nextBytes > maxOutputBytes) {
            stopForProcessFailure('Process output exceeded its byte limit');
            return currentBytes;
          }
          chunks.push(chunk);
          return nextBytes;
        };

        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, execution.timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes = collect(stdout, chunk, stdoutBytes);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes = collect(stderr, chunk, stderrBytes);
        });
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(terminationWatchdog);
          reject(error);
        });
        child.once('close', (exitCode) => {
          closeResult = { exitCode: exitCode ?? 1 };
          finish();
        });

        child.stdin.once('error', () => {
          stdinComplete = true;
          stopForProcessFailure('Process stdin write failed');
        });
        child.stdin.once('finish', () => {
          stdinComplete = true;
          finish();
        });
        child.stdin.once('close', () => {
          if (!stdinComplete) {
            stdinComplete = true;
            stopForProcessFailure('Process stdin closed before input');
          }
        });
        try {
          child.stdin.end(execution.input);
        } catch {
          stdinComplete = true;
          stopForProcessFailure('Process stdin write failed');
        }
      });
    },
  };
}

function allowedEnvironment(
  source: NodeJS.ProcessEnv,
  runDirectory: string,
  executable: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: runDirectory,
    TMPDIR: runDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: [
      dirname(process.execPath),
      dirname(executable),
      '/usr/bin',
      '/bin',
    ].join(delimiter),
  };
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ] as const) {
    if (source[name] !== undefined) {
      environment[name] = source[name];
    }
  }
  return environment;
}

function buildPrompt(context: ContextBundle): string {
  return [
    'You are executing a restricted read-only research task.',
    '',
    'Allowed context bundle:',
    JSON.stringify(context),
    '',
    'Research rules:',
    '- Use public sources only.',
    '- Do not log in or access authenticated content.',
    '- Do not send messages or communicate with third parties.',
    '- Do not change code or create files.',
    '- Do not change configuration or settings.',
    '- Do not create or modify calendar events.',
    '',
    'Output contract:',
    JSON.stringify(researchResultJsonSchema),
    'Return only the structured result required by the output contract.',
  ].join('\n');
}

function extractStructuredOutput(envelope: unknown): unknown {
  if (typeof envelope !== 'object' || envelope === null) {
    return envelope;
  }
  const record = envelope as Record<string, unknown>;
  if ('structured_output' in record) {
    return record.structured_output;
  }
  if ('result' in record) {
    const result = record.result;
    if (typeof result === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result);
      } catch {
        throw new ClaudeDriverError('invalid_claude_json');
      }
      return extractStructuredOutput(parsed);
    }
    if (typeof result === 'object' && result !== null) {
      const nested = result as Record<string, unknown>;
      return 'structured_output' in nested
        ? nested.structured_output
        : nested;
    }
  }
  return record;
}

function parseResult(stdout: string): ResearchResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new ClaudeDriverError('invalid_claude_json');
  }
  const result = researchResultSchema.safeParse(
    extractStructuredOutput(envelope),
  );
  if (!result.success) {
    throw new ClaudeDriverError('invalid_research_result');
  }
  return result.data;
}

function declaredOptions(help: string): Map<string, string> {
  const options = new Map<string, string>();
  const declaration = /^(\s*)(?:-[A-Za-z0-9](?:,\s*|\s+))?(--[A-Za-z0-9][A-Za-z0-9-]*)(?=$|[\s<[=])/;
  const inactive = /\b(?:deprecated|removed|documentation[-\s]+only)\b/i;
  let current: {
    option: string;
    indentation: number;
    lines: string[];
  } | undefined;
  let declarationIndentation: number | undefined;

  const saveCurrent = () => {
    if (current === undefined) {
      return;
    }
    const block = current.lines.join('\n');
    if (!inactive.test(block)) {
      options.set(current.option, block);
    }
    current = undefined;
  };

  for (const line of help.split(/\r?\n/)) {
    const indentation = /^\s*/.exec(line)?.[0].length ?? 0;
    if (
      current !== undefined
      && line.trim() !== ''
      && indentation > current.indentation
    ) {
      current.lines.push(line);
      continue;
    }
    const match = declaration.exec(line);
    const option = match?.[2];
    if (
      option !== undefined
      && (
        declarationIndentation === undefined
        || indentation === declarationIndentation
      )
    ) {
      saveCurrent();
      declarationIndentation ??= indentation;
      current = {
        option,
        indentation,
        lines: [line],
      };
      continue;
    }
    saveCurrent();
  }
  saveCurrent();
  return options;
}

function matchingDelimiterEnd(
  text: string,
  openerIndex: number,
): number | undefined {
  const delimiters: Record<string, string> = { '(': ')', '[': ']' };
  const stack: string[] = [];
  let quote: '"' | "'" | '`' | undefined;
  for (let index = openerIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      break;
    }
    if (quote !== undefined) {
      if (character === quote && text[index - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character in delimiters) {
      stack.push(character);
      continue;
    }
    const opener = stack.at(-1);
    if (opener !== undefined && character === delimiters[opener]) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function containingDelimiterStart(
  text: string,
  targetIndex: number,
): number | undefined {
  const delimiters: Record<string, string> = { ')': '(', ']': '[' };
  const stack: number[] = [];
  let quote: '"' | "'" | '`' | undefined;
  for (let index = 0; index < targetIndex; index += 1) {
    const character = text[index];
    if (character === undefined) {
      break;
    }
    if (quote !== undefined) {
      if (character === quote && text[index - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[') {
      stack.push(index);
      continue;
    }
    const openerIndex = stack.at(-1);
    if (
      openerIndex !== undefined
      && character in delimiters
      && text[openerIndex] === delimiters[character]
    ) {
      stack.pop();
    }
  }
  return stack.at(-1);
}

function tokenizeAllowedValues(list: string): string[] {
  const values: string[] = [];
  const token = /"([A-Za-z0-9][A-Za-z0-9_-]*)"|'([A-Za-z0-9][A-Za-z0-9_-]*)'|`([A-Za-z0-9][A-Za-z0-9_-]*)`|([A-Za-z0-9][A-Za-z0-9_-]*)/y;
  let index = 0;
  while (index < list.length) {
    index += /^\s*/.exec(list.slice(index))?.[0].length ?? 0;
    token.lastIndex = index;
    const match = token.exec(list);
    if (match === null) {
      return [];
    }
    values.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    index = token.lastIndex;
    index += /^\s*/.exec(list.slice(index))?.[0].length ?? 0;
    if (index === list.length) {
      return values;
    }
    if (list[index] !== ',' && list[index] !== '|') {
      return [];
    }
    index += 1;
  }
  return [];
}

function firstAllowedValues(declaration: string): string[] {
  const label = /\b(?:choices?|allowed[-\s]+values?)\s*:\s*/i;
  const match = label.exec(declaration);
  if (match === null) {
    return [];
  }
  const openerIndex = containingDelimiterStart(declaration, match.index);
  if (openerIndex === undefined) {
    return [];
  }
  const closerIndex = matchingDelimiterEnd(declaration, openerIndex);
  if (closerIndex === undefined || closerIndex < match.index) {
    return [];
  }
  return tokenizeAllowedValues(
    declaration.slice(match.index + match[0].length, closerIndex),
  );
}

function isCompatibleHelp(help: string): boolean {
  const options = declaredOptions(help);
  const permissionMode = options.get('--permission-mode');
  const allowsDontAsk = permissionMode !== undefined
    && firstAllowedValues(permissionMode).includes('dontAsk');
  return REQUIRED_HELP_MARKERS.every((marker) => options.has(marker))
    && allowsDontAsk;
}

async function resolveExecutable(
  environment: NodeJS.ProcessEnv,
  fileSystem: ClaudeDriverFileSystem,
): Promise<{ path: string; dev: number; ino: number }> {
  const configured = environment.ATL_CLAUDE_BIN;
  if (configured === undefined || !isAbsolute(configured)) {
    throw new ClaudeDriverError('invalid_claude_binary');
  }
  try {
    const executable = await fileSystem.realpath(configured);
    const [metadata, referencedMetadata] = await Promise.all([
      fileSystem.stat(executable),
      fileSystem.lstat(executable),
    ]);
    if (
      !isAbsolute(executable)
      || !metadata.isFile()
      || !referencedMetadata.isFile()
      || metadata.dev !== referencedMetadata.dev
      || metadata.ino !== referencedMetadata.ino
    ) {
      throw new Error('Unsafe executable');
    }
    await fileSystem.access(executable, constants.X_OK);
    return { path: executable, dev: metadata.dev, ino: metadata.ino };
  } catch {
    throw new ClaudeDriverError('invalid_claude_binary');
  }
}

async function verifyExecutable(
  executable: { path: string; dev: number; ino: number },
  fileSystem: ClaudeDriverFileSystem,
): Promise<void> {
  try {
    const canonical = await fileSystem.realpath(executable.path);
    const [metadata, referencedMetadata] = await Promise.all([
      fileSystem.stat(executable.path),
      fileSystem.lstat(executable.path),
    ]);
    if (
      canonical !== executable.path
      || !isAbsolute(canonical)
      || !metadata.isFile()
      || !referencedMetadata.isFile()
      || metadata.dev !== executable.dev
      || metadata.ino !== executable.ino
      || referencedMetadata.dev !== executable.dev
      || referencedMetadata.ino !== executable.ino
    ) {
      throw new Error('Executable identity changed');
    }
    await fileSystem.access(executable.path, constants.X_OK);
  } catch {
    throw new ClaudeDriverError('invalid_claude_binary');
  }
}

class ClaudeResearchDriver implements ResearchDriver {
  readonly name = 'claude-code';

  constructor(
    private readonly executable: { path: string; dev: number; ino: number },
    private readonly environment: NodeJS.ProcessEnv,
    private readonly executor: ProcessExecutor,
    private readonly fileSystem: ClaudeDriverFileSystem,
  ) {}

  async execute(input: ResearchDriverInput): Promise<ResearchResult> {
    if (
      input.task.taskId !== input.context.taskId
      || !Number.isFinite(input.timeoutMs)
      || input.timeoutMs <= 0
    ) {
      throw new ClaudeDriverError('invalid_driver_input');
    }
    const runDirectory = await this.fileSystem.mkdtemp(
      join(tmpdir(), 'atl-claude-'),
    );
    const environment = allowedEnvironment(
      this.environment,
      runDirectory,
      this.executable.path,
    );
    let outcome:
      | { success: true; value: ResearchResult }
      | { success: false; error: unknown };
    try {
      outcome = {
        success: true,
        value: await this.executeInDirectory(input, runDirectory, environment),
      };
    } catch (error) {
      outcome = { success: false, error };
    }
    let cleanupFailed = false;
    try {
      await this.fileSystem.rm(runDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    if (!outcome.success) {
      throw outcome.error;
    }
    if (cleanupFailed) {
      throw new ClaudeDriverError('claude_process_failed');
    }
    return outcome.value;
  }

  private async executeInDirectory(
    input: ResearchDriverInput,
    runDirectory: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<ResearchResult> {
    await verifyExecutable(this.executable, this.fileSystem);
    let help: ProcessResult;
    try {
      help = await this.executor.execute({
        command: this.executable.path,
        args: ['--help'],
        cwd: runDirectory,
        environment,
        timeoutMs: HELP_TIMEOUT_MS,
      });
    } catch {
      throw new ClaudeDriverError('unsupported_claude_cli');
    }
    if (
      help.timedOut
      || help.exitCode !== 0
      || !isCompatibleHelp(help.stdout)
    ) {
      throw new ClaudeDriverError('unsupported_claude_cli');
    }

    const args = [
      '--print',
      '--safe-mode',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'WebSearch,WebFetch,Read',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(researchResultJsonSchema),
      '--max-budget-usd',
      '2',
    ];
    if (declaredOptions(help.stdout).has('--strict-mcp-config')) {
      args.push('--strict-mcp-config');
    }

    await verifyExecutable(this.executable, this.fileSystem);
    let result: ProcessResult;
    try {
      result = await this.executor.execute({
        command: this.executable.path,
        args,
        cwd: runDirectory,
        environment,
        input: buildPrompt(input.context),
        timeoutMs: Math.min(
          input.timeoutMs,
          CLAUDE_RESEARCH_TIMEOUT_MS,
        ),
      });
    } catch {
      throw new ClaudeDriverError('claude_process_failed');
    }
    if (result.timedOut) {
      throw new ClaudeDriverError('claude_timeout');
    }
    if (result.exitCode !== 0) {
      throw new ClaudeDriverError('claude_process_failed');
    }
    return parseResult(result.stdout);
  }
}

export async function createClaudeResearchDriver(
  options: CreateClaudeResearchDriverOptions = {},
): Promise<ResearchDriver> {
  const environment = options.environment ?? process.env;
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const executable = await resolveExecutable(environment, fileSystem);
  const maxProcessOutputBytes = options.maxProcessOutputBytes
    ?? DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES;
  if (
    !Number.isSafeInteger(maxProcessOutputBytes)
    || maxProcessOutputBytes <= 0
  ) {
    throw new ClaudeDriverError('invalid_driver_input');
  }
  return new ClaudeResearchDriver(
    executable,
    environment,
    options.executor ?? createDefaultExecutor(maxProcessOutputBytes),
    fileSystem,
  );
}
