import YAML from 'yaml';

export const WEEKLY_COACH_SOURCES = [
  '目标',
  '项目',
  '任务',
  '日历',
  '周复盘',
  '笔记同步助手',
  '每日所思',
] as const;

export type WeeklyCoachSource = typeof WEEKLY_COACH_SOURCES[number];

export interface WeeklyCoachContextDocument {
  source: WeeklyCoachSource;
  path: string;
  content: string;
}

export interface WeeklyCoachContext {
  authorizedSources: WeeklyCoachSource[];
  documents: WeeklyCoachContextDocument[];
  omittedCount: number;
  readFailures: Array<Pick<WeeklyCoachContextDocument, 'source' | 'path'>>;
  truncatedDocuments: Array<Pick<WeeklyCoachContextDocument, 'source' | 'path'>>;
  totalCharacters: number;
}

export interface WeeklyCoachContextGateway {
  listMarkdownPaths(): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface WeeklyCoachContextOptions {
  now?: Date;
}

const MAX_DOCUMENTS_PER_SOURCE = 10;
const MAX_DOCUMENT_CHARACTERS = 6_000;
const MAX_TOTAL_CHARACTERS = 48_000;

function isSource(value: unknown): value is WeeklyCoachSource {
  return WEEKLY_COACH_SOURCES.includes(value as WeeklyCoachSource);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function sourceForPath(path: string): WeeklyCoachSource | null {
  const normalized = normalizePath(path);
  if (normalized.startsWith('笔记同步助手/')) return '笔记同步助手';
  if (
    normalized.startsWith('日志/每日所思/02_每周复盘/')
    || normalized.startsWith('05_Reviews/Weekly/')
  ) return '周复盘';
  if (normalized.startsWith('日志/每日所思/')) return '每日所思';
  if (
    normalized.startsWith('02_Projects/')
    || normalized.startsWith('10_Tasks/Projects/')
    || normalized.startsWith('Projects/')
  ) return '项目';
  if (
    normalized.startsWith('10_Tasks/Inbox/')
    || normalized.startsWith('10_Tasks/Active/')
  ) return '任务';
  if (
    normalized.startsWith('01_Areas/')
    || normalized === '07_System/Agent_Context/长期目标.md'
  ) return '目标';
  if (normalized.startsWith('TaskNotes/')) return '日历';
  return null;
}

function scheduledTime(raw: string): number | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/u.exec(raw);
  if (match === null) return null;
  try {
    const parsed: unknown = YAML.parse(match[1] ?? '');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)['scheduled'];
    if (typeof value !== 'string' && !(value instanceof Date)) return null;
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

export async function collectWeeklyCoachContext(
  gateway: WeeklyCoachContextGateway,
  selectedSources: readonly unknown[],
  options: WeeklyCoachContextOptions = {},
): Promise<WeeklyCoachContext> {
  const authorizedSources = [...new Set(selectedSources.filter(isSource))];
  const authorized = new Set(authorizedSources);
  const paths = [...new Set(await gateway.listMarkdownPaths())]
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .map(normalizePath)
    .sort((left, right) => right.localeCompare(left, 'zh-CN'));
  const candidates = paths.map((path) => ({ path, source: sourceForPath(path) }))
    .filter((entry): entry is { path: string; source: WeeklyCoachSource } => (
      entry.source !== null && authorized.has(entry.source)
    ));

  const now = options.now?.getTime() ?? Date.now();
  const calendarContent = new Map<string, string>();
  const calendarTimes = new Map<string, number>();
  await Promise.all(candidates
    .filter(({ source }) => source === '日历')
    .map(async ({ path }) => {
      try {
        const raw = await gateway.read(path);
        calendarContent.set(path, raw);
        const timestamp = scheduledTime(raw);
        if (timestamp !== null) calendarTimes.set(path, timestamp);
      } catch {
        // Selected unreadable candidates are reported by the normal read path below.
      }
    }));
  candidates.sort((left, right) => {
    if (left.source === '日历' && right.source === '日历') {
      const leftDistance = Math.abs((calendarTimes.get(left.path) ?? Number.POSITIVE_INFINITY) - now);
      const rightDistance = Math.abs((calendarTimes.get(right.path) ?? Number.POSITIVE_INFINITY) - now);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    }
    return right.path.localeCompare(left.path, 'zh-CN');
  });

  const counts = new Map<WeeklyCoachSource, number>();
  const documents: WeeklyCoachContextDocument[] = [];
  const readFailures: Array<Pick<WeeklyCoachContextDocument, 'source' | 'path'>> = [];
  const truncatedDocuments: Array<Pick<WeeklyCoachContextDocument, 'source' | 'path'>> = [];
  let omittedCount = 0;
  let totalCharacters = 0;
  for (const candidate of candidates) {
    const count = counts.get(candidate.source) ?? 0;
    if (count >= MAX_DOCUMENTS_PER_SOURCE) {
      omittedCount += 1;
      continue;
    }
    let raw: string;
    try {
      raw = calendarContent.get(candidate.path) ?? await gateway.read(candidate.path);
    } catch {
      readFailures.push(candidate);
      continue;
    }
    const content = raw.slice(0, MAX_DOCUMENT_CHARACTERS);
    if (totalCharacters + content.length > MAX_TOTAL_CHARACTERS) {
      omittedCount += 1;
      continue;
    }
    counts.set(candidate.source, count + 1);
    totalCharacters += content.length;
    documents.push({ ...candidate, content });
    if (raw.length > MAX_DOCUMENT_CHARACTERS) truncatedDocuments.push(candidate);
  }
  return {
    authorizedSources,
    documents,
    omittedCount,
    readFailures,
    truncatedDocuments,
    totalCharacters,
  };
}
