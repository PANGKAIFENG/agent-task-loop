import { constants } from 'node:fs';
import { dirname } from 'node:path';

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
    blocks: [{
      label: 'project',
      kind: 'project',
      content: 'Only use the official public documentation.',
      sha256: 'a'.repeat(64),
    }],
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
  return {
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => ({ isFile: () => true })),
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
  });
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
      stat: vi.fn(async () => ({ isFile: () => false })),
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
      JSON.stringify(researchResultJsonSchema),
      '--max-budget-usd',
      '2',
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
    expect(JSON.stringify(execution)).not.toContain('/Users/synthetic');
    expect(execution?.args.join(' ')).not.toMatch(
      /Bash|Edit|Write|NotebookEdit|dangerously-skip-permissions|ClawVault/,
    );
    expect(fileSystem.mkdtemp).toHaveBeenCalledOnce();
    expect(fileSystem.rm).toHaveBeenCalledWith(RUN_DIRECTORY, {
      recursive: true,
      force: true,
    });
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
