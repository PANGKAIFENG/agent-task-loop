import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const bridgePath = resolve('scripts/atl-dingtalk-bridge.mjs');
const temporaryRoots: string[] = [];

async function fixture(): Promise<{
  root: string;
  runner: string;
  runnerLog: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'atl-decision-bridge-'));
  temporaryRoots.push(root);
  const runner = join(root, 'fake-runner.mjs');
  const runnerLog = join(root, 'runner.log');
  await writeFile(runner, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.ATL_FAKE_RUNNER_LOG, JSON.stringify({
  args,
  allowRealWrites: process.env.ATL_ALLOW_REAL_WRITES ?? null
}) + '\\n');
if (args[0] === 'task' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    taskId: 'task-bridge-canary',
    pendingDecision: {
      requestId: 'decision-canary',
      question: '选择继续方式',
      options: [
        { id: 'option-a', label: '方案 A' },
        { id: 'option-b', label: '方案 B' }
      ]
    }
  }]));
} else if (args[0] === 'runner' && args[1] === 'continue-decision') {
  process.stdout.write(JSON.stringify({
    status: 'submitted',
    taskId: 'task-bridge-canary',
    artifactRef: 'Artifacts/task-bridge-canary/attempt-002.md'
  }));
} else {
  process.stdout.write(JSON.stringify({ status: 'no_task' }));
}
`, 'utf8');
  await chmod(runner, 0o700);
  return { root, runner, runnerLog };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('DingTalk decision bridge', () => {
  it.each([
    ['接受 task-bridge-artifact v2', 'approve', undefined],
    ['要求修改 task-bridge-artifact v2：补充真实用户证据', 'request_changes', '补充真实用户证据'],
    ['阻塞 task-bridge-artifact v2：等待接口权限', 'block', '等待接口权限'],
    ['取消 task-bridge-artifact v2：目标已撤销', 'cancel', '目标已撤销'],
  ])('routes an Artifact review reply from Stream push: %s', async (
    message,
    decision,
    feedback,
  ) => {
    const paths = await fixture();
    await writeFile(paths.runner, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.ATL_FAKE_RUNNER_LOG, JSON.stringify({
  args,
  allowRealWrites: process.env.ATL_ALLOW_REAL_WRITES ?? null
}) + '\\n');
if (args[0] === 'task' && args[1] === 'review-external') {
  process.stdout.write(JSON.stringify({ accepted: true, task: {
    taskId: 'task-bridge-artifact', status: args.includes('--approve') ? 'done' : 'ready'
  }}));
} else {
  process.stdout.write(JSON.stringify([]));
}
`, 'utf8');
    await chmod(paths.runner, 0o700);

    const result = await execa(process.execPath, [
      bridgePath,
      'reply',
      '--event-id',
      `dingtalk-artifact-${decision}`,
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      message,
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
        ATL_ALLOW_REAL_WRITES: undefined,
      },
    });

    expect(result.stdout).toContain('task-bridge-artifact v2');
    const calls = (await readFile(paths.runnerLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as {
        args: string[];
        allowRealWrites: string | null;
      });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      'task',
      'review-external',
      '--task-id',
      'task-bridge-artifact',
      '--artifact-version',
      '2',
      '--response-event-id',
      `dingtalk-artifact-${decision}`,
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      `--${decision.replace('_', '-')}`,
    ]));
    if (feedback === undefined) {
      expect(calls[0]?.args).not.toContain('--feedback');
    } else {
      expect(calls[0]?.args).toEqual(expect.arrayContaining(['--feedback', feedback]));
    }
    expect(calls[0]?.allowRealWrites).toBeNull();
  });

  it('rejects an Artifact change request without feedback before invoking ATL', async () => {
    const paths = await fixture();

    await expect(execa(process.execPath, [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-artifact-missing-feedback',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      '要求修改 task-bridge-artifact v2',
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
      },
    })).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('必须包含反馈'),
    });
    await expect(readFile(paths.runnerLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues trusted Artifact rework immediately and retries after runner_busy on event replay', async () => {
    const paths = await fixture();
    await writeFile(paths.runner, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.ATL_FAKE_RUNNER_LOG, JSON.stringify({ args }) + '\\n');
const busyMarker = process.env.ATL_FAKE_BUSY_MARKER;
if (args[0] === 'task' && args[1] === 'review-external') {
  process.stdout.write(JSON.stringify({
    accepted: !existsSync(busyMarker),
    task: {
      taskId: 'task-bridge-artifact',
      status: 'agent_executable'
    }
  }));
} else if (args[0] === 'runner' && args[1] === 'run-task') {
  if (!existsSync(busyMarker)) {
    writeFileSync(busyMarker, 'busy');
    process.stdout.write(JSON.stringify({ status: 'runner_busy' }));
  } else {
    process.stdout.write(JSON.stringify({
      status: 'submitted',
      taskId: 'task-bridge-artifact',
      artifactRef: 'Artifacts/task-bridge-artifact/attempt-003.md'
    }));
  }
} else {
  process.stdout.write(JSON.stringify([]));
}
`, 'utf8');
    await chmod(paths.runner, 0o700);
    const args = [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-artifact-rework-busy',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      '要求修改 task-bridge-artifact v2：补充真实用户证据',
    ];
    const env = {
      ATL_NODE_EXECUTABLE: process.execPath,
      ATL_RUNNER_ENTRY: paths.runner,
      ATL_VAULT_ROOT: paths.root,
      ATL_FAKE_RUNNER_LOG: paths.runnerLog,
      ATL_FAKE_BUSY_MARKER: join(paths.root, 'busy.marker'),
      ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
      ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
      ATL_ALLOW_REAL_WRITES: undefined,
    };

    await expect(execa(process.execPath, args, { env })).resolves.toMatchObject({
      stdout: expect.stringContaining('runner_busy'),
    });
    await expect(execa(process.execPath, args, { env })).resolves.toMatchObject({
      stdout: expect.stringContaining('attempt-003.md'),
    });

    const calls = (await readFile(paths.runnerLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { args: string[] });
    expect(calls.filter(({ args: callArgs }) => (
      callArgs[0] === 'task' && callArgs[1] === 'review-external'
    ))).toHaveLength(2);
    const runs = calls.filter(({ args: callArgs }) => (
      callArgs[0] === 'runner' && callArgs[1] === 'run-task'
    ));
    expect(runs).toHaveLength(2);
    expect(runs[0]?.args).toEqual(expect.arrayContaining([
      '--task-id',
      'task-bridge-artifact',
      '--driver',
      'claude',
    ]));
  });

  it('rejects polling ingress modes', async () => {
    const paths = await fixture();

    await expect(execa(process.execPath, [bridgePath, 'poll-messages'], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
      },
    })).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Stream push'),
    });
  });

  it('passes the real pushed event ID to decision continuation without polling DingTalk', async () => {
    const paths = await fixture();
    const dwsLog = join(paths.root, 'dws.log');
    const fakeDws = join(paths.root, 'fake-dws.mjs');
    await writeFile(fakeDws, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.ATL_FAKE_DWS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ success: true }));
`, 'utf8');
    await chmod(fakeDws, 0o700);

    const result = await execa(process.execPath, [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-stream-event-001',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      'B',
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DWS_BIN: fakeDws,
        ATL_FAKE_DWS_LOG: dwsLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
        ATL_ALLOW_REAL_WRITES: undefined,
      },
    });

    expect(result.stdout).toContain('任务 task-bridge-canary 已进入 Review');
    const calls = (await readFile(paths.runnerLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as {
        args: string[];
        allowRealWrites: string | null;
      });
    expect(calls.at(-1)?.args).toEqual(expect.arrayContaining([
      '--response-event-id',
      'dingtalk-stream-event-001',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--selected-option-id',
      'option-b',
    ]));
    expect(calls.every(({ allowRealWrites }) => allowRealWrites === null)).toBe(true);
    await expect(readFile(dwsLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries one saved decision after runner_busy without recording the reply again', async () => {
    const paths = await fixture();
    const statePath = join(paths.root, 'runner-state.json');
    await writeFile(paths.runner, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.ATL_FAKE_RUNNER_STATE;
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { decisionRecorded: false, continuationCalls: 0 };
appendFileSync(process.env.ATL_FAKE_RUNNER_LOG, JSON.stringify({ args }) + '\\n');
if (args[0] === 'task' && args[1] === 'list') {
  const status = args[args.indexOf('--status') + 1];
  if (status === 'waiting_for_decision' && !state.decisionRecorded) {
    process.stdout.write(JSON.stringify([{
      taskId: 'task-bridge-canary',
      pendingDecision: {
        requestId: 'decision-canary',
        question: '选择继续方式',
        options: [
          { id: 'option-a', label: '方案 A' },
          { id: 'option-b', label: '方案 B' }
        ]
      }
    }]));
  } else if (status === 'agent_executable' && state.decisionRecorded) {
    process.stdout.write(JSON.stringify([{
      taskId: 'task-bridge-canary',
      lastDecision: {
        requestId: 'decision-canary',
        responseEventId: 'dingtalk-stream-event-busy',
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        selectedOptionId: 'option-b',
        responseText: 'B',
        continuationRunId: null
      }
    }]));
  } else {
    process.stdout.write('[]');
  }
} else if (args[0] === 'runner' && args[1] === 'continue-decision') {
  state.continuationCalls += 1;
  if (state.continuationCalls === 1) {
    state.decisionRecorded = true;
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({ status: 'runner_busy' }));
  } else {
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      status: 'submitted',
      taskId: 'task-bridge-canary',
      artifactRef: 'Artifacts/task-bridge-canary/attempt-002.md'
    }));
  }
}
`, 'utf8');
    await chmod(paths.runner, 0o700);
    const args = [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-stream-event-busy',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      'B',
    ];
    const env = {
      ATL_NODE_EXECUTABLE: process.execPath,
      ATL_RUNNER_ENTRY: paths.runner,
      ATL_VAULT_ROOT: paths.root,
      ATL_FAKE_RUNNER_LOG: paths.runnerLog,
      ATL_FAKE_RUNNER_STATE: statePath,
      ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
      ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
    };

    await expect(execa(process.execPath, args, { env })).resolves.toMatchObject({
      stdout: expect.stringContaining('runner_busy'),
    });
    await expect(execa(process.execPath, args, { env })).resolves.toMatchObject({
      stdout: expect.stringContaining('已进入 Review'),
    });

    const calls = (await readFile(paths.runnerLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { args: string[] });
    const continuations = calls.filter(({ args: callArgs }) => (
      callArgs[0] === 'runner' && callArgs[1] === 'continue-decision'
    ));
    expect(continuations).toHaveLength(2);
    expect(continuations[1]?.args).toEqual(expect.arrayContaining([
      '--decision-request-id',
      'decision-canary',
      '--response-event-id',
      'dingtalk-stream-event-busy',
      '--selected-option-id',
      'option-b',
      '--response-text',
      'B',
    ]));
    expect(calls.filter(({ args: callArgs }) => (
      callArgs[0] === 'task'
      && callArgs[1] === 'list'
      && callArgs.includes('agent_executable')
    ))).toHaveLength(2);
  });

  it('requires an upstream Stream event ID instead of deriving one from text', async () => {
    const paths = await fixture();

    await expect(execa(process.execPath, [
      bridgePath,
      'reply',
      '--message',
      'B',
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
      },
    })).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('--event-id is required'),
    });
  });

  it.each([
    ['sender', 'untrusted-user', 'trusted-conversation-001'],
    ['conversation', 'trusted-user-001', 'untrusted-conversation'],
  ])('rejects a reply from an untrusted %s', async (_source, senderUserId, conversationId) => {
    const paths = await fixture();

    await expect(execa(process.execPath, [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-stream-event-untrusted',
      '--sender-user-id',
      senderUserId,
      '--conversation-id',
      conversationId,
      '--message',
      'B',
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
      },
    })).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('reply source is not trusted'),
    });
    await expect(readFile(paths.runnerLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['sender', undefined, 'trusted-conversation-001'],
    ['conversation', 'trusted-user-001', undefined],
  ])('fails closed when the trusted %s is not configured', async (
    _source,
    trustedSenderUserId,
    trustedConversationId,
  ) => {
    const paths = await fixture();

    await expect(execa(process.execPath, [
      bridgePath,
      'reply',
      '--event-id',
      'dingtalk-stream-event-missing-trust',
      '--sender-user-id',
      'trusted-user-001',
      '--conversation-id',
      'trusted-conversation-001',
      '--message',
      'B',
    ], {
      env: {
        ATL_NODE_EXECUTABLE: process.execPath,
        ATL_RUNNER_ENTRY: paths.runner,
        ATL_VAULT_ROOT: paths.root,
        ATL_FAKE_RUNNER_LOG: paths.runnerLog,
        ATL_DINGTALK_TRUSTED_SENDER_USER_ID: trustedSenderUserId,
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: trustedConversationId,
      },
    })).rejects.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('trusted sender and conversation must be configured'),
    });
    await expect(readFile(paths.runnerLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
