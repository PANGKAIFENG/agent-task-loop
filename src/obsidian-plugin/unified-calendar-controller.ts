import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

import { parse, stringify } from 'yaml';

export const ATL_UNIFIED_CALENDAR_PATH = '10_Tasks/Views/统一日历.base';

const UNIFIED_CALENDAR_BASE = `filters:
  and:
    - note["type"] == "task"
properties:
  scheduled:
    displayName: 计划时间
  due:
    displayName: 截止时间
  project_id:
    displayName: 项目
  priority:
    displayName: 优先级
views:
  - type: tasknotesCalendar
    name: 统一日历
    order:
      - project_id
      - priority
      - scheduled
      - due
      - file.name
    options:
      showScheduled: true
      showDue: true
      showRecurring: true
      showTimeEntries: true
      showTimeblocks: true
      showPropertyBasedEvents: true
      createDailyNotesFromDateLinks: true
      calendarView: timeGridWeek
      customDayCount: 3
      firstDay: 1
      slotDuration: 00:30:00
      slotEventOverlap: false
  - type: tasknotesTaskList
    name: 待排期任务
    filters:
      and:
        - status != "done"
        - status != "cancelled"
        - (scheduled == false) || (scheduled == null)
    order:
      - status
      - project_id
      - priority
      - due
      - file.name
    sort:
      - column: status
        direction: ASC
`;

export interface UnifiedCalendarFileSystem {
  mkdir(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

export interface UnifiedCalendarResult {
  path: string;
  created: boolean;
}

export class UnifiedCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedCalendarError';
  }
}

function parseBase(content: string): Record<string, unknown> & { views: unknown[] } {
  try {
    const document = parse(content) as unknown;
    if (document === null || typeof document !== 'object') throw new Error('invalid');
    const views = (document as { views?: unknown }).views;
    if (!Array.isArray(views)) throw new Error('invalid');
    return document as Record<string, unknown> & { views: unknown[] };
  } catch {
    throw new UnifiedCalendarError('统一日历文件格式无效，ATL 未做任何修改。');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function migratedCalendarContent(content: string): string | undefined {
  const document = parseBase(content);
  const calendars = document.views.filter((view): view is Record<string, unknown> => (
    isRecord(view)
    && view.type === 'tasknotesCalendar'
    && view.name === '统一日历'
  ));
  if (calendars.length !== 1) return undefined;

  const calendar = calendars[0];
  if (calendar === undefined) return undefined;
  const options = calendar.options;
  if (options !== undefined && !isRecord(options)) {
    throw new UnifiedCalendarError('统一日历文件格式无效，ATL 未做任何修改。');
  }
  if (isRecord(options) && options.slotEventOverlap === false) return undefined;

  calendar.options = {
    ...(isRecord(options) ? options : {}),
    slotEventOverlap: false,
  };
  return stringify(document, { lineWidth: 0 });
}

function pathSegments(vaultRoot: string, targetDirectory: string): string[] {
  const difference = relative(vaultRoot, targetDirectory);
  return difference.split(sep).filter((segment) => segment !== '');
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function canonicalVaultRoot(vaultRoot: string): Promise<string> {
  try {
    const canonical = await realpath(vaultRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not directory');
    return canonical;
  } catch {
    throw new UnifiedCalendarError('当前 Vault 路径无效。');
  }
}

export async function replaceFileIfUnchanged(
  vaultRoot: string,
  path: string,
  expectedContent: string,
  replacementContent: string,
): Promise<boolean> {
  let temporaryHandle: FileHandle | undefined;
  let targetHandle: FileHandle | undefined;
  let temporaryPath: string | undefined;
  try {
    const root = await realpath(vaultRoot);
    if (!(await stat(root)).isDirectory() || !isAbsolute(path)) return false;
    const parent = await realpath(dirname(path));
    if (!isWithin(root, parent) || !(await stat(parent)).isDirectory()) return false;

    temporaryPath = join(parent, `.atl-calendar-${randomUUID()}.tmp`);
    temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    if (!(await temporaryHandle.stat()).isFile()) return false;
    await temporaryHandle.writeFile(replacementContent, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    const canonicalTarget = join(parent, basename(path));
    targetHandle = await open(
      canonicalTarget,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    if (!(await targetHandle.stat()).isFile()) return false;
    if (await targetHandle.readFile('utf8') !== expectedContent) return false;
    await targetHandle.close();
    targetHandle = undefined;

    await rename(temporaryPath, canonicalTarget);
    temporaryPath = undefined;
    return true;
  } catch (error) {
    if (
      isFileSystemError(error, 'ENOENT')
      || isFileSystemError(error, 'ELOOP')
      || isFileSystemError(error, 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  } finally {
    await targetHandle?.close();
    await temporaryHandle?.close();
    if (temporaryPath !== undefined) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function migrateExistingCalendar(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  const migrated = migratedCalendarContent(content);
  if (migrated === undefined) return;
  if (!(await replaceFileIfUnchanged(root, path, content, migrated))) {
    throw new UnifiedCalendarError(
      '统一日历在升级期间发生变化，ATL 未覆盖你的修改，请重试。',
    );
  }
}

async function safeExistingPath(
  path: string,
  root: string,
  expected: 'directory' | 'file',
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('symlink');
    if (expected === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new Error('unexpected file type');
    }
    if (!isWithin(root, await realpath(path))) throw new Error('outside vault');
    return true;
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return false;
    throw new UnifiedCalendarError('统一日历路径不安全，ATL 未做任何修改。');
  }
}

export class UnifiedCalendarController {
  constructor(private readonly fileSystem: UnifiedCalendarFileSystem) {}

  async ensure(vaultRoot: string): Promise<UnifiedCalendarResult> {
    const root = await canonicalVaultRoot(vaultRoot);
    const path = join(vaultRoot, ATL_UNIFIED_CALENDAR_PATH);
    if (await safeExistingPath(path, root, 'file')) {
      const content = await this.fileSystem.read(path);
      await migrateExistingCalendar(root, path, content);
      return { path, created: false };
    }

    let current = vaultRoot;
    for (const segment of pathSegments(vaultRoot, dirname(path))) {
      current = join(current, segment);
      if (!(await safeExistingPath(current, root, 'directory'))) {
        try {
          await this.fileSystem.mkdir(current);
        } catch (error) {
          if (!isFileSystemError(error, 'EEXIST')) throw error;
        }
        if (!(await safeExistingPath(current, root, 'directory'))) {
          throw new UnifiedCalendarError('统一日历路径不安全，ATL 未做任何修改。');
        }
      }
    }
    try {
      await this.fileSystem.create(path, UNIFIED_CALENDAR_BASE);
      await safeExistingPath(path, root, 'file');
      return { path, created: true };
    } catch (error) {
      if (!isFileSystemError(error, 'EEXIST')) throw error;
      if (!(await safeExistingPath(path, root, 'file'))) {
        throw new UnifiedCalendarError('统一日历路径不安全，ATL 未做任何修改。');
      }
      const content = await this.fileSystem.read(path);
      await migrateExistingCalendar(root, path, content);
      return { path, created: false };
    }
  }
}
