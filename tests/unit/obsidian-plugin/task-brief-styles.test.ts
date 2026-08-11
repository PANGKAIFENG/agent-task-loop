import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('task brief modal styles', () => {
  it('keeps the brief editor bounded and usable in a narrow Obsidian pane', async () => {
    const styles = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('.atl-task-brief-modal');
    expect(styles).toContain('.atl-task-brief-context');
    expect(styles).toContain('.atl-task-brief-fields');
    expect(styles).toContain('.atl-task-brief-summary-row');
    expect(styles).toMatch(/\.atl-task-brief-modal[\s\S]*max-height:[^;]+;/u);
    expect(styles).toMatch(/@media \(max-width: 560px\)[\s\S]*\.atl-task-brief-modal \.setting-item/u);
  });
});
