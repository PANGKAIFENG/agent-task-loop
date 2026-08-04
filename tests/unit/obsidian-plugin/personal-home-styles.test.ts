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

  it('lets the 26-week pulse calendar fill its available panel width', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-home-pulse-body'))
      .toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+220px/);
    expect(declarationsFor(css, '.atl-contribution-heatmap-scroll'))
      .toMatch(/min-height\s*:\s*164px/);
    expect(declarationsFor(css, '.atl-contribution-heatmap'))
      .toMatch(/grid-auto-columns\s*:\s*minmax\(12px,\s*1fr\)/);
    expect(declarationsFor(css, '.atl-contribution-heatmap'))
      .toMatch(/min-width\s*:\s*630px/);
    expect(declarationsFor(css, '.atl-contribution-heatmap'))
      .toMatch(/width\s*:\s*100%/);
    expect(declarationsFor(css, '.atl-contribution-day'))
      .toMatch(/width\s*:\s*100%/);
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

  it('styles trend hover feedback and whole-card metric actions', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-home-trends-heading'))
      .toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
    expect(declarationsFor(css, '.atl-contribution-chart-plot'))
      .toMatch(/position\s*:\s*relative/);
    expect(declarationsFor(css, '.atl-contribution-chart-tooltip'))
      .toMatch(/position\s*:\s*absolute/);
    expect(declarationsFor(css, '.atl-home-metric-cell'))
      .toMatch(/text-align\s*:\s*left/);
    expect(declarationsFor(css, '.atl-home-metric-cell'))
      .toMatch(/width\s*:\s*100%/);
    expect(declarationsFor(css, '.atl-home-metric-cell:hover'))
      .toMatch(/border-color\s*:/);
  });

  it('keeps historical completion repair compact and visually secondary', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-contribution-coverage-action'))
      .toMatch(/background\s*:\s*transparent/);
    expect(declarationsFor(css, '.atl-contribution-coverage-action'))
      .toMatch(/text-align\s*:\s*left/);
    expect(declarationsFor(css, '.atl-completion-backfill-row'))
      .toMatch(/grid-template-columns\s*:/);
    expect(declarationsFor(css, '.atl-completion-backfill-status'))
      .toMatch(/grid-column\s*:/);
  });

  it('sizes the weekly coach as a centered responsive Obsidian modal', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-coach-modal'))
      .toMatch(/max-width\s*:\s*960px/);
    expect(declarationsFor(css, '.atl-weekly-coach-modal'))
      .toMatch(/height\s*:\s*min\(700px,\s*calc\(100vh\s*-\s*48px\)\)/);
    expect(declarationsFor(css, '.atl-weekly-coach-content'))
      .toMatch(/grid-template-rows\s*:/);
    expect(declarationsFor(css, '.atl-weekly-coach-content'))
      .toMatch(/overflow\s*:\s*hidden/);
    expect(declarationsFor(css, '.atl-weekly-coach-main'))
      .toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1\.35fr\)\s+minmax\(300px,\s*0\.85fr\)/);
    expect(declarationsFor(css, '.atl-weekly-coach-conversation'))
      .toMatch(/overflow-y\s*:\s*auto/);
    expect(declarationsFor(css, '.atl-weekly-coach-draft-panel'))
      .toMatch(/overflow-y\s*:\s*auto/);
    expect(css)
      .toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*\.atl-weekly-coach-main[\s\S]*grid-template-columns\s*:\s*1fr/);
  });

  it('uses the confirmed restrained status and action colors', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-coach-draft-card'))
      .toMatch(/border-radius\s*:\s*8px/);
    expect(declarationsFor(css, '.atl-weekly-coach-model-status'))
      .toMatch(/color\s*:\s*#00a8c6/);
    expect(declarationsFor(css, '.atl-weekly-coach-card-heading .is-pending'))
      .toMatch(/color\s*:\s*#d97706/);
    expect(declarationsFor(css, '.atl-weekly-coach-footer .mod-cta'))
      .toMatch(/background\s*:\s*#6a00ff/);
  });

  it('keeps the weekly coach conversation primary while the draft is empty', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-coach-main.is-empty-draft'))
      .toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+minmax\(240px,\s*\.62fr\)/);
    expect(declarationsFor(css, '.atl-weekly-coach-main.has-draft-items'))
      .toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1\.35fr\)\s+minmax\(300px,\s*\.85fr\)/);
    expect(declarationsFor(css, '.atl-weekly-coach-main.is-empty-draft .atl-weekly-coach-draft-panel'))
      .toMatch(/background\s*:\s*var\(--background-primary-alt\)/);
  });

  it('pins the composer and presents AI progress as a lightweight inline row', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-coach-composer'))
      .toMatch(/position\s*:\s*sticky/);
    expect(declarationsFor(css, '.atl-weekly-coach-composer'))
      .toMatch(/bottom\s*:\s*0/);
    expect(declarationsFor(css, '.atl-weekly-coach-progress'))
      .toMatch(/grid-template-columns\s*:\s*auto minmax\(0,\s*1fr\) auto/);
    expect(declarationsFor(css, '.atl-weekly-coach-progress'))
      .toMatch(/background\s*:\s*transparent/);
    expect(declarationsFor(css, '.atl-weekly-coach-scroll-latest'))
      .toMatch(/position\s*:\s*absolute/);
  });

  it('keeps the weekly coach source controls visually collapsed while hidden', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-coach-source-list[hidden]'))
      .toMatch(/display\s*:\s*none/);
  });
});
