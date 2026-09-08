import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactResult } from '../../../src/domain/artifact.js';
import type { Task } from '../../../src/domain/task.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const contexts: Array<Awaited<ReturnType<typeof createTestServiceContext>>> = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

function inProgressTask(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260811-cli-notify',
    title: 'Synthetic CLI artifact',
    body: '\nSynthetic task body.\n',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'research',
    objective: 'Verify CLI notification wiring.',
    acceptanceCriteria: ['Keep all content synthetic.'],
    autoExecutable: false,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-11',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:cli-notification',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-synthetic-cli',
      agent: 'synthetic-agent',
      claimedAt: '2026-08-11T01:00:00.000Z',
      leaseExpiresAt: '2026-08-11T02:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-11T00:00:00.000Z',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T01:00:00.000Z',
  };
}

function waitingDecisionTask(): Task {
  return {
    ...inProgressTask(),
    taskId: 'task-20260814-cli-decision',
    title: 'Synthetic CLI decision',
    status: 'waiting_for_decision',
    sourceKey: 'synthetic:cli-decision-notification',
    claim: null,
    pendingDecision: {
      schemaVersion: 1,
      requestId: 'decision-cli-001',
      question: '请选择下一步。',
      options: [{ id: 'continue', label: '继续验证' }],
      requestedAt: '2026-08-14T02:00:00.000Z',
      requestedByRunId: 'run-synthetic-cli-decision',
    },
  };
}

describe('CLI acceptance notification wiring', () => {
  it('notifies the configured DingTalk self after Artifact submission', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = inProgressTask();
    await context.ctx.tasks.save(task);
    const bin = join(context.root, 'synthetic-bin');
    await mkdir(bin);
    const dws = join(bin, 'dws');
    await writeFile(dws, `#!/bin/sh
case "$*" in
  *get-self*) printf '%s\\n' '{"success":true,"complete":true,"failures":[],"result":[{"orgEmployeeModel":{"userId":"synthetic-self-user"}}]}' ;;
  *) printf '%s\\n' '{"success":true,"complete":true,"failures":[],"result":[{"openTaskId":"synthetic-cli-task"}]}' ;;
esac
`, 'utf8');
    await chmod(dws, 0o700);
    const resultPath = join(context.root, 'synthetic-result.json');
    const artifact: ArtifactResult = {
      summary: 'Synthetic summary.',
      findings: ['Synthetic finding.'],
      evidence: [{
        title: 'Synthetic public evidence',
        url: 'https://example.com/evidence',
        accessedAt: '2026-08-11T01:30:00.000Z',
      }],
      uncertainties: [],
      recommendedActions: ['Review synthetic output.'],
      acceptance: [{
        criterion: 'Keep all content synthetic.',
        status: 'met',
        note: 'Only synthetic fixtures were used.',
      }],
    };
    await writeFile(resultPath, JSON.stringify(artifact), 'utf8');

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'submit',
      '--task-id', task.taskId,
      '--run-id', task.claim?.runId ?? '',
      '--result', resultPath,
      '--json',
    ], {
      cwd: repositoryRoot,
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_DINGTALK_PROFILE: 'synthetic-current-profile',
        ATL_DINGTALK_ROBOT_CODE: 'ding-synthetic-atl-bot',
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: task.taskId,
      status: 'review',
    });
    expect(JSON.parse(await readFile(join(
      context.root,
      '.atl-runtime',
      'acceptance-notifications.json',
    ), 'utf8'))).toMatchObject({
      records: [{
        idempotencyKey: `artifact:${task.taskId}:1`,
        status: 'sent',
        taskId: 'synthetic-cli-task',
      }],
    });
  }, 30_000);

  it('can safely notify an already waiting decision exactly once', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = waitingDecisionTask();
    await context.ctx.tasks.save(task);
    const bin = join(context.root, 'synthetic-decision-bin');
    await mkdir(bin);
    const dws = join(bin, 'dws');
    await writeFile(dws, `#!/bin/sh
case "$*" in
  *get-self*) printf '%s\\n' '{"success":true,"complete":true,"failures":[],"result":[{"orgEmployeeModel":{"userId":"synthetic-self-user"}}]}' ;;
  *) printf '%s\\n' '{"success":true,"complete":true,"failures":[],"result":[{"openMessageId":"synthetic-cli-message"}]}' ;;
esac
`, 'utf8');
    await chmod(dws, 0o700);
    const invoke = () => execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'notify-decision',
      '--task-id', task.taskId,
      '--json',
    ], {
      cwd: repositoryRoot,
      env: {
        ATL_VAULT_ROOT: context.root,
        ATL_DINGTALK_PROFILE: 'synthetic-current-profile',
        ATL_DINGTALK_ROBOT_CODE: 'ding-synthetic-atl-bot',
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      reject: false,
    });

    const first = await invoke();
    const second = await invoke();

    expect(first.exitCode, first.stderr).toBe(0);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: 'sent',
      messageId: 'synthetic-cli-message',
    });
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    expect(JSON.parse(await readFile(join(
      context.root,
      '.atl-runtime',
      'decision-notifications.json',
    ), 'utf8'))).toMatchObject({
      records: [{
        idempotencyKey: `decision:${task.taskId}:decision-cli-001`,
        status: 'sent',
      }],
    });
  }, 30_000);
});
