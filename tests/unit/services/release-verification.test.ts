import { describe, expect, it } from 'vitest';

import {
  FIXED_VERIFICATION_COMMANDS,
  REQUIRED_NODE_MAJOR,
  createSpawnVerificationRunner,
  nodeMajorVersionOf,
  runFixedVerification,
  type VerificationRunner,
} from '../../../src/services/release-verification.js';

const HEAD_SHA = 'a'.repeat(40);

function scriptedRunner(script: {
  commands: Map<string, { exitCode: number; stdout?: string }>;
  calls: string[];
}): VerificationRunner {
  return {
    run: async (argv) => {
      const command = argv.join(' ');
      script.calls.push(command);
      const result = script.commands.get(command);
      if (result === undefined) {
        return { command, exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
      }
      return {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout ?? '',
        stderr: result.exitCode === 0 ? '' : 'boom',
        durationMs: 2,
      };
    },
  };
}

function fixedCommandsMap(): Map<string, { exitCode: number; stdout?: string }> {
  const map = new Map<string, { exitCode: number; stdout?: string }>();
  for (const argv of FIXED_VERIFICATION_COMMANDS) {
    map.set(argv.join(' '), { exitCode: 0 });
  }
  map.set('git status --porcelain=v1 --untracked-files=all', { exitCode: 0, stdout: '' });
  return map;
}

describe('fixed verification contract', () => {
  it('does not pass DingTalk trust credentials to verification commands', async () => {
    const previousSender = process.env.ATL_DINGTALK_TRUSTED_SENDER_ID;
    const previousSenderUser = process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID;
    const previousConversation = process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID;
    process.env.ATL_DINGTALK_TRUSTED_SENDER_ID = 'synthetic-trusted-sender';
    process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID = 'synthetic-trusted-sender-user';
    process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID = 'synthetic-trusted-conversation';

    try {
      const runner = createSpawnVerificationRunner(5_000);
      const result = await runner.run([
        process.execPath,
        '-e',
        'process.stdout.write(`${process.env.ATL_DINGTALK_TRUSTED_SENDER_ID ?? ""}|${process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID ?? ""}|${process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID ?? ""}`)',
      ], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('||');
    } finally {
      if (previousSender === undefined) delete process.env.ATL_DINGTALK_TRUSTED_SENDER_ID;
      else process.env.ATL_DINGTALK_TRUSTED_SENDER_ID = previousSender;
      if (previousSenderUser === undefined) delete process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID;
      else process.env.ATL_DINGTALK_TRUSTED_SENDER_USER_ID = previousSenderUser;
      if (previousConversation === undefined) delete process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID;
      else process.env.ATL_DINGTALK_TRUSTED_CONVERSATION_ID = previousConversation;
    }
  });

  it('is exactly the task contract verification block in order', () => {
    expect(FIXED_VERIFICATION_COMMANDS.map((argv) => argv.join(' '))).toEqual([
      'pnpm --dir apps/agent-task-loop test',
      'pnpm --dir apps/agent-task-loop typecheck',
      'pnpm --dir apps/agent-task-loop lint',
      'pnpm --dir apps/agent-task-loop build',
      'pnpm --dir apps/agent-task-loop verify:v0.2-loop',
      'git diff --check',
    ]);
  });

  it('requires Node 24 or newer', () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24);
    expect(nodeMajorVersionOf('v24.15.0')).toBe(24);
    expect(nodeMajorVersionOf('v22.21.1')).toBe(22);
    expect(nodeMajorVersionOf('garbage')).toBeNull();
  });

  it('passes when the worktree head matches and every command exits zero', async () => {
    const script = { commands: fixedCommandsMap(), calls: [] as string[] };
    script.commands.set('git rev-parse HEAD', { exitCode: 0, stdout: `${HEAD_SHA}\n` });
    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner: scriptedRunner(script),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.headCheck).toEqual({
      command: 'git rev-parse HEAD',
      observedHeadSha: HEAD_SHA,
      matched: true,
    });
    expect(script.calls).toEqual([
      'git rev-parse HEAD',
      'git status --porcelain=v1 --untracked-files=all',
      ...FIXED_VERIFICATION_COMMANDS.map((argv) => argv.join(' ')),
      'git status --porcelain=v1 --untracked-files=all',
      'git rev-parse HEAD',
    ]);
    expect(outcome.commands).toHaveLength(6);
  });

  it('rejects a matching HEAD with uncommitted source before the fixed suite', async () => {
    const script = { commands: fixedCommandsMap(), calls: [] as string[] };
    script.commands.set('git rev-parse HEAD', { exitCode: 0, stdout: `${HEAD_SHA}\n` });
    script.commands.set('git status --porcelain=v1 --untracked-files=all', {
      exitCode: 0,
      stdout: ' M apps/agent-task-loop/src/services/release-operator.ts\n',
    });

    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner: scriptedRunner(script),
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.commands).toEqual([]);
    expect(script.calls).toEqual([
      'git rev-parse HEAD',
      'git status --porcelain=v1 --untracked-files=all',
    ]);
  });

  it('rejects candidate drift after the fixed suite', async () => {
    const commands = fixedCommandsMap();
    const calls: string[] = [];
    let statusChecks = 0;
    const runner: VerificationRunner = {
      run: async (argv) => {
        const command = argv.join(' ');
        calls.push(command);
        if (command === 'git rev-parse HEAD') {
          return { command, exitCode: 0, stdout: HEAD_SHA, stderr: '', durationMs: 1 };
        }
        if (command === 'git status --porcelain=v1 --untracked-files=all') {
          statusChecks += 1;
          return {
            command,
            exitCode: 0,
            stdout: statusChecks === 1 ? '' : '?? unreviewed.ts\n',
            stderr: '',
            durationMs: 1,
          };
        }
        const result = commands.get(command);
        return {
          command,
          exitCode: result?.exitCode ?? 0,
          stdout: result?.stdout ?? '',
          stderr: '',
          durationMs: 1,
        };
      },
    };

    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.commands).toHaveLength(FIXED_VERIFICATION_COMMANDS.length);
    expect(calls.at(-2)).toBe('git status --porcelain=v1 --untracked-files=all');
    expect(calls.at(-1)).toBe('git rev-parse HEAD');
  });

  it('fails closed on a head SHA mismatch before running any command', async () => {
    const script = { commands: fixedCommandsMap(), calls: [] as string[] };
    script.commands.set('git rev-parse HEAD', { exitCode: 0, stdout: `${'b'.repeat(40)}\n` });
    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner: scriptedRunner(script),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.headCheck?.matched).toBe(false);
    expect(outcome.commands).toEqual([]);
    // Not one fixed command ran against the wrong tree.
    expect(script.calls).toEqual(['git rev-parse HEAD']);
  });

  it('stops at the first failing command — later commands never run', async () => {
    const script = { commands: fixedCommandsMap(), calls: [] as string[] };
    script.commands.set('git rev-parse HEAD', { exitCode: 0, stdout: HEAD_SHA });
    script.commands.set('pnpm --dir apps/agent-task-loop lint', { exitCode: 1 });
    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner: scriptedRunner(script),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.commands).toHaveLength(3);
    expect(outcome.commands.at(-1)?.command).toBe('pnpm --dir apps/agent-task-loop lint');
    expect(outcome.commands.at(-1)?.exitCode).toBe(1);
    expect(script.calls).not.toContain('pnpm --dir apps/agent-task-loop build');
  });

  it('fails the node gate without touching the worktree', async () => {
    const script = { commands: fixedCommandsMap(), calls: [] as string[] };
    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v22.21.1',
      runner: scriptedRunner(script),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.headCheck).toBeNull();
    expect(script.calls).toEqual([]);
  });

  it('sanitizes and bounds the recorded output tail', async () => {
    const commands = new Map<string, { exitCode: number; stdout?: string }>();
    commands.set('git rev-parse HEAD', { exitCode: 0, stdout: HEAD_SHA });
    commands.set('echo payload', { exitCode: 0, stdout: `x${'a'.repeat(5_000)}tail` });
    const outcome = await runFixedVerification({
      workDir: '/candidate-checkout',
      headSha: HEAD_SHA,
      nodeVersion: 'v24.15.0',
      runner: scriptedRunner({ commands, calls: [] }),
      commands: [['echo', 'payload']],
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.commands[0]?.outputTail.length).toBeLessThanOrEqual(2_000);
    expect(outcome.commands[0]?.outputTail).not.toContain('');
    expect(outcome.commands[0]?.outputTail?.endsWith('tail')).toBe(true);
  });
});
