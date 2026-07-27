import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('TaskNotes task brief action styles', () => {
  it('keeps the injected secondary action aligned without constraining the button bar', async () => {
    const styles = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(
      /\[data-atl-task-brief-action\][\s\S]*display:\s*inline-flex;/u,
    );
    expect(styles).toMatch(
      /\[data-atl-task-brief-action\][\s\S]*gap:\s*[^;]+;/u,
    );
    expect(styles).toMatch(
      /\.atl-task-brief-action__icon\s+svg[\s\S]*width:\s*16px;/u,
    );
    expect(styles).not.toMatch(
      /\.tn-task-modal__button-bar\s*\{[\s\S]*?(?:width|min-width|max-width):/u,
    );
  });
});
