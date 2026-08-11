import { describe, expect, it, vi } from 'vitest';

import {
  TaskBriefPluginLifecycle,
  type TaskBriefPluginCommand,
  type TaskBriefPluginMenu,
} from '../../../src/obsidian-plugin/task-brief-plugin-lifecycle.js';

const TASK_PATH = '10_Tasks/Active/personal/task-synthetic-brief.md';
const TASKNOTES_PATH = '10_Tasks/Inbox/实验：工作流skill完善.md';

function fixture() {
  let activePath: string | null = TASK_PATH;
  let fileMenu: ((menu: TaskBriefPluginMenu, path: string) => void) | null = null;
  const commands: TaskBriefPluginCommand[] = [];
  const open = vi.fn();
  const lifecycle = new TaskBriefPluginLifecycle({
    addCommand: (command) => commands.push(command),
    registerFileMenu: (handler) => {
      fileMenu = handler;
    },
    getActiveFilePath: () => activePath,
    isTaskPath: (path: string) => path === TASK_PATH || path === TASKNOTES_PATH,
    open,
  });
  return {
    lifecycle,
    commands,
    open,
    setActivePath: (path: string | null) => { activePath = path; },
    invokeFileMenu: (menu: TaskBriefPluginMenu, path: string) => {
      fileMenu?.(menu, path);
    },
  };
}

function menu() {
  const items: Array<{
    title: string;
    icon: string;
    callback: () => void;
  }> = [];
  const value: TaskBriefPluginMenu = {
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

describe('TaskBriefPluginLifecycle', () => {
  it('registers a current-task command for every ATL task lifecycle folder', () => {
    const context = fixture();
    context.lifecycle.start();
    const command = context.commands[0]!;

    expect(command).toMatchObject({
      id: 'clarify-current-task',
      name: '智能完善当前任务',
    });
    expect(command.checkCallback(true)).toBe(true);
    expect(context.open).not.toHaveBeenCalled();
    expect(command.checkCallback(false)).toBe(true);
    expect(context.open).toHaveBeenCalledWith(TASK_PATH);

    context.setActivePath('10_Tasks/Archive/2026/task-complete.md');
    expect(command.checkCallback(true)).toBe(true);
    context.setActivePath('笔记同步助手/2026-07-26/note.md');
    expect(command.checkCallback(false)).toBe(false);
    context.setActivePath(null);
    expect(command.checkCallback(false)).toBe(false);
  });

  it('adds an AI clarification action only to ATL task file menus', () => {
    const context = fixture();
    context.lifecycle.start();
    const taskMenu = menu();
    const regularMenu = menu();

    context.invokeFileMenu(taskMenu.value, TASK_PATH);
    context.invokeFileMenu(regularMenu.value, '03_Resources/note.md');

    expect(taskMenu.items).toEqual([expect.objectContaining({
      title: '智能完善任务',
      icon: 'sparkles',
    })]);
    expect(regularMenu.items).toEqual([]);
    taskMenu.items[0]!.callback();
    expect(context.open).toHaveBeenCalledWith(TASK_PATH);
  });

  it('exposes the command and file-menu action for a TaskNotes-native task', () => {
    const context = fixture();
    context.setActivePath(TASKNOTES_PATH);
    context.lifecycle.start();
    const command = context.commands[0]!;
    const taskMenu = menu();

    expect(command.checkCallback(true)).toBe(true);
    context.invokeFileMenu(taskMenu.value, TASKNOTES_PATH);
    expect(taskMenu.items).toEqual([expect.objectContaining({
      title: '智能完善任务',
    })]);
  });
});
