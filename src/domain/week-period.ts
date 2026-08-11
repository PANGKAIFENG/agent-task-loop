export interface IsoWeekPeriod {
  weekKey: string;
  startDate: string;
  endDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(
    parts.find((part) => part.type === type)?.value,
  );
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
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
