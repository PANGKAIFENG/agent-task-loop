import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

function declarationsFor(css: string, selector: string): string {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter((match) => match[1]
      ?.split(',')
      .map((candidate) => candidate.trim())
      .includes(selector))
    .map((match) => match[2] ?? '')
    .join('\n');
}

describe('personal home heatmap styles', () => {
  it('keeps zero-value output and AI days neutral and colors only positive levels', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    for (const mode of ['outputs', 'ai']) {
      const zeroSelector = `.atl-contribution-day.atl-pulse-${mode}.atl-contribution-level-0`;
      expect(declarationsFor(css, zeroSelector), zeroSelector).not.toMatch(/background(?:-color)?\s*:/);

      for (const level of [1, 2, 3, 4]) {
        const selector = `.atl-contribution-day.atl-pulse-${mode}.atl-contribution-level-${level}`;
        expect(declarationsFor(css, selector), selector).toMatch(/background(?:-color)?\s*:/);
      }
    }
  });
});
