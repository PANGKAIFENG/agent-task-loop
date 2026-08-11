import { describe, expect, it } from 'vitest';

import {
  currentIsoWeekPeriod,
  isoWeekPeriodForOccurredAt,
} from '../../../src/domain/week-period.js';

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

  it('derives a historical progress week from when the progress occurred', () => {
    expect(isoWeekPeriodForOccurredAt(
      '2026-07-29T23:30:00+08:00',
      'Asia/Shanghai',
    )).toEqual({
      weekKey: '2026-W31',
      startDate: '2026-07-27',
      endDate: '2026-08-02',
    });
  });

  it('rejects an invalid progress occurrence time', () => {
    expect(() => isoWeekPeriodForOccurredAt('not-a-date', 'Asia/Shanghai'))
      .toThrow('工作进展发生时间无效');
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
