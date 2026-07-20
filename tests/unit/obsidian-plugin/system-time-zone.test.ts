import { describe, expect, it } from 'vitest';

import { resolveSystemTimeZone } from '../../../src/obsidian-plugin/system-time-zone.js';

describe('resolveSystemTimeZone', () => {
  it('uses the current system time zone and falls back safely', () => {
    expect(resolveSystemTimeZone(() => 'America/New_York')).toBe('America/New_York');
    expect(resolveSystemTimeZone(() => '')).toBe('UTC');
  });
});
