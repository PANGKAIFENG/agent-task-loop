import { describe, expect, it, vi } from 'vitest';

import { runHourlyCycle } from '../../../src/runner/hourly-cycle.js';

describe('hourly runner cycle', () => {
  it('runs the scheduled Qianwen sync before the ordinary ATL task', async () => {
    const order: string[] = [];

    const result = await runHourlyCycle({
      retryAcceptanceNotifications: async () => {
        order.push('notification');
        return { attempted: 1, sent: 1 };
      },
      syncQianwen: async () => {
        order.push('qianwen');
        return { status: 'completed' as const };
      },
      runTask: async () => {
        order.push('task');
        return { status: 'no_task' as const };
      },
    });

    expect(order).toEqual(['notification', 'qianwen', 'task']);
    expect(result).toEqual({
      notifications: { attempted: 1, sent: 1 },
      qianwen: { status: 'completed' },
      task: { status: 'no_task' },
    });
  });

  it('keeps the ordinary ATL task running when Qianwen synchronization fails', async () => {
    const runTask = vi.fn(async () => ({ status: 'submitted' as const }));

    const result = await runHourlyCycle({
      retryAcceptanceNotifications: async () => ({ attempted: 0, sent: 0 }),
      syncQianwen: async () => {
        throw Object.assign(new Error('sensitive connector detail'), {
          code: 'qianwen_repository_failed',
        });
      },
      runTask,
    });

    expect(runTask).toHaveBeenCalledOnce();
    expect(result).toEqual({
      notifications: { attempted: 0, sent: 0 },
      qianwen: {
        status: 'failed',
        errorCode: 'qianwen_repository_failed',
      },
      task: { status: 'submitted' },
    });
  });

  it('keeps synchronization and task execution running when notification retry fails', async () => {
    const syncQianwen = vi.fn(async () => ({ status: 'completed' as const }));
    const runTask = vi.fn(async () => ({ status: 'no_task' as const }));

    const result = await runHourlyCycle({
      retryAcceptanceNotifications: async () => {
        throw Object.assign(new Error('sensitive retry detail'), {
          code: 'acceptance_ledger_lock_timeout',
        });
      },
      syncQianwen,
      runTask,
    });

    expect(syncQianwen).toHaveBeenCalledOnce();
    expect(runTask).toHaveBeenCalledOnce();
    expect(result).toEqual({
      notifications: {
        status: 'failed',
        errorCode: 'acceptance_ledger_lock_timeout',
      },
      qianwen: { status: 'completed' },
      task: { status: 'no_task' },
    });
  });
});
