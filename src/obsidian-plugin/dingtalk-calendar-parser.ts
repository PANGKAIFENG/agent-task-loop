import { createHash } from 'node:crypto';

import ICAL from 'ical.js';

import type { DingTalkRemoteSnapshot } from './dingtalk-calendar-types.js';

export interface DingTalkCalendarObject {
  href: string;
  etag: string | null;
  data: string;
}

export interface DingTalkCalendarOccurrence {
  eventKeyHash: string;
  remoteUid: string;
  recurrenceId: string | null;
  href: string;
  etag: string | null;
  snapshotHash: string;
  snapshot: DingTalkRemoteSnapshot;
}

export interface DingTalkCalendarParseIssue {
  href: string;
  code: 'invalid_icalendar' | 'occurrence_limit';
}

export interface DingTalkCalendarParseResult {
  occurrences: DingTalkCalendarOccurrence[];
  issues: DingTalkCalendarParseIssue[];
}

const MAX_OCCURRENCES_PER_RESOURCE = 10_000;

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function formattedTime(time: InstanceType<typeof ICAL.Time>): string {
  const date = `${String(time.year).padStart(4, '0')}-${twoDigits(time.month)}-${twoDigits(time.day)}`;
  if (time.isDate) return date;
  const offsetSeconds = time.utcOffset();
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absoluteMinutes = Math.floor(Math.abs(offsetSeconds) / 60);
  return `${date}T${twoDigits(time.hour)}:${twoDigits(time.minute)}:${twoDigits(time.second)}`
    + `${sign}${twoDigits(Math.floor(absoluteMinutes / 60))}:${twoDigits(absoluteMinutes % 60)}`;
}

function stringProperty(event: InstanceType<typeof ICAL.Event>, name: string): string | null {
  const value = event.component.getFirstPropertyValue(name);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function snapshot(
  event: InstanceType<typeof ICAL.Event>,
  start: InstanceType<typeof ICAL.Time>,
  end: InstanceType<typeof ICAL.Time>,
): DingTalkRemoteSnapshot {
  return {
    title: stringProperty(event, 'summary') ?? '未命名日程',
    start: formattedTime(start),
    end: formattedTime(end),
    allDay: start.isDate,
    description: stringProperty(event, 'description'),
    location: stringProperty(event, 'location'),
    state: stringProperty(event, 'status')?.toUpperCase() === 'CANCELLED'
      ? 'cancelled'
      : 'active',
  };
}

function intersectsWindow(
  start: InstanceType<typeof ICAL.Time>,
  end: InstanceType<typeof ICAL.Time>,
  window: { start: Date; end: Date },
): boolean {
  const startMillis = start.toUnixTime() * 1000;
  const endMillis = end.toUnixTime() * 1000;
  return startMillis < window.end.getTime()
    && Math.max(endMillis, startMillis + 1) > window.start.getTime();
}

function occurrence(
  calendarId: string,
  object: DingTalkCalendarObject,
  event: InstanceType<typeof ICAL.Event>,
  start: InstanceType<typeof ICAL.Time>,
  end: InstanceType<typeof ICAL.Time>,
  recurrenceId: string | null,
): DingTalkCalendarOccurrence {
  const remoteSnapshot = snapshot(event, start, end);
  const identityPart = recurrenceId ?? remoteSnapshot.start;
  return {
    eventKeyHash: digest(`${calendarId}|${event.uid}|${identityPart}`),
    remoteUid: event.uid,
    recurrenceId,
    href: object.href,
    etag: object.etag,
    snapshotHash: digest(JSON.stringify(remoteSnapshot)),
    snapshot: remoteSnapshot,
  };
}

function registerTimezones(component: InstanceType<typeof ICAL.Component>): void {
  for (const timezone of component.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(timezone);
  }
}

function parseObject(input: {
  calendarId: string;
  object: DingTalkCalendarObject;
  window: { start: Date; end: Date };
}): { occurrences: DingTalkCalendarOccurrence[]; limitReached: boolean } {
  const component = new ICAL.Component(ICAL.parse(input.object.data));
  if (component.name !== 'vcalendar') throw new Error('invalid root');
  registerTimezones(component);
  const components = component.getAllSubcomponents('vevent');
  if (components.length === 0) throw new Error('missing VEVENT');
  const events = components.map((value) => new ICAL.Event(value));
  const masters = events.filter((event) => !event.isRecurrenceException());
  const masterUids = new Set(masters.map((event) => event.uid));
  const occurrences: DingTalkCalendarOccurrence[] = [];
  let expanded = 0;

  for (const event of masters) {
    if (!event.isRecurring()) {
      if (intersectsWindow(event.startDate, event.endDate, input.window)) {
        occurrences.push(occurrence(
          input.calendarId,
          input.object,
          event,
          event.startDate,
          event.endDate,
          null,
        ));
      }
      continue;
    }

    const iterator = event.iterator();
    while (expanded < MAX_OCCURRENCES_PER_RESOURCE) {
      const next = iterator.next() as InstanceType<typeof ICAL.Time> | null | undefined;
      if (next === null || next === undefined) break;
      if (next.toUnixTime() * 1000 >= input.window.end.getTime()) break;
      expanded += 1;
      const details = event.getOccurrenceDetails(next);
      if (!intersectsWindow(details.startDate, details.endDate, input.window)) continue;
      occurrences.push(occurrence(
        input.calendarId,
        input.object,
        details.item,
        details.startDate,
        details.endDate,
        formattedTime(details.recurrenceId),
      ));
    }
  }

  for (const event of events) {
    if (!event.isRecurrenceException() || masterUids.has(event.uid)) continue;
    if (!intersectsWindow(event.startDate, event.endDate, input.window)) continue;
    occurrences.push(occurrence(
      input.calendarId,
      input.object,
      event,
      event.startDate,
      event.endDate,
      formattedTime(event.recurrenceId),
    ));
  }

  return {
    occurrences,
    limitReached: expanded >= MAX_OCCURRENCES_PER_RESOURCE,
  };
}

export function parseDingTalkCalendarObjects(input: {
  calendarId: string;
  objects: readonly DingTalkCalendarObject[];
  window: { start: Date; end: Date };
}): DingTalkCalendarParseResult {
  if (
    !Number.isFinite(input.window.start.getTime())
    || !Number.isFinite(input.window.end.getTime())
    || input.window.start >= input.window.end
  ) {
    throw new Error('Invalid calendar parse window');
  }
  const byIdentity = new Map<string, DingTalkCalendarOccurrence>();
  const issues: DingTalkCalendarParseIssue[] = [];
  for (const object of input.objects) {
    try {
      const parsed = parseObject({
        calendarId: input.calendarId,
        object,
        window: input.window,
      });
      for (const value of parsed.occurrences) {
        byIdentity.set(value.eventKeyHash, value);
      }
      if (parsed.limitReached) {
        issues.push({ href: object.href, code: 'occurrence_limit' });
      }
    } catch {
      issues.push({ href: object.href, code: 'invalid_icalendar' });
    }
  }
  return {
    occurrences: [...byIdentity.values()].sort((left, right) => (
      left.snapshot.start.localeCompare(right.snapshot.start)
      || left.eventKeyHash.localeCompare(right.eventKeyHash)
    )),
    issues,
  };
}
