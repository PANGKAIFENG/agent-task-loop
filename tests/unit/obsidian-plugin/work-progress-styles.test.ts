import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Work Progress styles', () => {
  it('styles the shell, tab states, evidence, weekly actions, and narrow layouts', async () => {
    const styles = await readFile(join(
      process.cwd(),
      'src/obsidian-plugin/styles.css',
    ), 'utf8');

    expect(styles).toContain('.atl-work-progress-shell');
    expect(styles).toContain('.atl-work-progress-tab[aria-selected="true"]');
    expect(styles).toContain('.atl-work-progress-evidence-support');
    expect(styles).toContain('.atl-work-progress-weekly');
    expect(styles).toContain('@media (max-width: 720px)');
  });
});
