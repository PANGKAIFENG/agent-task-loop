import { describe, expect, it, vi } from 'vitest';

import {
  DevelopmentDispatchPluginLifecycle,
  isDevelopmentDispatchEligibleMetadata,
  type DevelopmentDispatchPluginCommand,
  type DevelopmentDispatchPluginMenu,
} from '../../../src/obsidian-plugin/development-dispatch-plugin-lifecycle.js';

const READY_PATH = '10_Tasks/Active/project/task-dev-ready.md';

function developmentMetadata(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    review_state: 'confirmed',
    project_id: 'project-agent-task-loop',
    task_type: 'development',
    objective: 'Rebuild the binding.',
    acceptance_criteria: ['Restores the TEP identifier.'],
    permission_profile: 'repo_delivery',
    execution_target: 'multica',
    context_refs: ['docs/TECH/bridge.md'],
    ...overrides,
  };
}

describe('isDevelopmentDispatchEligibleMetadata (PAW-GOAL-003-V0.5 D2)', () => {
  it('accepts a confirmed undelivered development declaration', () => {
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata())).toBe(true);
  });

  it('accepts an authorized task whose dispatch failed (re-dispatch path)', () => {
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
      status: 'agent_executable',
      execution_link: { dispatch_state: 'failed' },
    }))).toBe(true);
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
      status: 'agent_executable',
      execution_link: { dispatch_state: 'not_requested' },
    }))).toBe(true);
  });

  it('rejects research or incomplete declarations', () => {
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
      task_type: 'research',
      permission_profile: 'read_only_research',
    }))).toBe(false);
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
      objective: '',
    }))).toBe(false);
    expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
      context_refs: ['', ' '],
    }))).toBe(false);
    expect(isDevelopmentDispatchEligibleMetadata(null)).toBe(false);
  });

  it('offers no re-dispatch while the remote fact is undecided or bound', () => {
    for (const dispatchState of ['pending', 'resolving_remote', 'remote_write_unknown', 'duplicate_conflict', 'linked']) {
      expect(isDevelopmentDispatchEligibleMetadata(developmentMetadata({
        status: 'agent_executable',
        execution_link: { dispatch_state: dispatchState },
      }))).toBe(false);
    }
  });
});

function fixture() {
  let activePath: string | null = READY_PATH;
  let fileMenu: ((menu: DevelopmentDispatchPluginMenu, path: string) => void) | null = null;
  const commands: DevelopmentDispatchPluginCommand[] = [];
  const open = vi.fn();
  const lifecycle = new DevelopmentDispatchPluginLifecycle({
    addCommand: (command) => commands.push(command),
    registerFileMenu: (handler) => { fileMenu = handler; },
    getActiveFilePath: () => activePath,
    isEligible: (path) => path === READY_PATH,
    open,
  });
  lifecycle.start();
  return {
    commands,
    open,
    setActivePath: (path: string | null) => { activePath = path; },
    invokeFileMenu: (menu: DevelopmentDispatchPluginMenu, path: string) => {
      fileMenu?.(menu, path);
    },
  };
}

function menu() {
  const items: Array<{ title: string; icon: string; callback: () => void }> = [];
  const value: DevelopmentDispatchPluginMenu = {
    addItem: (configure) => {
      const item = {
        setTitle: (title: string) => {
          items.push({ title, icon: '', callback: () => {} });
          return item;
        },
        setIcon: (icon: string) => {
          if (items.length > 0) items[items.length - 1]!.icon = icon;
          return item;
        },
        onClick: (callback: () => void) => {
          if (items.length > 0) items[items.length - 1]!.callback = callback;
          return item;
        },
      };
      configure(item as never);
    },
  };
  return { items, menu: value };
}

describe('DevelopmentDispatchPluginLifecycle', () => {
  it('registers the command palette entry and opens eligible tasks', () => {
    const harness = fixture();
    expect(harness.commands).toHaveLength(1);
    const command = harness.commands[0]!;
    expect(command.id).toBe('authorize-development-task-to-multica');
    expect(command.name).toBe('授权开发任务并交给 Multica');

    expect(command.checkCallback(true)).toBe(true);
    expect(harness.open).toHaveBeenCalledTimes(0);
    expect(command.checkCallback(false)).toBe(true);
    expect(harness.open).toHaveBeenCalledWith(READY_PATH);
  });

  it('hides the command for ineligible paths', () => {
    const harness = fixture();
    harness.setActivePath(null);
    expect(harness.commands[0]!.checkCallback(true)).toBe(false);
  });

  it('adds the context-menu item only for eligible files', () => {
    const harness = fixture();
    const eligible = menu();
    harness.invokeFileMenu(eligible.menu, READY_PATH);
    expect(eligible.items).toHaveLength(1);
    expect(eligible.items[0]).toMatchObject({ title: '授权并交给 Multica', icon: 'send' });
    eligible.items[0]!.callback();
    expect(harness.open).toHaveBeenCalledWith(READY_PATH);

    const ineligible = menu();
    harness.invokeFileMenu(ineligible.menu, '10_Tasks/Active/other/task-research.md');
    expect(ineligible.items).toHaveLength(0);
  });
});
