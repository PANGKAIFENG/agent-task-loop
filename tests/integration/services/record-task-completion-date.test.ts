import { afterEach, describe, expect, it } from 'vitest';

import type { Task, TaskStatus } from '../../../src/domain/task.js';
import { recordTaskCompletionDate } from '../../../src/services/record-task-completion-date.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];
const NOW = new Date('2026-07-20T10:00:00+08:00');

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

function task(status: TaskStatus): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-history',
    title: '历史完成任务',
    body: '',
    status,
    reviewState: 'confirmed',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'history-task',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

async function fixture(status: TaskStatus = 'done'): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: NOW });
  contexts.push(context);
  await context.ctx.tasks.createIfSourceKeyAbsent(task(status));
  return context;
}

describe('recordTaskCompletionDate', () => {
  it('records selected local noon as explicit auditable completion evidence', async () => {
    const context = await fixture();

    const result = await recordTaskCompletionDate(context.ctx, {
      taskId: 'task-history',
      completedOn: '2026-07-18',
      timeZone: 'Asia/Shanghai',
    });

    expect(result).toEqual({
      recorded: true,
      taskId: 'task-history',
      completedOn: '2026-07-18',
    });
    expect(await context.ctx.audit.listForTask('task-history')).toContainEqual({
      event: 'task.completion_date_recorded',
      at: '2026-07-18T04:00:00.000Z',
      taskId: 'task-history',
      details: {
        completedOn: '2026-07-18',
        recordedAt: NOW.toISOString(),
        source: 'manual_backfill',
      },
    });
  });

  it('rejects non-done tasks plus invalid or future dates without writing audit evidence', async () => {
    const ready = await fixture('ready');
    await expect(recordTaskCompletionDate(ready.ctx, {
      taskId: 'task-history',
      completedOn: '2026-07-18',
      timeZone: 'Asia/Shanghai',
    })).rejects.toMatchObject({ code: 'task_not_done' });

    const done = await fixture();
    await expect(recordTaskCompletionDate(done.ctx, {
      taskId: 'task-history',
      completedOn: '2026-02-30',
      timeZone: 'Asia/Shanghai',
    })).rejects.toMatchObject({ code: 'invalid_date' });
    await expect(recordTaskCompletionDate(done.ctx, {
      taskId: 'task-history',
      completedOn: '2026-07-21',
      timeZone: 'Asia/Shanghai',
    })).rejects.toMatchObject({ code: 'future_date' });
    expect(await done.ctx.audit.listForTask('task-history')).toEqual([]);
  });

  it('is idempotent when the task already has recognized completion evidence', async () => {
    const context = await fixture();
    await context.ctx.audit.append({
      event: 'task.lifecycle_reconciled',
      at: '2026-07-19T04:00:00.000Z',
      taskId: 'task-history',
      details: { status: 'done' },
    });

    const result = await recordTaskCompletionDate(context.ctx, {
      taskId: 'task-history',
      completedOn: '2026-07-18',
      timeZone: 'Asia/Shanghai',
    });

    expect(result.recorded).toBe(false);
    expect(await context.ctx.audit.listForTask('task-history')).toHaveLength(1);
  });
});
