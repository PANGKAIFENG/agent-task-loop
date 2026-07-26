import { describe, expect, it, vi } from 'vitest';

import {
  previewLegacyTaskTitles,
  repairLegacyTaskTitles,
  type LegacyTaskTitleRepairRepository,
} from '../../../src/services/repair-legacy-task-titles.js';

function repository(): LegacyTaskTitleRepairRepository & {
  scan: ReturnType<typeof vi.fn>;
  repair: ReturnType<typeof vi.fn>;
  rebuildIndex: ReturnType<typeof vi.fn>;
} {
  return {
    scan: vi.fn(async () => ({
      filesScanned: 5,
      tasksScanned: 4,
      candidates: [
        { path: '10_Tasks/Inbox/a.md', title: 'Task A', revision: 'a' },
        { path: '10_Tasks/Inbox/b.md', title: 'Task B', revision: 'b' },
        { path: '10_Tasks/Inbox/c.md', title: 'Task C', revision: 'c' },
      ],
    })),
    repair: vi.fn(async ({ revision }: { revision: string }) => {
      if (revision === 'a') return true;
      if (revision === 'b') return false;
      throw new Error('synthetic write failure');
    }),
    rebuildIndex: vi.fn(async () => undefined),
  };
}

describe('legacy task title repair service', () => {
  it('previews without writing', async () => {
    const store = repository();

    const preview = await previewLegacyTaskTitles(store);

    expect(preview).toMatchObject({ filesScanned: 5, tasksScanned: 4 });
    expect(preview.candidates[0]).toMatchObject({ title: 'Task A' });
    expect(store.repair).not.toHaveBeenCalled();
    expect(store.rebuildIndex).not.toHaveBeenCalled();
  });

  it('reports repaired, stale and failed candidates separately', async () => {
    const store = repository();

    await expect(repairLegacyTaskTitles(store)).resolves.toEqual({
      filesScanned: 5,
      tasksScanned: 4,
      repairable: 3,
      repaired: 1,
      skipped: 1,
      failed: 1,
      indexUpdated: true,
    });
    expect(store.repair).toHaveBeenCalledTimes(3);
    expect(store.rebuildIndex).toHaveBeenCalledOnce();
  });

  it('does not rebuild the index when no title changed', async () => {
    const store = repository();
    store.scan.mockResolvedValue({
      filesScanned: 2,
      tasksScanned: 2,
      candidates: [],
    });

    await expect(repairLegacyTaskTitles(store)).resolves.toMatchObject({
      repairable: 0,
      repaired: 0,
      indexUpdated: true,
    });
    expect(store.rebuildIndex).not.toHaveBeenCalled();
  });

  it('keeps successful repair counts when index rebuilding fails', async () => {
    const store = repository();
    store.scan.mockResolvedValue({
      filesScanned: 1,
      tasksScanned: 1,
      candidates: [{
        path: '10_Tasks/Inbox/a.md',
        title: 'Task A',
        revision: 'a',
      }],
    });
    store.rebuildIndex.mockRejectedValue(new Error('synthetic index failure'));

    await expect(repairLegacyTaskTitles(store)).resolves.toMatchObject({
      repaired: 1,
      failed: 0,
      indexUpdated: false,
    });
  });

  it('repairs the exact preview shown to the user without rescanning', async () => {
    const store = repository();
    const preview = await previewLegacyTaskTitles(store);

    await expect(repairLegacyTaskTitles(store, preview)).resolves.toMatchObject({
      filesScanned: 5,
      repairable: 3,
      repaired: 1,
      skipped: 1,
      failed: 1,
    });
    expect(store.scan).toHaveBeenCalledOnce();
  });
});
