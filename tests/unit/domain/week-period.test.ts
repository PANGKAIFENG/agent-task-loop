import { describe, expect, it } from 'vitest';

import { currentIsoWeekPeriod } from '../../../src/domain/week-period.js';

describe('currentIsoWeekPeriod', () => {
  it('returns the Shanghai Monday-to-Sunday ISO week', () => {
    expect(currentIsoWeekPeriod(
      new Date('2026-08-11T16:30:00.000Z'),
      'Asia/Shanghai',
    )).toEqual({
      weekKey: '2026-W33',
      startDate: '2026-08-10',
      endDate: '2026-08-16',
    });
  });

  it('uses the ISO week-year across calendar year boundaries', () => {
    expect(currentIsoWeekPeriod(
      new Date('2025-12-31T12:00:00.000Z'),
      'Asia/Shanghai',
    )).toEqual({
      weekKey: '2026-W01',
      startDate: '2025-12-29',
      endDate: '2026-01-04',
    });
  });
});
