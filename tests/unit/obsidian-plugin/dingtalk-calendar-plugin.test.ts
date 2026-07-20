import { describe, expect, it, vi } from 'vitest';

import {
  DingTalkCalendarPluginLifecycle,
  formatDingTalkSyncResult,
} from '../../../src/obsidian-plugin/dingtalk-calendar-plugin.js';
import type { DingTalkSyncResult } from '../../../src/obsidian-plugin/dingtalk-calendar-types.js';

function result(overrides: Partial<DingTalkSyncResult> = {}): DingTalkSyncResult {
  return {
    startedAt: '2026-07-20T01:00:00.000Z',
    finishedAt: '2026-07-20T01:00:01.000Z',
    added: 2,
    updated: 1,
    cancelled: 0,
    skipped: 3,
    conflicts: 0,
    errors: 0,
    ...overrides,
  };
}

function fixture(options: {
  enabled?: boolean;
  desktop?: boolean;
  sync?: () => Promise<DingTalkSyncResult>;
} = {}) {
  let enabled = options.enabled ?? true;
  let layoutReady: (() => void) | null = null;
  let interval: (() => void) | null = null;
  let intervalMs: number | null = null;
  const commands: Array<{ id: string; name: string; callback(): void }> = [];
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const sync = vi.fn(options.sync ?? (async () => result()));
  const lifecycle = new DingTalkCalendarPluginLifecycle({
    isDesktop: options.desktop ?? true,
    isEnabled: () => enabled,
    sync,
    addCommand: (command) => commands.push(command),
    onLayoutReady: (callback) => {
      layoutReady = callback;
    },
    registerInterval: (callback, milliseconds) => {
      interval = callback;
      intervalMs = milliseconds;
    },
    onSuccess,
    onError,
  });
  return {
    lifecycle,
    commands,
    sync,
    onSuccess,
    onError,
    setEnabled: (value: boolean) => { enabled = value; },
    fireLayoutReady: () => (layoutReady as (() => void) | null)?.(),
    fireInterval: () => (interval as (() => void) | null)?.(),
    intervalMs: () => intervalMs as number | null,
  };
}

describe('DingTalk calendar Obsidian lifecycle', () => {
  it('registers a manual command and starts enabled desktop sync on layout ready', async () => {
    const context = fixture();
    context.lifecycle.start();

    expect(context.commands).toContainEqual(expect.objectContaining({
      id: 'sync-dingtalk-calendar',
      name: '立即同步钉钉日历',
    }));
    expect(context.intervalMs()).toBe(15 * 60 * 1000);
    context.fireLayoutReady();
    await vi.waitFor(() => expect(context.sync).toHaveBeenCalledTimes(1));
    expect(context.onSuccess).toHaveBeenCalledWith(result(), 'automatic');
  });

  it('checks the enable setting on every interval without starting on mobile', async () => {
    const desktop = fixture({ enabled: false });
    desktop.lifecycle.start();
    desktop.fireLayoutReady();
    desktop.fireInterval();
    expect(desktop.sync).not.toHaveBeenCalled();

    desktop.setEnabled(true);
    desktop.fireInterval();
    await vi.waitFor(() => expect(desktop.sync).toHaveBeenCalledTimes(1));

    const mobile = fixture({ desktop: false });
    mobile.lifecycle.start();
    mobile.fireLayoutReady();
    expect(mobile.intervalMs()).toBeNull();
    expect(mobile.sync).not.toHaveBeenCalled();
  });

  it('coalesces repeated manual clicks and reports feedback once', async () => {
    let release!: (value: DingTalkSyncResult) => void;
    const pending = new Promise<DingTalkSyncResult>((resolve) => {
      release = resolve;
    });
    const context = fixture({ sync: () => pending });
    context.lifecycle.start();
    const command = context.commands.find(({ id }) => id === 'sync-dingtalk-calendar')!;

    command.callback();
    command.callback();
    expect(context.sync).toHaveBeenCalledTimes(1);
    release(result());
    await vi.waitFor(() => expect(context.onSuccess).toHaveBeenCalledTimes(1));
  });

  it('uses a redacted user-facing failure callback', async () => {
    const context = fixture({
      sync: async () => {
        throw new Error('https://secret.example.com/caldav?token=private');
      },
    });
    context.lifecycle.start();
    context.commands[0]!.callback();
    await vi.waitFor(() => expect(context.onError).toHaveBeenCalledWith(
      '钉钉日历同步失败，请检查设置后重试',
    ));
  });

  it('formats a compact result without calendar content', () => {
    expect(formatDingTalkSyncResult(result({ cancelled: 1, errors: 2 }))).toBe(
      '钉钉日历同步完成：新增 2，更新 1，取消 1，跳过 3，失败 2',
    );
  });
});
