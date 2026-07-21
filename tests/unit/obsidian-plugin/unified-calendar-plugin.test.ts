import { describe, expect, it, vi } from 'vitest';

import {
  UnifiedCalendarPluginLifecycle,
  type UnifiedCalendarCommand,
} from '../../../src/obsidian-plugin/unified-calendar-plugin.js';

function context() {
  const commands: UnifiedCalendarCommand[] = [];
  const ribbons: Array<{ icon: string; title: string; callback: () => void }> = [];
  const open = vi.fn(async () => undefined);
  const lifecycle = new UnifiedCalendarPluginLifecycle({
    addCommand: (command) => commands.push(command),
    addRibbonIcon: (icon, title, callback) => {
      ribbons.push({ icon, title, callback });
    },
    open,
  });
  return { lifecycle, commands, ribbons, open };
}

describe('UnifiedCalendarPluginLifecycle', () => {
  it('registers one clear ribbon action and command', () => {
    const { lifecycle, commands, ribbons } = context();

    lifecycle.start();

    expect(ribbons).toEqual([expect.objectContaining({
      icon: 'calendar-range',
      title: 'ATL：统一日历',
    })]);
    expect(commands).toEqual([expect.objectContaining({
      id: 'open-unified-calendar',
      name: '打开统一日历',
    })]);
  });

  it('opens the same unified calendar from both entry points', async () => {
    const { lifecycle, commands, ribbons, open } = context();
    lifecycle.start();

    ribbons[0]!.callback();
    commands[0]!.callback();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
