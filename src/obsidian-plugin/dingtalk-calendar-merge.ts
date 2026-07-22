import type { TaskDocument } from '../storage/frontmatter.js';
import type { DingTalkRemoteSnapshot } from './dingtalk-calendar-types.js';

const MANAGED_START = '<!-- ATL_DINGTALK_MANAGED_START -->';
const MANAGED_END = '<!-- ATL_DINGTALK_MANAGED_END -->';
const MANAGED_PATTERN = /<!-- ATL_DINGTALK_MANAGED_START -->[\s\S]*?<!-- ATL_DINGTALK_MANAGED_END -->/u;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface DingTalkCalendarMergeResult {
  document: TaskDocument;
  changed: boolean;
  overriddenLocalFields: string[];
  cancelledBySync: boolean;
}

function remoteValueChanged<T>(previous: T | null, next: T): boolean {
  return previous === null || previous !== next;
}

function timeEstimate(snapshot: DingTalkRemoteSnapshot): number | null {
  if (snapshot.allDay || snapshot.end === null) return null;
  const start = Date.parse(snapshot.start);
  const end = Date.parse(snapshot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 60_000));
}

function safeManagedText(value: string): string {
  return value.replaceAll('<!-- ATL_DINGTALK_', '&lt;!-- ATL_DINGTALK_');
}

function managedRegion(snapshot: DingTalkRemoteSnapshot): string {
  const lines = [
    MANAGED_START,
    '来源：钉钉日历',
  ];
  if (snapshot.location !== null) {
    lines.push(`地点：${safeManagedText(snapshot.location)}`);
  }
  lines.push(`远端状态：${snapshot.state}`);
  if (snapshot.description !== null) {
    lines.push('', safeManagedText(snapshot.description));
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

function updateManagedRegion(body: string, snapshot: DingTalkRemoteSnapshot): string {
  const region = managedRegion(snapshot);
  if (MANAGED_PATTERN.test(body)) return body.replace(MANAGED_PATTERN, region);
  const suffix = body.trim() === ''
    ? '<!-- 用户可在此处追加本地备注、准备事项和复盘记录。 -->\n'
    : body.replace(/^\n+/u, '');
  return `\n\n${region}\n\n${suffix}`;
}

function localDate(syncTime: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(syncTime).map((part) => [part.type, part.value]));
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
}

function eventHasEnded(
  snapshot: DingTalkRemoteSnapshot,
  syncTime: Date,
  timeZone: string,
): boolean {
  if (snapshot.end === null || !Number.isFinite(syncTime.getTime())) return false;
  if (snapshot.allDay) {
    if (
      !DATE_ONLY_PATTERN.test(snapshot.start)
      || !DATE_ONLY_PATTERN.test(snapshot.end)
      || snapshot.end <= snapshot.start
    ) return false;
    return localDate(syncTime, timeZone) >= snapshot.end;
  }
  const start = Date.parse(snapshot.start);
  const end = Date.parse(snapshot.end);
  return Number.isFinite(start)
    && Number.isFinite(end)
    && end > start
    && end <= syncTime.getTime();
}

function shouldAutoComplete(
  snapshot: DingTalkRemoteSnapshot,
  status: unknown,
  syncTime: Date,
  timeZone: string,
): boolean {
  if (snapshot.state !== 'active') return false;
  if (status === 'done' || status === 'cancelled') return false;
  return eventHasEnded(snapshot, syncTime, timeZone);
}

function newDocument(
  snapshot: DingTalkRemoteSnapshot,
  syncTime: Date,
  timeZone: string,
): TaskDocument {
  const estimate = timeEstimate(snapshot);
  const initialStatus = snapshot.state === 'cancelled' ? 'cancelled' : 'inbox';
  return {
    data: {
      type: 'task',
      title: snapshot.title,
      status: shouldAutoComplete(snapshot, initialStatus, syncTime, timeZone)
        ? 'done'
        : initialStatus,
      scheduled: snapshot.start,
      ...(estimate === null ? {} : { timeEstimate: estimate }),
      origin: 'dingtalk_caldav',
      tags: ['dingtalk_calendar'],
      dingtalk_state: snapshot.state,
    },
    body: updateManagedRegion('', snapshot),
  };
}

export function mergeDingTalkOccurrence(input: {
  current: TaskDocument | null;
  previousRemote: DingTalkRemoteSnapshot | null;
  nextRemote: DingTalkRemoteSnapshot;
  cancelledBySync: boolean;
  syncTime: Date;
  timeZone: string;
}): DingTalkCalendarMergeResult {
  if (input.current === null || input.previousRemote === null) {
    const document = newDocument(input.nextRemote, input.syncTime, input.timeZone);
    return {
      document,
      changed: true,
      overriddenLocalFields: [],
      cancelledBySync: input.nextRemote.state === 'cancelled',
    };
  }

  const data = { ...input.current.data };
  let body = input.current.body;
  let cancelledBySync = input.cancelledBySync;
  const overriddenLocalFields: string[] = [];
  const previous = input.previousRemote;
  const next = input.nextRemote;

  if (remoteValueChanged(previous.title, next.title)) {
    if (data.title !== previous.title) overriddenLocalFields.push('title');
    data.title = next.title;
  }
  if (remoteValueChanged(previous.start, next.start)) {
    if (data.scheduled !== previous.start) overriddenLocalFields.push('scheduled');
    data.scheduled = next.start;
  }
  const previousEstimate = timeEstimate(previous);
  const nextEstimate = timeEstimate(next);
  const durationChanged = previousEstimate !== nextEstimate
    || previous.allDay !== next.allDay;
  if (durationChanged) {
    if (data.timeEstimate !== previousEstimate) {
      overriddenLocalFields.push('timeEstimate');
    }
    if (nextEstimate === null) delete data.timeEstimate;
    else data.timeEstimate = nextEstimate;
  }
  if (remoteValueChanged(previous.state, next.state)) {
    data.dingtalk_state = next.state;
    if (next.state === 'cancelled') {
      data.status = 'cancelled';
      cancelledBySync = true;
    } else {
      if (cancelledBySync && data.status === 'cancelled') data.status = 'inbox';
      cancelledBySync = false;
    }
  }
  if (
    previous.location !== next.location
    || previous.description !== next.description
    || previous.state !== next.state
  ) {
    body = updateManagedRegion(body, next);
  }
  if (shouldAutoComplete(
    next,
    input.current.data.status,
    input.syncTime,
    input.timeZone,
  )) {
    data.status = 'done';
  }

  const document = { data, body };
  return {
    document,
    changed: JSON.stringify(document.data) !== JSON.stringify(input.current.data)
      || document.body !== input.current.body,
    overriddenLocalFields,
    cancelledBySync,
  };
}
