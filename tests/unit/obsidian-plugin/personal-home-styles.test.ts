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

function hasBalancedBlocks(css: string): boolean {
  let depth = 0;
  for (const character of css) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('personal home heatmap styles', () => {
  it('keeps the stylesheet block structure balanced', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(hasBalancedBlocks(css)).toBe(true);
  });

  it('keeps the approved purple command-center shell and overview grid hierarchy', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-home-app-shell'))
      .toMatch(/grid-template-columns\s*:\s*205px minmax\(0,\s*1fr\)/);
    expect(declarationsFor(css, '.atl-home-sidebar'))
      .toMatch(/background\s*:\s*rgba\(255,\s*255,\s*255,\s*\.52\)/);
    expect(declarationsFor(css, '.atl-home-tab[aria-pressed=\'true\']'))
      .toMatch(/background\s*:\s*var\(--atl-home-primary\)/);
    expect(declarationsFor(css, '.atl-home-focus-grid'))
      .toMatch(/grid-template-columns\s*:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(declarationsFor(css, '.atl-home-metric-grid'))
      .toMatch(/grid-template-columns\s*:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(declarationsFor(css, '.atl-home-overview-lower'))
      .toMatch(/grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(declarationsFor(css, '.atl-home-focus-card'))
      .toMatch(/min-height\s*:\s*132px/);
    expect(declarationsFor(css, '.atl-home-pulse'))
      .toMatch(/border-radius\s*:\s*10px/);
  });

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

  it('stacks dense overview grids when the Obsidian pane becomes narrow', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    for (const selector of [
      '.atl-home-focus-grid',
      '.atl-home-metric-grid',
      '.atl-home-overview-lower',
    ]) {
      expect(declarationsFor(css, selector), selector)
        .toMatch(/grid-template-columns\s*:\s*1fr/);
    }
  });
});
