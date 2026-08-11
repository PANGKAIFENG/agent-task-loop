import { describe, expect, it, vi } from 'vitest';

import { QianwenSyncPluginLifecycle } from '../../../src/obsidian-plugin/qianwen-sync-plugin.js';

describe('Qianwen sync plugin lifecycle', () => {
  it('registers one manual sync command and reports its result', async () => {
    const commands: Array<{ id: string; name: string; callback: () => void }> = [];
    const onSuccess = vi.fn();
    const lifecycle = new QianwenSyncPluginLifecycle({
      addCommand: (command) => commands.push(command),
      sync: async () => ({ status: 'completed' as const, available: 2, pending: 1 }),
      onSuccess,
      onError: vi.fn(),
    });

    lifecycle.start();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: 'sync-qianwen-now',
      name: '立即同步千问听记',
    });

    commands[0]?.callback();
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith({
      status: 'completed',
      available: 2,
      pending: 1,
    }));
  });

  it('does not start a duplicate manual synchronization while one is in flight', async () => {
    const commands: Array<{ callback: () => void }> = [];
    let finish: (() => void) | undefined;
    const sync = vi.fn(() => new Promise<{ status: 'completed' }>((resolve) => {
      finish = () => resolve({ status: 'completed' });
    }));
    const lifecycle = new QianwenSyncPluginLifecycle({
      addCommand: (command) => commands.push(command),
      sync,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });

    lifecycle.start();
    commands[0]?.callback();
    commands[0]?.callback();
    expect(sync).toHaveBeenCalledOnce();

    finish?.();
    await vi.waitFor(() => expect(lifecycle.running).toBe(false));
  });
});
