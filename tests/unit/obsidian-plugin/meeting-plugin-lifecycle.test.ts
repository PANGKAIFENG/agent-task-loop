import { describe, expect, it, vi } from 'vitest';

import {
  MeetingPluginLifecycle,
  type MeetingPluginCommand,
  type MeetingPluginMenu,
} from '../../../src/obsidian-plugin/meeting-plugin-lifecycle.js';

const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`;

function fixture() {
  let activePath: string | null = EVENT_PATH;
  let fileMenu: ((menu: MeetingPluginMenu, path: string) => void) | null = null;
  const commands: MeetingPluginCommand[] = [];
  const open = vi.fn();
  const lifecycle = new MeetingPluginLifecycle({
    addCommand: (command) => commands.push(command),
    registerFileMenu: (handler) => {
      fileMenu = handler;
    },
    getActiveFilePath: () => activePath,
    open,
  });
  return {
    lifecycle,
    commands,
    open,
    setActivePath: (path: string | null) => { activePath = path; },
    invokeFileMenu: (menu: MeetingPluginMenu, path: string) => {
      (fileMenu as ((menu: MeetingPluginMenu, path: string) => void) | null)?.(menu, path);
    },
  };
}

function menu() {
  const items: Array<{
    title: string;
    icon: string;
    callback: () => void;
  }> = [];
  const value: MeetingPluginMenu = {
    addItem: (configure) => {
      const item: {
        title: string;
        icon: string;
        callback: () => void;
        setTitle(title: string): typeof item;
        setIcon(icon: string): typeof item;
        onClick(callback: () => void): typeof item;
      } = {
        title: '',
        icon: '',
        callback: () => undefined,
        setTitle(title: string) {
          this.title = title;
          return this;
        },
        setIcon(icon: string) {
          this.icon = icon;
          return this;
        },
        onClick(callback: () => void) {
          this.callback = callback;
          return this;
        },
      };
      configure(item);
      items.push(item);
    },
  };
  return { value, items };
}

describe('MeetingPluginLifecycle', () => {
  it('registers an active-file command without adding another ribbon action', () => {
    const context = fixture();

    context.lifecycle.start();

    expect(context.commands).toEqual([expect.objectContaining({
      id: 'add-meeting-transcript',
      name: '为当前钉钉日程添加会议听记',
    })]);
  });

  it('offers a file-menu action only for DingTalk occurrence mirrors', () => {
    const context = fixture();
    context.lifecycle.start();
    const eventMenu = menu();
    const regularMenu = menu();

    context.invokeFileMenu(eventMenu.value, EVENT_PATH);
    context.invokeFileMenu(regularMenu.value, '10_Tasks/Inbox/task.md');

    expect(eventMenu.items).toEqual([expect.objectContaining({
      title: '添加会议听记',
      icon: 'notebook-pen',
    })]);
    expect(regularMenu.items).toEqual([]);
    eventMenu.items[0]!.callback();
    expect(context.open).toHaveBeenCalledWith(EVENT_PATH);
  });

  it('enables the command only when the active file is a DingTalk event', () => {
    const context = fixture();
    context.lifecycle.start();
    const command = context.commands[0]!;

    expect(command.checkCallback(true)).toBe(true);
    expect(context.open).not.toHaveBeenCalled();
    expect(command.checkCallback(false)).toBe(true);
    expect(context.open).toHaveBeenCalledWith(EVENT_PATH);

    context.setActivePath('08_Meetings/2026-07/note.md');
    expect(command.checkCallback(false)).toBe(false);
    context.setActivePath(null);
    expect(command.checkCallback(false)).toBe(false);
  });
});
