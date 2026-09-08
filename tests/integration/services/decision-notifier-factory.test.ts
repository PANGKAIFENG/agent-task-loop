import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { createDecisionNotifier } from '../../../src/services/decision-notifier-factory.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const contexts: Array<Awaited<ReturnType<typeof createTestServiceContext>>> = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

function waitingTask(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260814-synthetic-decision',
    title: 'Synthetic decision task',
    body: '\nPRIVATE_BODY_MUST_NOT_ENTER_DINGTALK_OR_LEDGER\n',
    status: 'waiting_for_decision',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'research',
    objective: 'Verify decision notification wiring.',
    acceptanceCriteria: ['Keep all content synthetic.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-14',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:decision-notifier',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-14T01:00:00.000Z',
    createdAt: '2026-08-14T01:00:00.000Z',
    updatedAt: '2026-08-14T02:00:00.000Z',
    pendingDecision: {
      schemaVersion: 1,
      requestId: 'decision-synthetic-001',
      question: '请选择验证范围。',
      options: [
        { id: 'scope-a', label: '只验证状态回流' },
        { id: 'scope-b', label: '验证完整闭环' },
      ],
      requestedAt: '2026-08-14T02:00:00.000Z',
      requestedByRunId: 'run-synthetic-001',
    },
  };
}

describe('createDecisionNotifier', () => {
  it('sends one self notification and persists only delivery metadata', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = waitingTask();
    await context.ctx.tasks.save(task);
    const calls: string[][] = [];
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args.includes('get-self')
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              success: true,
              complete: true,
              failures: [],
              result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
            }),
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              success: true,
              complete: true,
              failures: [],
              result: [{ openMessageId: 'synthetic-message-id' }],
            }),
          };
    });
    const notify = createDecisionNotifier({
      vaultRoot: context.root,
      profile: 'synthetic-current-profile',
      robotCode: 'ding-synthetic-atl-bot',
      clock: () => new Date('2026-08-14T02:01:00.000Z'),
      dwsRunner: runner,
    });

    const first = await notify(task);
    const second = await notify(task);

    expect(first).toMatchObject({ status: 'sent', messageId: 'synthetic-message-id' });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(expect.arrayContaining([
      'chat', 'message', 'send-by-bot',
      '--title', 'ATL 需要你决策',
    ]));
    expect(calls[1]?.join('\n')).toContain('1. scope-a：只验证状态回流');
    expect(calls[1]?.join('\n')).toContain(`回复示例：1 ${task.taskId}`);
    expect(calls[1]?.join('\n')).not.toContain(task.body.trim());

    const raw = await readFile(join(
      context.root,
      '.atl-runtime',
      'decision-notifications.json',
    ), 'utf8');
    expect(raw).not.toContain(task.pendingDecision?.question ?? 'unreachable');
    expect(raw).not.toContain(task.body.trim());
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      records: [{
        idempotencyKey: `decision:${task.taskId}:decision-synthetic-001`,
        status: 'sent',
        messageId: 'synthetic-message-id',
      }],
    });
  });

  it('keeps decision notifications disabled without a configured profile', () => {
    expect(createDecisionNotifier({
      vaultRoot: '/tmp/synthetic-atl-vault',
      profile: null,
    })).toBeUndefined();
  });

  it('does not resend a decision notification whose delivery result is unknown', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const task = waitingTask();
    await context.ctx.tasks.save(task);
    const runner = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      deliveryStatusUnknown: true,
    }));
    const notify = createDecisionNotifier({
      vaultRoot: context.root,
      profile: 'ding-synthetic-corp:synthetic-self-user',
      robotCode: 'ding-synthetic-atl-bot',
      clock: () => new Date('2026-08-14T02:01:00.000Z'),
      dwsRunner: runner,
    });

    await expect(notify(task)).resolves.toMatchObject({
      status: 'unknown',
      errorCode: 'decision_delivery_unknown',
    });
    await expect(notify(task)).resolves.toMatchObject({
      status: 'unknown',
      errorCode: 'decision_delivery_unknown',
    });
    expect(runner).toHaveBeenCalledOnce();
  });
});
