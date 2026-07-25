import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('meeting transcript modal styles', () => {
  it('keeps attachment and result content bounded on desktop and narrow screens', async () => {
    const styles = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toContain('.atl-meeting-attachment-row');
    expect(styles).toContain('.atl-meeting-result-section');
    expect(styles).toContain('.atl-meeting-transcript-details pre');
    expect(styles).toMatch(/@media \(max-width: 560px\)[\s\S]*\.atl-meeting-attachment-row/u);
    expect(styles).toMatch(/overflow-wrap: anywhere/u);
    expect(styles).toMatch(/max-height:[^;]+;[\s\S]*overflow-y: auto/u);
  });
});
