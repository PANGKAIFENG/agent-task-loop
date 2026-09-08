import { describe, expect, it, vi } from 'vitest';

import { runHourlyCycle } from '../../../src/runner/hourly-cycle.js';

describe('scheduled cycle Multica reconciliation leg (TECH §7)', () => {
  it('runs the Multica leg between notification retries and the Qianwen sync', async () => {
    const order: string[] = [];

    await runHourlyCycle({
      retryAcceptanceNotifications: async () => {
        order.push('notification');
        return { attempted: 1, sent: 1 };
      },
      reconcileMultica: async () => {
        order.push('multica');
        return { attempted: 3, remainingBacklog: 0 };
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

    expect(order).toEqual(['notification', 'multica', 'qianwen', 'task']);
  });

  it('keeps the Qianwen sync and the local research runner alive when the Multica leg fails', async () => {
    const syncQianwen = vi.fn(async () => ({ status: 'completed' as const }));
    const runTask = vi.fn(async () => ({ status: 'no_task' as const }));

    const result = await runHourlyCycle({
      retryAcceptanceNotifications: async () => ({ attempted: 0, sent: 0 }),
      reconcileMultica: async () => {
        throw Object.assign(new Error('daemon unavailable'), {
          code: 'multica_call_timed_out',
        });
      },
      syncQianwen,
      runTask,
    });

    expect(syncQianwen).toHaveBeenCalledOnce();
    expect(runTask).toHaveBeenCalledOnce();
    expect(result.multica).toEqual({
      status: 'failed',
      errorCode: 'multica_call_timed_out',
    });
    expect(result.qianwen).toEqual({ status: 'completed' });
    expect(result.task).toEqual({ status: 'no_task' });
  });

  it('reports the leg as skipped when no Multica reconciliation is configured', async () => {
    const result = await runHourlyCycle({
      retryAcceptanceNotifications: async () => ({ attempted: 0, sent: 0 }),
      syncQianwen: async () => ({ status: 'completed' as const }),
      runTask: async () => ({ status: 'no_task' as const }),
    });

    expect(result.multica).toEqual({ status: 'skipped' });
  });
});
