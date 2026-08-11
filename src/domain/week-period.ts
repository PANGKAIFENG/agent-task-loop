export interface IsoWeekPeriod {
  weekKey: string;
  startDate: string;
  endDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function calendarDateInTimeZone(
  value: Date | string,
  timeZone: string,
): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(instant.getTime())) throw new Error('时间无效');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) throw new Error('无法解析时区日期');
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function localDate(now: Date, timeZone: string): Date {
  const [year, month, day] = calendarDateInTimeZone(now, timeZone)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year!, month! - 1, day));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function mondayOf(value: Date): Date {
  const weekday = value.getUTCDay() === 0 ? 7 : value.getUTCDay();
  return new Date(value.getTime() - (weekday - 1) * DAY_MS);
}

export function currentIsoWeekPeriod(
  now: Date,
  timeZone: string,
): IsoWeekPeriod {
  const start = mondayOf(localDate(now, timeZone));
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const thursday = new Date(start.getTime() + 3 * DAY_MS);
  const weekYear = thursday.getUTCFullYear();
  const firstWeekStart = mondayOf(new Date(Date.UTC(weekYear, 0, 4)));
  const weekNumber = Math.floor(
    (start.getTime() - firstWeekStart.getTime()) / (7 * DAY_MS),
  ) + 1;
  return {
    weekKey: `${weekYear}-W${String(weekNumber).padStart(2, '0')}`,
    startDate: isoDate(start),
    endDate: isoDate(end),
  };
}

export function isoWeekPeriodForOccurredAt(
  occurredAt: string,
  timeZone: string,
): IsoWeekPeriod {
  const instant = new Date(occurredAt);
  if (!Number.isFinite(instant.getTime())) throw new Error('工作进展发生时间无效');
  return currentIsoWeekPeriod(instant, timeZone);
}
