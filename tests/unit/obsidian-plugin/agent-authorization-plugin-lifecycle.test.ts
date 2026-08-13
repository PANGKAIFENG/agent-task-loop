import { describe, expect, it, vi } from 'vitest';

import {
  AgentAuthorizationPluginLifecycle,
  isAgentAuthorizationEligibleMetadata,
  type AgentAuthorizationPluginCommand,
  type AgentAuthorizationPluginMenu,
} from '../../../src/obsidian-plugin/agent-authorization-plugin-lifecycle.js';

const READY_PATH = '10_Tasks/Active/personal/task-ready.md';
const INCOMPLETE_PATH = '10_Tasks/Active/personal/task-incomplete.md';

function fixture() {
  let activePath: string | null = READY_PATH;
  let fileMenu: ((menu: AgentAuthorizationPluginMenu, path: string) => void) | null = null;
  const commands: AgentAuthorizationPluginCommand[] = [];
  const authorize = vi.fn();
  const lifecycle = new AgentAuthorizationPluginLifecycle({
    addCommand: (command) => commands.push(command),
    registerFileMenu: (handler) => { fileMenu = handler; },
    getActiveFilePath: () => activePath,
    isEligible: (path) => path === READY_PATH,
    authorize,
  });
  return {
    lifecycle,
    commands,
    authorize,
    setActivePath: (path: string | null) => { activePath = path; },
    invokeFileMenu: (menu: AgentAuthorizationPluginMenu, path: string) => {
      fileMenu?.(menu, path);
    },
  };
}

function menu() {
  const items: Array<{ title: string; icon: string; callback: () => void }> = [];
  const value: AgentAuthorizationPluginMenu = {
    addItem: (configure) => {
      const item = {
        title: '',
        icon: '',
        callback: (() => undefined) as () => void,
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

describe('AgentAuthorizationPluginLifecycle', () => {
  it('offers a command and file-menu action only for an eligible Ready task', () => {
    const context = fixture();
    context.lifecycle.start();
    const command = context.commands[0]!;
    const readyMenu = menu();
    const incompleteMenu = menu();

    expect(command).toMatchObject({
      id: 'authorize-current-task-for-agent',
      name: '授权 Agent 执行当前任务',
    });
    expect(command.checkCallback(true)).toBe(true);
    expect(context.authorize).not.toHaveBeenCalled();
    expect(command.checkCallback(false)).toBe(true);
    expect(context.authorize).toHaveBeenCalledWith(READY_PATH);

    context.invokeFileMenu(readyMenu.value, READY_PATH);
    context.invokeFileMenu(incompleteMenu.value, INCOMPLETE_PATH);
    expect(readyMenu.items).toEqual([expect.objectContaining({
      title: '授权 Agent 执行',
      icon: 'bot',
    })]);
    expect(incompleteMenu.items).toEqual([]);
    readyMenu.items[0]!.callback();
    expect(context.authorize).toHaveBeenLastCalledWith(READY_PATH);

    context.setActivePath(INCOMPLETE_PATH);
    expect(command.checkCallback(false)).toBe(false);
    context.setActivePath(null);
    expect(command.checkCallback(false)).toBe(false);
  });

  it('requires confirmed read-only research context before showing authorization', () => {
    const complete = {
      status: 'ready',
      review_state: 'confirmed',
      project_id: 'personal-ai-system',
      task_type: 'research',
      objective: 'Build a reusable context structure',
      acceptance_criteria: ['Provide structure and evidence'],
      permission_profile: 'read_only_research',
    };

    expect(isAgentAuthorizationEligibleMetadata(complete)).toBe(true);
    for (const key of [
      'review_state',
      'project_id',
      'task_type',
      'objective',
      'acceptance_criteria',
      'permission_profile',
    ]) {
      expect(isAgentAuthorizationEligibleMetadata({
        ...complete,
        [key]: key === 'acceptance_criteria' ? [] : null,
      })).toBe(false);
    }
    expect(isAgentAuthorizationEligibleMetadata({ ...complete, status: 'in_progress' }))
      .toBe(false);
  });
});
