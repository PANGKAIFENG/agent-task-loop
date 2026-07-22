import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const CALENDAR_SELECTOR_PREFIX =
  'body.atl-task-card-theme .tasknotes-plugin.advanced-calendar-view ';

function declarationsFor(css: string, selector: string): string {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    .filter((match) => match[1]
      ?.split(',')
      .map((candidate) => candidate.trim())
      .includes(selector))
    .map((match) => match[2] ?? '')
    .join('\n');
}

describe('calendar event layout styles', () => {
  it('contains long TaskNotes event titles inside ATL themed cards', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );
    const eventSelector = `${CALENDAR_SELECTOR_PREFIX}.fc-timegrid-event`;
    const clippingContainerSelectors = [
      '.fc-event-main',
      '.fc-event-main-frame',
      '.fc-event-title-container',
    ].map((selector) => `${CALENDAR_SELECTOR_PREFIX}${selector}`);
    const titleSelector = `${CALENDAR_SELECTOR_PREFIX}.fc-event-title`;

    const eventDeclarations = declarationsFor(css, eventSelector);
    expect(eventDeclarations, eventSelector).toContain('min-width: 0;');
    expect(eventDeclarations, eventSelector).not.toContain('overflow: hidden;');

    for (const selector of clippingContainerSelectors) {
      const declarations = declarationsFor(css, selector);
      expect(declarations, selector).toContain('min-width: 0;');
      expect(declarations, selector).toContain('overflow: hidden;');
    }

    const titleDeclarations = declarationsFor(css, titleSelector);
    expect(titleDeclarations, titleSelector).toContain('display: block;');
    expect(titleDeclarations, titleSelector).toContain('max-width: 100%;');
    expect(titleDeclarations, titleSelector).toContain('overflow: hidden;');
    expect(titleDeclarations, titleSelector).toContain('text-overflow: ellipsis;');
    expect(titleDeclarations, titleSelector).toContain('white-space: nowrap;');

    const calendarDeclarations = [
      eventDeclarations,
      ...clippingContainerSelectors.map((selector) => declarationsFor(css, selector)),
      titleDeclarations,
    ].join('\n');
    expect(calendarDeclarations).not.toMatch(
      /(?:^|;)\s*(?:position|pointer-events|color|background-color|border-color|width)\s*:/,
    );
  });
});
