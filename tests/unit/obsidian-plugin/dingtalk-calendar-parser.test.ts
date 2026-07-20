import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseDingTalkCalendarObjects,
} from '../../../src/obsidian-plugin/dingtalk-calendar-parser.js';

async function fixture(name: string): Promise<string> {
  return readFile(resolve('tests/fixtures/dingtalk', name), 'utf8');
}

const window = {
  start: new Date('2026-07-20T00:00:00Z'),
  end: new Date('2026-10-18T00:00:00Z'),
};

describe('parseDingTalkCalendarObjects', () => {
  it('normalizes timed, all-day, cancelled, and escaped event fields', async () => {
    const result = parseDingTalkCalendarObjects({
      calendarId: 'primary',
      objects: [{ href: '/simple.ics', etag: 'etag-1', data: await fixture('simple-events.ics') }],
      window,
    });

    expect(result.issues).toEqual([]);
    expect(result.occurrences).toHaveLength(3);
    expect(result.occurrences[0]?.snapshot).toEqual({
      title: 'Roadmap, review',
      start: '2026-07-20T14:00:00+08:00',
      end: '2026-07-20T15:00:00+08:00',
      allDay: false,
      description: 'Synthetic line one\nSynthetic line two',
      location: 'Room A',
      state: 'active',
    });
    expect(result.occurrences[1]?.snapshot).toMatchObject({
      start: '2026-07-21',
      end: '2026-07-22',
      allDay: true,
    });
    expect(result.occurrences[2]?.snapshot).toMatchObject({
      start: '2026-07-22T06:00:00+00:00',
      state: 'cancelled',
    });
  });

  it('expands recurrence, exclusions, additions, and an overridden occurrence', async () => {
    const result = parseDingTalkCalendarObjects({
      calendarId: 'primary',
      objects: [{ href: '/recurring.ics', etag: 'etag-r', data: await fixture('recurring-events.ics') }],
      window,
    });

    expect(result.issues).toEqual([]);
    expect(result.occurrences.map((occurrence) => ({
      title: occurrence.snapshot.title,
      start: occurrence.snapshot.start,
      recurrenceId: occurrence.recurrenceId,
    }))).toEqual([
      {
        title: 'Weekly review',
        start: '2026-07-20T10:00:00+08:00',
        recurrenceId: '2026-07-20T10:00:00+08:00',
      },
      {
        title: 'Moved weekly review',
        start: '2026-07-28T16:00:00+08:00',
        recurrenceId: '2026-07-27T10:00:00+08:00',
      },
      {
        title: 'Weekly review',
        start: '2026-08-10T10:00:00+08:00',
        recurrenceId: '2026-08-10T10:00:00+08:00',
      },
    ]);
  });

  it('keeps identity stable across href and title changes', async () => {
    const data = await fixture('simple-events.ics');
    const before = parseDingTalkCalendarObjects({
      calendarId: 'primary',
      objects: [{ href: '/before.ics', etag: 'etag-1', data }],
      window,
    }).occurrences[0];
    const after = parseDingTalkCalendarObjects({
      calendarId: 'primary',
      objects: [{
        href: '/after.ics',
        etag: 'etag-2',
        data: data.replace('SUMMARY:Roadmap\\, review', 'SUMMARY:Renamed review'),
      }],
      window,
    }).occurrences[0];

    expect(after?.eventKeyHash).toBe(before?.eventKeyHash);
    expect(after?.snapshotHash).not.toBe(before?.snapshotHash);
    expect(after?.snapshot.title).toBe('Renamed review');
  });

  it('reports a malformed resource without dropping valid resources', async () => {
    const result = parseDingTalkCalendarObjects({
      calendarId: 'primary',
      objects: [
        { href: '/broken.ics', etag: null, data: 'not an iCalendar document' },
        { href: '/simple.ics', etag: null, data: await fixture('simple-events.ics') },
      ],
      window,
    });

    expect(result.occurrences).toHaveLength(3);
    expect(result.issues).toEqual([{ href: '/broken.ics', code: 'invalid_icalendar' }]);
  });
});
