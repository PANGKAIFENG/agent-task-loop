import { constants } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  CLAUDE_RESEARCH_TIMEOUT_MS,
  ClaudeDriverError,
  createClaudeResearchDriver,
  type ClaudeDriverFileSystem,
  type ProcessExecution,
  type ProcessExecutor,
  type ProcessResult,
} from '../../../src/runner/claude-driver.js';
import type { ContextBundle } from '../../../src/runner/context-bundle.js';
import { researchResultJsonSchema } from '../../../src/runner/result-contract.js';

const NOW = '2026-07-15T00:00:00.000Z';
const CLAUDE_BIN = '/opt/testing/bin/claude';
const RUN_DIRECTORY = '/tmp/atl-claude-test/run-001';
const CLAUDE_CONFIG_DIR = '/Users/synthetic/.claude-atl';
const CLAUDE_MODEL = 'glm-4-flash';
const REQUIRED_HELP = [
  '--print',
  '--safe-mode',
  '--no-session-persistence',
  '--permission-mode <mode> (choices: dontAsk)',
  '--tools <tools>',
  '--output-format <format>',
  '--json-schema <schema>',
  '--max-budget-usd <amount>',
].join('\n');

const validResult = {
  summary: 'The public documentation supports the finding.',
  findings: ['The documented limit is 100 requests per minute.'],
  evidence: [{
    title: 'Official limits',
    url: 'https://example.com/docs/limits',
    accessedAt: NOW,
  }],
  uncertainties: ['Enterprise limits are not published.'],
  recommendedActions: ['Confirm enterprise limits with the vendor.'],
  acceptance: [{
    criterion: 'Cite an official source.',
    status: 'met' as const,
    note: 'The official limits page is cited.',
  }],
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-driver-001',
    title: 'TITLE_SENTINEL_MUST_NOT_ENTER_PROMPT',
    body: 'BODY_SENTINEL_MUST_NOT_ENTER_PROMPT',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-driver',
    taskType: 'research',
    objective: 'Compare the documented public product limits.',
    acceptanceCriteria: ['Cite an official source.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: 'SOURCE_QUOTE_SENTINEL_MUST_NOT_ENTER_PROMPT',
    sourceKey: 'synthetic:driver-001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-driver-001',
      agent: 'claude-research',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-15T00:30:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeContext(): ContextBundle {
  return {
    taskId: 'task-driver-001',
    blocks: [
      {
        label: 'task',
        kind: 'task',
        content: [
          'Objective:',
          'Compare the documented public product limits.',
          '',
          'Acceptance Criteria:',
          '- Cite an official source.',
        ].join('\n'),
        sha256: 'a'.repeat(64),
      },
      {
        label: 'project',
        kind: 'project',
        content: 'Only use the official public documentation.',
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    ...overrides,
  };
}

function fakeFileSystem(
  overrides: Partial<ClaudeDriverFileSystem> = {},
): ClaudeDriverFileSystem {
  const metadata = () => ({
    dev: 41,
    ino: 73,
    isFile: () => true,
  });
  return {
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => metadata()),
    lstat: vi.fn(async () => metadata()),
    access: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async () => RUN_DIRECTORY),
    rm: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeExecutor(
  implementation: (execution: ProcessExecution) => Promise<ProcessResult>,
): ProcessExecutor {
  return { execute: vi.fn(implementation) };
}

async function createDriver(options: {
  executor?: ProcessExecutor;
  fileSystem?: ClaudeDriverFileSystem;
  environment?: NodeJS.ProcessEnv;
  maxProcessOutputBytes?: number;
} = {}) {
  return createClaudeResearchDriver({
    executor: options.executor ?? fakeExecutor(async (execution) => {
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    }),
    fileSystem: options.fileSystem ?? fakeFileSystem(),
    environment: options.environment ?? { ATL_CLAUDE_BIN: CLAUDE_BIN },
    ...(options.maxProcessOutputBytes === undefined
      ? {}
      : { maxProcessOutputBytes: options.maxProcessOutputBytes }),
  });
}

async function createTestExecutable(source: string): Promise<{
  executable: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'atl-claude-executable-'));
  const executable = join(directory, 'claude-test.mjs');
  await writeFile(executable, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(executable, 0o700);
  return {
    executable,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

function floodingExecutableSource(
  phase: 'help' | 'execution',
  stream: 'stdout' | 'stderr',
): string {
  const validEnvelope = JSON.stringify({ structured_output: validResult });
  return [
    `const help = ${JSON.stringify(REQUIRED_HELP)};`,
    `const validEnvelope = ${JSON.stringify(validEnvelope)};`,
    `const phase = ${JSON.stringify(phase)};`,
    `const stream = ${JSON.stringify(stream)};`,
    'const isHelp = process.argv.includes("--help");',
    'if (isHelp) {',
    '  process.stdout.write(help);',
    '  if (phase === "help") process[stream].write("x".repeat(2048));',
    '} else {',
    '  if (phase === "execution") process[stream].write("x".repeat(2048));',
    '  if (stream !== "stdout") process.stdout.write(validEnvelope);',
    '}',
  ].join('\n');
}

function inheritedPipeExecutableSource(
  mode: 'timeout' | 'overflow' | 'watchdog',
): string {
  return [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    `const help = ${JSON.stringify(REQUIRED_HELP)};`,
    `const mode = ${JSON.stringify(mode)};`,
    'if (process.argv.includes("--help")) {',
    '  process.stdout.write(help);',
    '} else {',
    '  const grandchildOptions = { stdio: ["ignore", "inherit", "inherit"] };',
    '  if (mode === "watchdog") grandchildOptions.detached = true;',
    '  const grandchild = spawn(process.execPath, [',
    '    "-e",',
    '    "setTimeout(() => {}, 2000)",',
    '  ], grandchildOptions);',
    '  const pidPath = fileURLToPath(new URL("./grandchild.pid", import.meta.url));',
    '  writeFileSync(pidPath, String(grandchild.pid));',
    '  if (mode === "overflow") process.stdout.write("x".repeat(2048));',
    '  setInterval(() => {}, 1000);',
    '}',
  ].join('\n');
}

async function expectProcessGone(pidPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, 'utf8'));
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await delay(20);
  }
  throw new Error('Grandchild process survived driver termination');
}

async function terminateTestProcess(pidPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, 'utf8'));
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await expectProcessGone(pidPath);
}

describe('createClaudeResearchDriver', () => {
  it('resolves an absolute regular executable at startup', async () => {
    const fileSystem = fakeFileSystem({
      realpath: vi.fn(async () => '/private/opt/testing/bin/claude'),
    });

    const driver = await createDriver({ fileSystem });

    expect(driver.name).toBe('claude-code');
    expect(fileSystem.realpath).toHaveBeenCalledWith(CLAUDE_BIN);
    expect(fileSystem.stat).toHaveBeenCalledWith('/private/opt/testing/bin/claude');
    expect(fileSystem.lstat).toHaveBeenCalledWith(
      '/private/opt/testing/bin/claude',
    );
    expect(fileSystem.access).toHaveBeenCalledWith(
      '/private/opt/testing/bin/claude',
      constants.X_OK,
    );
  });

  it.each([
    ['missing setting', {}],
    ['relative path', { ATL_CLAUDE_BIN: 'claude' }],
  ])('rejects a %s with a sanitized typed error', async (_label, environment) => {
    await expect(createDriver({ environment })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'invalid_claude_binary',
      message: 'Claude executable is not safely configured',
    });
  });

  it('rejects a missing, non-regular, or non-executable binary', async () => {
    const missing = fakeFileSystem({
      realpath: vi.fn(async () => {
        throw new Error(`ENOENT: ${CLAUDE_BIN}`);
      }),
    });
    const nonRegular = fakeFileSystem({
      stat: vi.fn(async () => ({
        dev: 41,
        ino: 73,
        isFile: () => false,
      })),
    });
    const nonExecutable = fakeFileSystem({
      access: vi.fn(async () => {
        throw new Error(`EACCES: ${CLAUDE_BIN}`);
      }),
    });

    for (const fileSystem of [missing, nonRegular, nonExecutable]) {
      await expect(createDriver({ fileSystem })).rejects.toMatchObject({
        code: 'invalid_claude_binary',
        message: 'Claude executable is not safely configured',
      });
    }
  });
});

describe('ClaudeResearchDriver.execute', () => {
  it('enforces a hard timeout across descendants that inherit stdio', async () => {
    const fixture = await createTestExecutable(
      inheritedPipeExecutableSource('timeout'),
    );
    const pidPath = join(dirname(fixture.executable), 'grandchild.pid');
    try {
      const driver = await createClaudeResearchDriver({
        environment: { ATL_CLAUDE_BIN: fixture.executable },
      });
      const startedAt = Date.now();

      await expect(driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: 250,
      })).rejects.toMatchObject({
        name: 'ClaudeDriverError',
        code: 'claude_timeout',
      });

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await expectProcessGone(pidPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it('terminates the process group when output exceeds its limit', async () => {
    const fixture = await createTestExecutable(
      inheritedPipeExecutableSource('overflow'),
    );
    const pidPath = join(dirname(fixture.executable), 'grandchild.pid');
    try {
      const driver = await createClaudeResearchDriver({
        environment: { ATL_CLAUDE_BIN: fixture.executable },
        maxProcessOutputBytes: 512,
      });
      const startedAt = Date.now();

      await expect(driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
      })).rejects.toMatchObject({
        name: 'ClaudeDriverError',
        code: 'claude_process_failed',
      });

      expect(Date.now() - startedAt).toBeLessThan(1_200);
      await expectProcessGone(pidPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it('settles timeout when a process outside the group keeps pipes open', async () => {
    const fixture = await createTestExecutable(
      inheritedPipeExecutableSource('watchdog'),
    );
    const pidPath = join(dirname(fixture.executable), 'grandchild.pid');
    try {
      const driver = await createClaudeResearchDriver({
        environment: { ATL_CLAUDE_BIN: fixture.executable },
      });
      const startedAt = Date.now();

      await expect(driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: 500,
      })).rejects.toMatchObject({
        name: 'ClaudeDriverError',
        code: 'claude_timeout',
      });

      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await terminateTestProcess(pidPath);
      await fixture.cleanup();
    }
  });

  it.each(['stdout', 'stderr'] as const)(
    'caps help %s and maps overflow to unsupported_claude_cli',
    async (stream) => {
      const fixture = await createTestExecutable(
        floodingExecutableSource('help', stream),
      );
      try {
        const driver = await createClaudeResearchDriver({
          environment: { ATL_CLAUDE_BIN: fixture.executable },
          maxProcessOutputBytes: 512,
        });

        await expect(driver.execute({
          task: makeTask(),
          context: makeContext(),
          timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
        })).rejects.toMatchObject({
          name: 'ClaudeDriverError',
          code: 'unsupported_claude_cli',
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(['stdout', 'stderr'] as const)(
    'caps execution %s and maps overflow to claude_process_failed',
    async (stream) => {
      const fixture = await createTestExecutable(
        floodingExecutableSource('execution', stream),
      );
      try {
        const driver = await createClaudeResearchDriver({
          environment: { ATL_CLAUDE_BIN: fixture.executable },
          maxProcessOutputBytes: 512,
        });

        await expect(driver.execute({
          task: makeTask(),
          context: makeContext(),
          timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
        })).rejects.toMatchObject({
          name: 'ClaudeDriverError',
          code: 'claude_process_failed',
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('maps an early child exit during stdin write to claude_process_failed', async () => {
    const fixture = await createTestExecutable([
      `const help = ${JSON.stringify(REQUIRED_HELP)};`,
      'if (process.argv.includes("--help")) {',
      '  process.stdout.write(help);',
      '} else {',
      '  process.exit(0);',
      '}',
    ].join('\n'));
    try {
      const driver = await createClaudeResearchDriver({
        environment: { ATL_CLAUDE_BIN: fixture.executable },
      });

      await expect(driver.execute({
        task: makeTask(),
        context: {
          taskId: 'task-driver-001',
          blocks: [{
            label: 'task',
            kind: 'task',
            content: 'x'.repeat(2 * 1024 * 1024),
            sha256: 'd'.repeat(64),
          }],
        },
        timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
      })).rejects.toMatchObject({
        name: 'ClaudeDriverError',
        code: 'claude_process_failed',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('revalidates the executable identity immediately before help', async () => {
    let ino = 73;
    const metadata = () => ({ dev: 41, ino, isFile: () => true });
    const fileSystem = fakeFileSystem({
      stat: vi.fn(async () => metadata()),
      lstat: vi.fn(async () => metadata()),
    });
    const executor = fakeExecutor(async () => processResult({
      stdout: REQUIRED_HELP,
    }));
    const driver = await createDriver({ executor, fileSystem });
    ino = 74;

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'invalid_claude_binary',
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the executable is replaced after help', async () => {
    let ino = 73;
    const metadata = () => ({ dev: 41, ino, isFile: () => true });
    const fileSystem = fakeFileSystem({
      stat: vi.fn(async () => metadata()),
      lstat: vi.fn(async () => metadata()),
    });
    const calls: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        ino = 74;
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor, fileSystem });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'invalid_claude_binary',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('rejects a cross-task context bundle before creating a run directory', async () => {
    const executor = fakeExecutor(async () => processResult());
    const fileSystem = fakeFileSystem();
    const driver = await createDriver({ executor, fileSystem });

    await expect(driver.execute({
      task: makeTask(),
      context: { ...makeContext(), taskId: 'task-other' },
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'invalid_driver_input',
      message: 'Research driver input is invalid',
    });
    expect(fileSystem.mkdtemp).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s before creating a run directory',
    async (timeoutMs) => {
      const executor = fakeExecutor(async () => processResult());
      const fileSystem = fakeFileSystem();
      const driver = await createDriver({ executor, fileSystem });

      await expect(driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs,
      })).rejects.toMatchObject({
        name: 'ClaudeDriverError',
        code: 'invalid_driver_input',
        message: 'Research driver input is invalid',
      });
      expect(fileSystem.mkdtemp).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );

  it('uses the exact restricted command, isolated cwd, minimal env, and safe prompt', async () => {
    const executions: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      executions.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const fileSystem = fakeFileSystem();
    const environment = {
      ATL_CLAUDE_BIN: CLAUDE_BIN,
      ATL_ENV_SENTINEL: 'ENV_SENTINEL_MUST_NOT_ENTER_PROMPT_OR_CHILD',
      ANTHROPIC_API_KEY: 'synthetic-api-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      ATL_CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_DIR,
      ATL_CLAUDE_MODEL: CLAUDE_MODEL,
      HOME: '/Users/synthetic',
      PATH: '/untrusted/launchd/path',
    };
    const driver = await createDriver({ executor, fileSystem, environment });

    const result = await driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    });

    expect(result).toEqual(validResult);
    expect(executions).toHaveLength(2);
    expect(executions[0]).toMatchObject({
      command: CLAUDE_BIN,
      args: ['--help'],
      cwd: RUN_DIRECTORY,
    });
    expect(executions[0]?.input).toBeUndefined();
    const execution = executions[1];
    expect(execution).toBeDefined();
    expect(execution?.command).toBe(CLAUDE_BIN);
    expect(execution?.args).toEqual([
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
      JSON.stringify(Object.fromEntries(
        Object.entries(researchResultJsonSchema)
          .filter(([key]) => key !== '$schema'),
      )),
      '--max-budget-usd',
      '2',
      '--model',
      CLAUDE_MODEL,
    ]);
    expect(execution?.cwd).toBe(RUN_DIRECTORY);
    expect(execution?.timeoutMs).toBe(CLAUDE_RESEARCH_TIMEOUT_MS);
    expect(execution?.environment).toEqual({
      HOME: RUN_DIRECTORY,
      TMPDIR: RUN_DIRECTORY,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: [
        dirname(process.execPath),
        dirname(CLAUDE_BIN),
        '/usr/bin',
        '/bin',
      ].join(':'),
      ANTHROPIC_API_KEY: 'synthetic-api-key',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      CLAUDE_CONFIG_DIR,
    });

    const prompt = execution?.input ?? '';
    expect(prompt).toContain('Compare the documented public product limits.');
    expect(prompt).toContain('Cite an official source.');
    expect(prompt).toContain('Only use the official public documentation.');
    expect(prompt).toContain('public sources only');
    expect(prompt).toContain('Do not log in');
    expect(prompt).toContain('Do not send messages');
    expect(prompt).toContain('Do not change code');
    expect(prompt).toContain('Do not change configuration');
    expect(prompt).toContain('Do not create or modify calendar events');
    expect(prompt).toContain('Output contract');
    expect(prompt).not.toContain('TITLE_SENTINEL_MUST_NOT_ENTER_PROMPT');
    expect(prompt).not.toContain('BODY_SENTINEL_MUST_NOT_ENTER_PROMPT');
    expect(prompt).not.toContain('SOURCE_QUOTE_SENTINEL_MUST_NOT_ENTER_PROMPT');
    expect(prompt).not.toContain('ENV_SENTINEL_MUST_NOT_ENTER_PROMPT_OR_CHILD');
    expect(execution?.environment.HOME).not.toBe('/Users/synthetic');
    expect(prompt).not.toContain('/Users/synthetic');
    expect(JSON.stringify(execution)).toContain(CLAUDE_CONFIG_DIR);
    expect(execution?.args.join(' ')).not.toMatch(
      /Bash|Edit|Write|NotebookEdit|dangerously-skip-permissions|ClawVault/,
    );
    expect(fileSystem.mkdtemp).toHaveBeenCalledOnce();
    expect(fileSystem.rm).toHaveBeenCalledWith(RUN_DIRECTORY, {
      recursive: true,
      force: true,
    });
  });

  it('builds stdin only from the already-redacted context bundle', async () => {
    const rawObjectiveToken = 'sk-objective-provider-token-123456';
    const rawCriterionToken = 'ghp_123456789012345678901234567890';
    const executions: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      executions.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await driver.execute({
      task: makeTask({
        objective: `Research ${rawObjectiveToken}`,
        acceptanceCriteria: [`Do not expose ${rawCriterionToken}`],
      }),
      context: {
        taskId: 'task-driver-001',
        blocks: [{
          label: 'task',
          kind: 'task',
          content: [
            'Objective:',
            'Research [REDACTED]',
            '',
            'Acceptance Criteria:',
            '- Do not expose [REDACTED]',
          ].join('\n'),
          sha256: 'c'.repeat(64),
        }],
      },
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    });

    const prompt = executions[1]?.input ?? '';
    expect(prompt).toContain('Research [REDACTED]');
    expect(prompt).toContain('Do not expose [REDACTED]');
    expect(prompt).not.toContain(rawObjectiveToken);
    expect(prompt).not.toContain(rawCriterionToken);
  });

  it.each([
    ['structured output', { structured_output: validResult }],
    ['nested structured output', { result: { structured_output: validResult } }],
    ['object result', { result: validResult }],
    ['JSON string result', { result: JSON.stringify(validResult) }],
    ['JSON string structured output', {
      result: JSON.stringify({ structured_output: validResult }),
    }],
    ['direct result', validResult],
  ])('extracts and validates %s from the Claude JSON envelope', async (
    _label,
    envelope,
  ) => {
    const executor = fakeExecutor(async (execution) => {
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({ stdout: JSON.stringify(envelope) });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).resolves.toEqual(validResult);
  });

  it.each([
    '--print',
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--tools',
    '--output-format',
    '--json-schema',
    '--max-budget-usd',
  ])('fails closed before prompt execution when help omits %s', async (missing) => {
    const calls: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      return processResult({ stdout: REQUIRED_HELP.replace(missing, '') });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
      message: 'Claude CLI does not support the required restricted mode',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not accept dontAsk outside the permission-mode option', async () => {
    const calls: ProcessExecution[] = [];
    const misleadingHelp = REQUIRED_HELP.replace(
      '--permission-mode <mode> (choices: dontAsk)',
      '--permission-mode <mode> (choices: default)\nOther option: dontAsk',
    );
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      return processResult({ stdout: misleadingHelp });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({ code: 'unsupported_claude_cli' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'a prefixed value',
      '--permission-mode <mode> (choices: not-dontAsk)',
    ],
    [
      'a suffixed value',
      '--permission-mode <mode> (choices: dontAskExtra)',
    ],
    [
      'a later unrelated choices list',
      '--permission-mode <mode> choices: default; note choices: dontAsk',
    ],
    [
      'prose after a period',
      '--permission-mode <mode> (choices: default. dontAsk)',
    ],
    [
      'prose after a colon',
      '--permission-mode <mode> (choices: default: dontAsk)',
    ],
    [
      'prose after a dash',
      '--permission-mode <mode> (choices: default - dontAsk)',
    ],
    [
      'an unbounded values declaration',
      '--permission-mode <mode> choices: dontAsk',
    ],
    [
      'a trailing list separator',
      '--permission-mode <mode> (choices: dontAsk,)',
    ],
  ])('does not accept dontAsk from %s', async (_label, permissionLine) => {
    const calls: ProcessExecution[] = [];
    const misleadingHelp = REQUIRED_HELP.replace(
      '--permission-mode <mode> (choices: dontAsk)',
      permissionLine,
    );
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: misleadingHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not accept a removed documentation-only option declaration', async () => {
    const calls: ProcessExecution[] = [];
    const deprecatedHelp = REQUIRED_HELP.replace(
      '--safe-mode',
      '--safe-mode DEPRECATED: removed; documentation only',
    );
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: deprecatedHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not accept an option deprecated on a continuation line', async () => {
    const calls: ProcessExecution[] = [];
    const deprecatedHelp = REQUIRED_HELP.replace(
      '--safe-mode',
      '--safe-mode\n  DEPRECATED: removed; documentation only',
    );
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: deprecatedHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it.each([
    [
      'safe-mode mentioned in another option description',
      '--safe-mode',
      '--other-option\n  --safe-mode remains available elsewhere',
    ],
    [
      'permission-mode nested in another option description',
      '--permission-mode <mode> (choices: dontAsk)',
      [
        '--other-option',
        '  --permission-mode <mode> (choices: dontAsk)',
      ].join('\n'),
    ],
  ])('does not promote %s', async (_label, requiredLine, replacement) => {
    const calls: ProcessExecution[] = [];
    const nestedHelp = REQUIRED_HELP.replace(requiredLine, replacement);
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: nestedHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('accepts bounded choices from a CRLF description continuation', async () => {
    const calls: ProcessExecution[] = [];
    const continuedHelp = REQUIRED_HELP.replace('--print', '-p, --print').replace(
      '--permission-mode <mode> (choices: dontAsk)',
      [
        '--permission-mode <mode>',
        '  Permission behavior [allowed values: "default", "dontAsk"]',
      ].join('\n'),
    ).replace(/\n/g, '\r\n');
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: continuedHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).resolves.toEqual(validResult);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not accept required flag names mentioned only in prose', async () => {
    const calls: ProcessExecution[] = [];
    const proseOnlyHelp = [
      'Usage: claude [options]',
      'Deprecated names retained for documentation only:',
      '--print --safe-mode --no-session-persistence --tools',
      '--output-format --json-schema --max-budget-usd',
      'The old --permission-mode documentation mentioned choices: dontAsk.',
    ].join('\n');
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: proseOnlyHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('does not accept longer option names containing required flag names', async () => {
    const calls: ProcessExecution[] = [];
    const longerOptionsHelp = [
      '--print-extra',
      '--safe-mode-extra',
      '--no-session-persistence-extra',
      '--permission-mode-extra <mode> (choices: dontAsk)',
      '--tools-extra <tools>',
      '--output-format-extra <format>',
      '--json-schema-extra <schema>',
      '--max-budget-usd-extra <amount>',
    ].join('\n');
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: longerOptionsHelp });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'unsupported_claude_cli',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeUndefined();
  });

  it('enables strict MCP isolation only when the CLI advertises support', async () => {
    const calls: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({
          stdout: `${REQUIRED_HELP}\n--strict-mcp-config`,
        });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    });

    expect(calls[1]?.args).toContain('--strict-mcp-config');
  });

  it('caps a caller timeout at 30 minutes', async () => {
    const calls: ProcessExecution[] = [];
    const executor = fakeExecutor(async (execution) => {
      calls.push(execution);
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({
        stdout: JSON.stringify({ structured_output: validResult }),
      });
    });
    const driver = await createDriver({ executor });

    await driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS * 2,
    });

    expect(calls[1]?.timeoutMs).toBe(CLAUDE_RESEARCH_TIMEOUT_MS);
  });

  it.each([
    ['timeout', processResult({ timedOut: true }), 'claude_timeout'],
    ['nonzero exit', processResult({
      exitCode: 7,
      stderr: 'PROMPT_AND_PATH_SENTINEL',
    }), 'claude_process_failed'],
    ['invalid JSON', processResult({
      stdout: 'PROMPT_AND_PATH_SENTINEL: not JSON',
    }), 'invalid_claude_json'],
    ['schema failure', processResult({
      stdout: JSON.stringify({ structured_output: { summary: 'incomplete' } }),
    }), 'invalid_research_result'],
  ])('returns a sanitized typed error for %s and cleans the cwd', async (
    _label,
    result,
    code,
  ) => {
    const fileSystem = fakeFileSystem();
    const executor = fakeExecutor(async (execution) => {
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return result;
    });
    const driver = await createDriver({ executor, fileSystem });

    let caught: unknown;
    try {
      await driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClaudeDriverError);
    expect(caught).toMatchObject({ code });
    expect(String(caught)).not.toContain('PROMPT_AND_PATH_SENTINEL');
    expect(String(caught)).not.toContain(RUN_DIRECTORY);
    expect(fileSystem.rm).toHaveBeenCalledWith(RUN_DIRECTORY, {
      recursive: true,
      force: true,
    });
  });

  it('maps executor failures to a sanitized process error and cleans the cwd', async () => {
    const fileSystem = fakeFileSystem();
    const executor = fakeExecutor(async (execution) => {
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      throw new Error(`spawn failed: ${RUN_DIRECTORY}/PROMPT_SENTINEL`);
    });
    const driver = await createDriver({ executor, fileSystem });

    let caught: unknown;
    try {
      await driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ClaudeDriverError',
      code: 'claude_process_failed',
    });
    expect(String(caught)).not.toContain('PROMPT_SENTINEL');
    expect(fileSystem.rm).toHaveBeenCalledOnce();
  });

  it('sanitizes a temporary-directory cleanup failure', async () => {
    const fileSystem = fakeFileSystem({
      rm: vi.fn(async () => {
        throw new Error(`cleanup failed: ${RUN_DIRECTORY}/CLEANUP_SENTINEL`);
      }),
    });
    const driver = await createDriver({ fileSystem });

    let caught: unknown;
    try {
      await driver.execute({
        task: makeTask(),
        context: makeContext(),
        timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'ClaudeDriverError',
      code: 'claude_process_failed',
    });
    expect(String(caught)).not.toContain('CLEANUP_SENTINEL');
    expect(String(caught)).not.toContain(RUN_DIRECTORY);
  });

  it('preserves the original typed execution error when cleanup also fails', async () => {
    const fileSystem = fakeFileSystem({
      rm: vi.fn(async () => {
        throw new Error(`cleanup failed: ${RUN_DIRECTORY}/CLEANUP_SENTINEL`);
      }),
    });
    const executor = fakeExecutor(async (execution) => {
      if (execution.args[0] === '--help') {
        return processResult({ stdout: REQUIRED_HELP });
      }
      return processResult({ timedOut: true });
    });
    const driver = await createDriver({ fileSystem, executor });

    await expect(driver.execute({
      task: makeTask(),
      context: makeContext(),
      timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    })).rejects.toMatchObject({
      name: 'ClaudeDriverError',
      code: 'claude_timeout',
    });
  });
});
