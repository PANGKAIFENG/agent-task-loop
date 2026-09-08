import type {
  ReleaseVerificationCommandResult,
  ReleaseVerificationReceipt,
} from '../domain/release-receipt.js';

// PAW-GOAL-003 T3 (Goal §9 / task contract Verification): the Release
// Operator runs a FIXED verification suite from the immutable candidate SHA
// and records a per-command receipt. The suite is exactly the task
// contract's verification block — nothing may be added or skipped per run.
export const FIXED_VERIFICATION_COMMANDS: readonly (readonly string[])[] = [
  ['pnpm', '--dir', 'apps/agent-task-loop', 'test'],
  ['pnpm', '--dir', 'apps/agent-task-loop', 'typecheck'],
  ['pnpm', '--dir', 'apps/agent-task-loop', 'lint'],
  ['pnpm', '--dir', 'apps/agent-task-loop', 'build'],
  ['pnpm', '--dir', 'apps/agent-task-loop', 'verify:v0.2-loop'],
  ['git', 'diff', '--check'],
];

export const REQUIRED_NODE_MAJOR = 24;

export interface VerificationCommandRun {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VerificationRunner {
  run(argv: readonly string[], cwd: string): Promise<VerificationCommandRun>;
}

const OUTPUT_TAIL_LIMIT = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Default runner: direct argv spawn (no shell), bounded by a hard per-command
 * timeout. argv-only execution keeps the fixed suite free of shell injection
 * surface, mirroring the Multica connector's process discipline.
 */
export function createSpawnVerificationRunner(
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): VerificationRunner {
  return {
    run: async (argv: readonly string[], cwd: string) => {
    const { spawn } = await import('node:child_process');
    const startedAt = Date.now();
    const environment = { ...process.env };
    delete environment.ATL_DINGTALK_TRUSTED_SENDER_ID;
    delete environment.ATL_DINGTALK_TRUSTED_SENDER_USER_ID;
    delete environment.ATL_DINGTALK_TRUSTED_CONVERSATION_ID;
    const child = spawn(argv[0] ?? '', argv.slice(1), {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, commandTimeoutMs);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
      });
      if (timedOut) {
        stderr = `${stderr}\nverification command timed out after ${commandTimeoutMs}ms`;
        return { command: argv.join(' '), exitCode: -1, stdout, stderr, durationMs: Date.now() - startedAt };
      }
      return {
        command: argv.join(' '),
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    },
  };
}

function commandText(argv: readonly string[]): string {
  return argv.join(' ');
}

function outputTail(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  const sanitized = Array.from(combined)
    .map((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 10 ? character : ' ';
    })
    .join('');
  return sanitized.slice(-OUTPUT_TAIL_LIMIT);
}

export interface FixedVerificationOutcome extends ReleaseVerificationReceipt {
  passed: boolean;
}

/**
 * Node 24 gate: the engines contract fixes the runtime; anything older (or
 * unparseable) fails the gate before a single command runs.
 */
export function nodeMajorVersionOf(nodeVersion: string): number | null {
  const match = /v?(\d+)\./.exec(nodeVersion.trim()) ?? /^v?(\d+)$/.exec(nodeVersion.trim());
  if (match === null) return null;
  const major = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Runs the fixed suite inside `workDir`, which must be a checkout of the
 * accepted immutable `headSha` — proven by `git rev-parse HEAD` BEFORE any
 * command executes, so receipts can never certify the wrong tree. Every
 * failure (node gate, head mismatch, failing command) is RETURNED, never
 * thrown: the release operator persists the exact failure into the receipt.
 */
export async function runFixedVerification(input: {
  workDir: string;
  headSha: string;
  nodeVersion: string;
  runner: VerificationRunner;
  commands?: readonly (readonly string[])[];
}): Promise<FixedVerificationOutcome> {
  const major = nodeMajorVersionOf(input.nodeVersion);
  if (major === null || major < REQUIRED_NODE_MAJOR) {
    return {
      nodeVersion: input.nodeVersion,
      headCheck: null,
      candidateCheck: null,
      commands: [],
      passed: false,
    };
  }
  const headArgv = ['git', 'rev-parse', 'HEAD'];
  const headRun = await input.runner.run(headArgv, input.workDir);
  const observedHeadSha = headRun.stdout.trim();
  const headCheck = {
    command: commandText(headArgv),
    observedHeadSha: observedHeadSha.slice(0, 100),
    matched: headRun.exitCode === 0 && observedHeadSha === input.headSha,
  };
  if (!headCheck.matched) {
    return {
      nodeVersion: input.nodeVersion,
      headCheck,
      candidateCheck: null,
      commands: [],
      passed: false,
    };
  }
  const statusArgv = ['git', 'status', '--porcelain=v1', '--untracked-files=all'];
  const statusBefore = await input.runner.run(statusArgv, input.workDir);
  const candidateCheck: ReleaseVerificationReceipt['candidateCheck'] = {
    statusCommand: commandText(statusArgv),
    cleanBefore: statusBefore.exitCode === 0 && statusBefore.stdout.trim() === '',
    cleanAfter: null,
    postHeadCommand: commandText(headArgv),
    observedHeadShaAfter: null,
    headMatchedAfter: null,
  };
  if (!candidateCheck.cleanBefore) {
    return {
      nodeVersion: input.nodeVersion,
      headCheck,
      candidateCheck,
      commands: [],
      passed: false,
    };
  }
  const commands = input.commands ?? FIXED_VERIFICATION_COMMANDS;
  const results: ReleaseVerificationCommandResult[] = [];
  for (const argv of commands) {
    const run = await input.runner.run(argv, input.workDir);
    results.push({
      command: commandText(argv),
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      outputTail: outputTail(run.stdout, run.stderr),
    });
    if (run.exitCode !== 0) {
      // The suite is fixed AND fail-closed: the first failing command stops
      // the run — later commands must not run against a tree that just
      // failed its gate.
      return {
        nodeVersion: input.nodeVersion,
        headCheck,
        candidateCheck,
        commands: results,
        passed: false,
      };
    }
  }
  const statusAfter = await input.runner.run(statusArgv, input.workDir);
  const headAfter = await input.runner.run(headArgv, input.workDir);
  candidateCheck.cleanAfter = statusAfter.exitCode === 0 && statusAfter.stdout.trim() === '';
  candidateCheck.observedHeadShaAfter = headAfter.stdout.trim().slice(0, 100);
  candidateCheck.headMatchedAfter = headAfter.exitCode === 0
    && headAfter.stdout.trim() === input.headSha;
  return {
    nodeVersion: input.nodeVersion,
    headCheck,
    candidateCheck,
    commands: results,
    passed: candidateCheck.cleanAfter && candidateCheck.headMatchedAfter,
  };
}
