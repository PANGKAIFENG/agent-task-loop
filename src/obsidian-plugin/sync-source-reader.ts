import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const SYNC_ROOT = '笔记同步助手';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_HEADER = /^####[^\n]*\n## 📅 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\n/gm;
const LOOKBACK_DAYS = 13;
const IMAGE_CONTEXT_WINDOW_MS = 2 * 60 * 1000;

export interface SyncSourceRecord {
  fingerprint: string;
  sourceDate: string;
  sourceNote: string;
  recordedAt: string | null;
  content: string;
}

export interface SyncSourceReaderFileSystem {
  exists(relativePath: string): Promise<boolean>;
  listMarkdownFiles(relativeDirectory: string): Promise<string[]>;
  read(relativePath: string): Promise<string>;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((part) => part.type === type)?.value ?? ''
  );
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addUtcDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

export function sourceDateRange(
  now: Date,
  _lastSuccessfulScanAt: string | null,
  timeZone = DEFAULT_TIME_ZONE,
): string[] {
  const today = localDate(now, timeZone);
  const lookbackStart = addUtcDays(today, -LOOKBACK_DAYS);
  const dates: string[] = [];
  for (let date = lookbackStart; date <= today; date = addUtcDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function normalizedContent(content: string): string {
  return content
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function fingerprint(
  sourceNote: string,
  recordedAt: string | null,
  content: string,
): string {
  return createHash('sha256')
    .update(`${sourceNote}\0${recordedAt ?? ''}\0${normalizedContent(content)}`)
    .digest('hex');
}

interface ParsedRecord {
  recordedAt: string | null;
  content: string;
}

function parseAggregateRecords(content: string): ParsedRecord[] {
  const normalized = content.replace(/\r\n?/g, '\n');
  const headers = [...normalized.matchAll(TIMESTAMP_HEADER)];
  if (headers.length === 0) {
    const whole = normalizedContent(normalized);
    return whole === '' ? [] : [{ recordedAt: null, content: whole }];
  }

  const records = headers.flatMap((match, index) => {
    const date = match[1];
    const time = match[2];
    const contentStart = (match.index ?? 0) + match[0].length;
    const nextStart = headers[index + 1]?.index ?? normalized.length;
    const body = normalized
      .slice(contentStart, nextStart)
      .replace(/\n---\s*$/u, '');
    const recordContent = normalizedContent(body);
    return date !== undefined && time !== undefined && recordContent !== ''
      ? [{ recordedAt: `${date}T${time}+08:00`, content: recordContent }]
      : [];
  });
  return mergeAdjacentImageContext(records);
}

function containsImage(content: string): boolean {
  return /!\[\[[^\]]+\.(?:avif|gif|jpe?g|png|webp)(?:\|[^\]]*)?\]\]/iu.test(content)
    || /!\[[^\]]*\]\([^\n)]+\.(?:avif|gif|jpe?g|png|webp)(?:\?[^\n)]*)?\)/iu.test(content)
    || /(?:「|\[)?图片(?:」|\])?/u.test(content);
}

function recordedAtMillis(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldMergeImageContext(left: ParsedRecord, right: ParsedRecord): boolean {
  if (!containsImage(left.content) && !containsImage(right.content)) return false;
  const leftTime = recordedAtMillis(left.recordedAt);
  const rightTime = recordedAtMillis(right.recordedAt);
  return leftTime !== null
    && rightTime !== null
    && Math.abs(leftTime - rightTime) <= IMAGE_CONTEXT_WINDOW_MS;
}

function mergeAdjacentImageContext(records: readonly ParsedRecord[]): ParsedRecord[] {
  const merged: ParsedRecord[] = [];
  for (const record of records) {
    const previous = merged.at(-1);
    if (previous === undefined || !shouldMergeImageContext(previous, record)) {
      merged.push({ ...record });
      continue;
    }
    previous.content = normalizedContent(`${previous.content}\n\n${record.content}`);
  }
  return merged;
}

function isDirectMarkdownFile(path: string, directory: string): boolean {
  return posix.dirname(path) === directory && posix.extname(path).toLowerCase() === '.md';
}

export async function readSyncSourceRecords(input: {
  fileSystem: SyncSourceReaderFileSystem;
  now: Date;
  lastSuccessfulScanAt: string | null;
}): Promise<{ filesScanned: number; records: SyncSourceRecord[] }> {
  const paths: string[] = [];
  for (const sourceDate of sourceDateRange(input.now, input.lastSuccessfulScanAt)) {
    const directory = `${SYNC_ROOT}/${sourceDate}`;
    if (!(await input.fileSystem.exists(directory))) continue;
    const listed = await input.fileSystem.listMarkdownFiles(directory);
    paths.push(...listed.filter((path) => isDirectMarkdownFile(path, directory)));
  }

  const uniquePaths = [...new Set(paths)].sort();
  const records: SyncSourceRecord[] = [];
  for (const sourceNote of uniquePaths) {
    const sourceDate = sourceNote.split('/').at(-2) ?? '';
    if (!DATE_PATTERN.test(sourceDate)) continue;
    const content = await input.fileSystem.read(sourceNote);
    for (const parsed of parseAggregateRecords(content)) {
      records.push({
        fingerprint: fingerprint(sourceNote, parsed.recordedAt, parsed.content),
        sourceDate,
        sourceNote,
        recordedAt: parsed.recordedAt,
        content: parsed.content,
      });
    }
  }

  return { filesScanned: uniquePaths.length, records };
}
