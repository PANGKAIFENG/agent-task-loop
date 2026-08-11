import { describe, expect, it, vi } from 'vitest';

import { runHourlyCycle } from '../../../src/runner/hourly-cycle.js';

describe('hourly runner cycle', () => {
  it('runs the scheduled Qianwen sync before the ordinary ATL task', async () => {
    const order: string[] = [];

    const result = await runHourlyCycle({
      syncQianwen: async () => {
        order.push('qianwen');
        return { status: 'completed' as const };
      },
      runTask: async () => {
        order.push('task');
        return { status: 'no_task' as const };
      },
    });

    expect(order).toEqual(['qianwen', 'task']);
    expect(result).toEqual({
      qianwen: { status: 'completed' },
      task: { status: 'no_task' },
    });
  });

  it('keeps the ordinary ATL task running when Qianwen synchronization fails', async () => {
    const runTask = vi.fn(async () => ({ status: 'submitted' as const }));

    const result = await runHourlyCycle({
      syncQianwen: async () => {
        throw Object.assign(new Error('sensitive connector detail'), {
          code: 'qianwen_repository_failed',
        });
      },
      runTask,
    });

    expect(runTask).toHaveBeenCalledOnce();
    expect(result).toEqual({
      qianwen: {
        status: 'failed',
        errorCode: 'qianwen_repository_failed',
      },
      task: { status: 'submitted' },
    });
  });
});
