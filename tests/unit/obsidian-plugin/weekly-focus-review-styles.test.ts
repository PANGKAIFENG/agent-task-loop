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

describe('weekly focus review styles', () => {
  it('keeps the Personal Home entry compact and its controls stable', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-focus-review-home-states'))
      .toMatch(/grid-template-columns\s*:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-home-state'))
      .toMatch(/min-width\s*:\s*0/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-home-state'))
      .toMatch(/text-align\s*:\s*left/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-home-state span'))
      .toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it('uses a separate scrollable review surface without horizontal overflow', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(declarationsFor(css, '.atl-weekly-focus-review-modal'))
      .toMatch(/width\s*:\s*min\(960px,\s*calc\(100vw\s*-\s*48px\)\)/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-modal .modal-content'))
      .toMatch(/overflow-y\s*:\s*auto/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-focus-card'))
      .toMatch(/grid-template-columns\s*:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-field input'))
      .toMatch(/min-width\s*:\s*0/);
    expect(declarationsFor(css, '.atl-weekly-focus-review-field input'))
      .toMatch(/width\s*:\s*100%/);
  });

  it('stacks review content and full-width actions at 390px', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );
    const narrow = css.slice(css.indexOf('@media (max-width: 520px)'));

    expect(narrow).toMatch(/\.atl-weekly-focus-review-modal[\s\S]*width\s*:\s*calc\(100vw\s*-\s*16px\)/);
    expect(narrow).toMatch(/\.atl-weekly-focus-review-focus-card[\s\S]*grid-template-columns\s*:\s*1fr/);
    expect(narrow).toMatch(/\.atl-weekly-focus-review-assignment-row[\s\S]*grid-template-columns\s*:\s*1fr/);
    expect(narrow).toMatch(/\.atl-weekly-focus-review-actions[\s\S]*grid-template-columns\s*:\s*1fr/);
  });
});
