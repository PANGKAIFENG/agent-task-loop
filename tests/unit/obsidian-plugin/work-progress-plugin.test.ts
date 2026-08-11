import { describe, expect, it, vi } from 'vitest';

import {
  WorkProgressPluginLifecycle,
  isSafeWorkProgressPath,
  type WorkProgressPluginCommand,
} from '../../../src/obsidian-plugin/work-progress-plugin.js';

function context() {
  const commands: WorkProgressPluginCommand[] = [];
  const ribbons: Array<{ icon: string; title: string; callback: () => void }> = [];
  const open = vi.fn(async () => undefined);
  const lifecycle = new WorkProgressPluginLifecycle({
    addCommand: (command) => commands.push(command),
    addRibbonIcon: (icon, title, callback) => {
      ribbons.push({ icon, title, callback });
    },
    open,
  });
  return { lifecycle, commands, ribbons, open };
}

describe('WorkProgressPluginLifecycle', () => {
  it('registers the Work Progress ribbon and command', () => {
    const { lifecycle, commands, ribbons } = context();

    lifecycle.start();

    expect(ribbons).toEqual([expect.objectContaining({
      icon: 'notebook-tabs',
      title: 'ATL：工作沉淀',
    })]);
    expect(commands).toEqual([expect.objectContaining({
      id: 'open-work-progress',
      name: '打开工作沉淀',
    })]);
  });

  it('opens the same Work Progress view from both entry points', async () => {
    const { lifecycle, commands, ribbons, open } = context();
    lifecycle.start();

    ribbons[0]!.callback();
    commands[0]!.callback();

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});

describe('isSafeWorkProgressPath', () => {
  it.each([
    'TaskNotes/DingTalk/sha256-a.md',
    '08_Meetings/2026-08/meeting.md',
    '09_Progress/Items/2026-08/progress-v1.md',
  ])('allows a known internal Markdown path: %s', (path) => {
    expect(isSafeWorkProgressPath(path)).toBe(true);
  });

  it.each([
    '/Users/example/private.md',
    '../TaskNotes/DingTalk/event.md',
    '09_Progress/../10_Tasks/private.md',
    '09_Progress/Decisions/private.json',
    '10_Tasks/Inbox/task.md',
  ])('rejects an unsafe or unrelated path: %s', (path) => {
    expect(isSafeWorkProgressPath(path)).toBe(false);
  });
});
