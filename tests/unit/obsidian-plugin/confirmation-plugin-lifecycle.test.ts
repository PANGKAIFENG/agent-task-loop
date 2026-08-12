import { describe, expect, it, vi } from 'vitest';

import {
  ConfirmationPluginLifecycle,
  confirmationActionFromMetadata,
  type ConfirmationPluginCommand,
  type ConfirmationPluginMenu,
  type ConfirmationPluginMenuItem,
} from '../../../src/obsidian-plugin/confirmation-plugin-lifecycle.js';

const INBOX_PATH = '10_Tasks/Inbox/2026-08-12/task-inbox.md';
const READY_PATH = '10_Tasks/Active/personal/task-ready.md';

function menu() {
  const items: Array<{ title: string; icon: string; callback: () => void }> = [];
  const value: ConfirmationPluginMenu = {
    addItem: (configure) => {
      const item: ConfirmationPluginMenuItem & {
        title: string;
        icon: string;
        callback: () => void;
      } = {
        title: '',
        icon: '',
        callback: () => undefined,
        setTitle(title: string) { this.title = title; return this; },
        setIcon(icon: string) { this.icon = icon; return this; },
        onClick(callback: () => void) { this.callback = callback; return this; },
      };
      configure(item);
      items.push(item);
    },
  };
  return { value, items };
}

describe('ConfirmationPluginLifecycle', () => {
  it('offers separate Inbox and unconfirmed Ready actions', () => {
    let activePath: string | null = INBOX_PATH;
    let fileMenu!: (menu: ConfirmationPluginMenu, path: string) => void;
    const commands: ConfirmationPluginCommand[] = [];
    const open = vi.fn();
    const actionFor = (path: string) => path === INBOX_PATH
      ? 'move_to_ready' as const
      : path === READY_PATH
      ? 'complete_ready' as const
      : null;
    new ConfirmationPluginLifecycle({
      addCommand: (command) => commands.push(command),
      registerFileMenu: (handler) => { fileMenu = handler; },
      getActiveFilePath: () => activePath,
      actionFor,
      open,
    }).start();

    expect(commands.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'confirm-current-inbox-task', name: '将当前任务移到待办' },
      { id: 'complete-current-ready-task', name: '完善当前待办' },
    ]);
    expect(commands[0]!.checkCallback(false)).toBe(true);
    expect(open).toHaveBeenLastCalledWith(INBOX_PATH);
    activePath = READY_PATH;
    expect(commands[0]!.checkCallback(true)).toBe(false);
    expect(commands[1]!.checkCallback(false)).toBe(true);
    expect(open).toHaveBeenLastCalledWith(READY_PATH);

    const inboxMenu = menu();
    const readyMenu = menu();
    const otherMenu = menu();
    fileMenu(inboxMenu.value, INBOX_PATH);
    fileMenu(readyMenu.value, READY_PATH);
    fileMenu(otherMenu.value, '03_Resources/note.md');
    expect(inboxMenu.items).toEqual([expect.objectContaining({ title: '移到待办' })]);
    expect(readyMenu.items).toEqual([expect.objectContaining({ title: '完善待办' })]);
    expect(otherMenu.items).toEqual([]);
  });

  it('does not offer completion for an already confirmed Ready task', () => {
    expect(confirmationActionFromMetadata(true, null)).toBe('move_to_ready');
    expect(confirmationActionFromMetadata(false, {
      status: 'ready',
      review_state: 'candidate',
    })).toBe('complete_ready');
    expect(confirmationActionFromMetadata(false, {
      status: 'ready',
      review_state: 'confirmed',
    })).toBeNull();
    expect(confirmationActionFromMetadata(false, {
      status: 'agent_executable',
      review_state: 'confirmed',
    })).toBeNull();
  });
});
