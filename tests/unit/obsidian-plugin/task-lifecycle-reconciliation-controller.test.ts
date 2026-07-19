import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskLifecycleReconciliationController } from '../../../src/obsidian-plugin/task-lifecycle-reconciliation-controller.js';
import type { ServiceContext } from '../../../src/services/service-context.js';

const context = {} as ServiceContext;
const inboxPath = '10_Tasks/Inbox/2026-07-19/task-lifecycle-controller-test.md';

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskLifecycleReconciliationController', () => {
  it('debounces repeated metadata changes and reconciles the latest ATL task path', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => ({
      reconciled: true,
      taskId: 'task-lifecycle-controller-test',
    }));
    const controller = new TaskLifecycleReconciliationController({
      context,
      delayMs: 250,
      reconcile,
    });

    expect(controller.schedule(inboxPath)).toBe(true);
    expect(controller.schedule(inboxPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      context,
      'task-lifecycle-controller-test',
      inboxPath,
    );
  });

  it('ignores non-task paths and cancels pending work when disposed', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn();
    const controller = new TaskLifecycleReconciliationController({
      context,
      delayMs: 250,
      reconcile,
    });

    expect(controller.schedule('笔记同步助手/2026-07-19/同步助手.md')).toBe(false);
    expect(controller.schedule(inboxPath)).toBe(true);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(250);

    expect(reconcile).not.toHaveBeenCalled();
  });
});
