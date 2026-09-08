import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('weekly focus review plugin integration', () => {
  it('assembles the T7 view from read-only facts and the authorized weekly-focus gateway', async () => {
    const source = await readFile(
      new URL('../../../src/obsidian-plugin/main.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('new WeeklyFocusReviewContributionView');
    expect(source).toContain('queryWeeklyFocusReviewIndex({');
    expect(source).toContain('queryWeeklyFocusProgress({');
    expect(source).toContain('const weeklyReports = {');
    expect(source).toContain('new MarkdownWeeklyReportRepository(paths.root).listCurrent()');
    expect(source).toMatch(
      /saveWeeklyFocusAttribution\(\s*gateway,\s*weeklyReports,\s*clock,\s*input,\s*timeZone,\s*\)/u,
    );
    expect(source).toMatch(
      /saveWeeklyFocusReview\(\s*gateway,\s*weeklyReports,\s*clock,\s*input,\s*timeZone,\s*\)/u,
    );
    expect(source).toMatch(/listPaths:\s*async\s*\(\)\s*=>/);
    expect(source).toContain('canManageVault: () => this.settings.allowVaultManagement');
  });
});
