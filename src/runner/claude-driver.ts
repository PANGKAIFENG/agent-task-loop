import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { Task } from '../domain/task.js';
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
  isFile(): boolean;
}

export interface ClaudeDriverFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileMetadata>;
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
}

const defaultFileSystem: ClaudeDriverFileSystem = {
  realpath,
  stat,
  access,
  mkdtemp,
  rm,
};

const defaultExecutor: ProcessExecutor = {
  async execute(execution) {
    return new Promise((resolve, reject) => {
      const child = spawn(execution.command, [...execution.args], {
        cwd: execution.cwd,
        env: execution.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, execution.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? 1,
          timedOut,
        });
      });

      child.stdin.end(execution.input);
    });
  },
};

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

function buildPrompt(task: Task, context: ContextBundle): string {
  return [
    'You are executing a restricted read-only research task.',
    '',
    'Task objective:',
    task.objective ?? '',
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
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
  const declaration = /^\s*(?:-[A-Za-z0-9](?:,\s*|\s+))?(--[A-Za-z0-9][A-Za-z0-9-]*)(?=$|[\s<[=])/;
  const inactive = /\b(?:deprecated|removed|documentation[-\s]+only)\b/i;
  for (const line of help.split(/\r?\n/)) {
    const match = declaration.exec(line);
    const option = match?.[1];
    if (option !== undefined && !inactive.test(line)) {
      options.set(option, line);
    }
  }
  return options;
}

function firstAllowedValues(declaration: string): string[] {
  const label = /\b(?:choices?|allowed[-\s]+values?)\s*:\s*/i;
  const match = label.exec(declaration);
  if (match === null) {
    return [];
  }
  const remainder = declaration.slice(match.index + match[0].length);
  const nextBoundary = remainder.search(
    /[)\];]|\b(?:choices?|allowed[-\s]+values?)\s*:/i,
  );
  const list = nextBoundary === -1
    ? remainder
    : remainder.slice(0, nextBoundary);
  return list
    .split(/[\s,|]+/)
    .map((value) => value.replace(/^["'`]+|["'`]+$/g, ''))
    .filter((value) => value !== '');
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
): Promise<string> {
  const configured = environment.ATL_CLAUDE_BIN;
  if (configured === undefined || !isAbsolute(configured)) {
    throw new ClaudeDriverError('invalid_claude_binary');
  }
  try {
    const executable = await fileSystem.realpath(configured);
    const metadata = await fileSystem.stat(executable);
    if (!isAbsolute(executable) || !metadata.isFile()) {
      throw new Error('Unsafe executable');
    }
    await fileSystem.access(executable, constants.X_OK);
    return executable;
  } catch {
    throw new ClaudeDriverError('invalid_claude_binary');
  }
}

class ClaudeResearchDriver implements ResearchDriver {
  readonly name = 'claude-code';

  constructor(
    private readonly executable: string,
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
      this.executable,
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
    let help: ProcessResult;
    try {
      help = await this.executor.execute({
        command: this.executable,
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

    let result: ProcessResult;
    try {
      result = await this.executor.execute({
        command: this.executable,
        args,
        cwd: runDirectory,
        environment,
        input: buildPrompt(input.task, input.context),
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
  return new ClaudeResearchDriver(
    executable,
    environment,
    options.executor ?? defaultExecutor,
    fileSystem,
  );
}
