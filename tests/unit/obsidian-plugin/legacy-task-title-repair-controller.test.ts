import { describe, expect, it, vi } from 'vitest';

import { LegacyTaskTitleRepairController } from '../../../src/obsidian-plugin/legacy-task-title-repair-controller.js';
import type { LegacyTaskTitleRepairRepository } from '../../../src/services/repair-legacy-task-titles.js';

describe('LegacyTaskTitleRepairController', () => {
  it('keeps preview read-only and delegates repair through the service', async () => {
    const repository: LegacyTaskTitleRepairRepository = {
      scan: vi.fn(async () => ({
        filesScanned: 2,
        tasksScanned: 1,
        candidates: [{
          path: '10_Tasks/Inbox/example.md',
          title: 'Review synthetic source',
          revision: 'revision',
        }],
      })),
      repair: vi.fn(async () => true),
      rebuildIndex: vi.fn(async () => undefined),
    };
    const controller = new LegacyTaskTitleRepairController(repository);

    const preview = await controller.preview();
    expect(preview).toMatchObject({
      filesScanned: 2,
      candidates: [{ title: 'Review synthetic source' }],
    });
    expect(repository.repair).not.toHaveBeenCalled();

    await expect(controller.repair(preview)).resolves.toMatchObject({
      repairable: 1,
      repaired: 1,
    });
    expect(repository.repair).toHaveBeenCalledOnce();
    expect(repository.scan).toHaveBeenCalledOnce();
  });
});
