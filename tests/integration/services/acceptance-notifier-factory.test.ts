import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import type { ArtifactResult } from '../../../src/domain/artifact.js';
import { createAcceptanceNotifier } from '../../../src/services/acceptance-notifier-factory.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const contexts: Array<Awaited<ReturnType<typeof createTestServiceContext>>> = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

function reviewTask(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260811-synthetic-review',
    title: 'Synthetic acceptance artifact',
    body: '\nSynthetic body.\n',
    status: 'review',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'research',
    objective: 'Verify notification wiring.',
    acceptanceCriteria: ['Use only synthetic test data.'],
    autoExecutable: false,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-11',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:acceptance-notifier',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: null,
    artifactRefs: ['Artifacts/task-20260811-synthetic-review/attempt-001.md'],
    reviewFeedback: null,
    readyAt: '2026-08-11T01:00:00.000Z',
    createdAt: '2026-08-11T01:00:00.000Z',
    updatedAt: '2026-08-11T01:00:00.000Z',
  };
}

function artifactResult(): ArtifactResult {
  return {
    summary: 'Synthetic artifact is ready for acceptance.',
    findings: ['Synthetic finding.'],
    evidence: [{
      title: 'Synthetic public evidence',
      url: 'https://example.com/evidence',
      accessedAt: '2026-08-11T01:30:00.000Z',
    }],
    uncertainties: [],
    recommendedActions: ['Review the synthetic output.'],
    acceptance: [{
      criterion: 'Use only synthetic test data.',
      status: 'met',
      note: 'Only synthetic fixtures were used.',
    }],
  };
}

describe('createAcceptanceNotifier', () => {
  it('wires the production repositories, self delivery, and Vault ledger', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = reviewTask();
    await context.ctx.tasks.save(task);
    const calls: string[][] = [];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes('get-self')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            complete: true,
            failures: [],
            result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          complete: true,
          failures: [],
          result: [{ openTaskId: 'synthetic-task-id' }],
        }),
      };
    });
    const notify = createAcceptanceNotifier({
      vaultRoot: context.root,
      profile: 'synthetic-current-profile',
      clock: () => new Date('2026-08-11T02:00:00.000Z'),
      dwsRunner: runner,
    });

    await notify({
      objectType: 'artifact',
      objectId: task.taskId,
      version: 1,
      title: task.title,
      state: 'pending',
      pendingCount: 1,
      path: `10_Tasks/${task.artifactRefs[0]}`,
      notification: null,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '--profile', 'synthetic-current-profile', '--format', 'json',
      'contact', 'user', 'get-self',
    ]);
    expect(calls[1]).toEqual(expect.arrayContaining([
      '--profile', 'synthetic-current-profile',
      '--user', 'synthetic-self-user',
      '--title', 'ATL 待验收通知',
    ]));
    expect(calls[1]?.join('\n')).not.toContain(task.body.trim());
    expect(JSON.parse(await readFile(join(
      context.root,
      '.atl-runtime',
      'acceptance-notifications.json',
    ), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      records: [{
        idempotencyKey: `artifact:${task.taskId}:1`,
        status: 'sent',
        taskId: 'synthetic-task-id',
      }],
    });
  });

  it('keeps notifications disabled when no profile is configured', () => {
    expect(createAcceptanceNotifier({
      vaultRoot: '/tmp/synthetic-atl-vault',
      profile: null,
    })).toBeUndefined();
  });

  it('rebuilds and retries a failed Artifact notification from persisted Vault state', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = reviewTask();
    const claimed: Task = {
      ...task,
      status: 'in_progress',
      claim: {
        runId: 'run-synthetic-notification-retry',
        agent: 'synthetic-agent',
        claimedAt: '2026-08-11T01:00:00.000Z',
        leaseExpiresAt: '2026-08-11T02:00:00.000Z',
      },
      artifactRefs: [],
    };
    await context.ctx.artifacts.write({
      task: claimed,
      runId: claimed.claim?.runId ?? '',
      agent: claimed.claim?.agent ?? '',
      result: artifactResult(),
      createdAt: '2026-08-11T01:30:00.000Z',
    });
    await context.ctx.tasks.save(task);
    let sendAttempts = 0;
    const calls: string[][] = [];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes('get-self')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            complete: true,
            failures: [],
            result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
          }),
        };
      }
      sendAttempts += 1;
      return sendAttempts === 1
        ? { exitCode: 1, stdout: '' }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              success: true,
              complete: true,
              failures: [],
              result: [{ openTaskId: 'synthetic-retried-task-id' }],
            }),
          };
    });
    const notify = createAcceptanceNotifier({
      vaultRoot: context.root,
      profile: 'synthetic-current-profile',
      clock: () => new Date('2026-08-11T02:00:00.000Z'),
      dwsRunner: runner,
    });
    await notify({
      objectType: 'artifact',
      objectId: task.taskId,
      version: 1,
      title: task.title,
      state: 'pending',
      pendingCount: 1,
      path: `10_Tasks/${task.artifactRefs[0]}`,
      artifact: {
        reference: `${task.taskId}@v1`,
        summary: artifactResult().summary,
        evidenceCount: 1,
        checks: { met: 1, partial: 0, notMet: 0 },
      },
      notification: null,
    });

    const retried = await notify.retryFailed();

    expect(retried).toEqual([expect.objectContaining({
      idempotencyKey: `artifact:${task.taskId}:1`,
      status: 'sent',
      taskId: 'synthetic-retried-task-id',
    })]);
    expect(sendAttempts).toBe(2);
    expect(calls.at(-1)?.join('\n')).toContain(artifactResult().summary);
    expect(calls.at(-1)?.join('\n')).toContain('自检：通过 1；部分通过 0；未通过 0；证据 1');
  });

  it('retries a valid notification when another pending Artifact cannot be rebuilt', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const valid = reviewTask();
    const missing: Task = {
      ...reviewTask(),
      taskId: 'task-20260811-missing-artifact',
      title: 'Missing synthetic artifact',
      sourceKey: 'synthetic:missing-acceptance-artifact',
      artifactRefs: ['Artifacts/task-20260811-missing-artifact/attempt-001.md'],
    };
    const claimed: Task = {
      ...valid,
      status: 'in_progress',
      claim: {
        runId: 'run-synthetic-batch-retry',
        agent: 'synthetic-agent',
        claimedAt: '2026-08-11T01:00:00.000Z',
        leaseExpiresAt: '2026-08-11T02:00:00.000Z',
      },
      artifactRefs: [],
    };
    await context.ctx.artifacts.write({
      task: claimed,
      runId: claimed.claim?.runId ?? '',
      agent: claimed.claim?.agent ?? '',
      result: artifactResult(),
      createdAt: '2026-08-11T01:30:00.000Z',
    });
    await context.ctx.tasks.save(valid);
    await context.ctx.tasks.save(missing);
    let sendAttempts = 0;
    const runner = vi.fn(async (args: string[]) => {
      if (args.includes('get-self')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            complete: true,
            failures: [],
            result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
          }),
        };
      }
      sendAttempts += 1;
      return sendAttempts <= 2
        ? { exitCode: 1, stdout: '' }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              success: true,
              complete: true,
              failures: [],
              result: [{ openTaskId: 'synthetic-valid-retry' }],
            }),
          };
    });
    const notify = createAcceptanceNotifier({
      vaultRoot: context.root,
      profile: 'synthetic-current-profile',
      dwsRunner: runner,
    });
    const notification = (task: Task) => ({
      objectType: 'artifact' as const,
      objectId: task.taskId,
      version: 1,
      title: task.title,
      state: 'pending' as const,
      pendingCount: 1,
      path: `10_Tasks/${task.artifactRefs[0]}`,
      artifact: {
        reference: `${task.taskId}@v1`,
        summary: artifactResult().summary,
        evidenceCount: 1,
        checks: { met: 1, partial: 0, notMet: 0 },
      },
      notification: null,
    });
    await notify(notification(valid));
    await notify(notification(missing));

    await expect(notify.retryFailed()).resolves.toEqual([
      expect.objectContaining({
        idempotencyKey: `artifact:${valid.taskId}:1`,
        status: 'sent',
      }),
    ]);
    expect(sendAttempts).toBe(3);
  });
});
