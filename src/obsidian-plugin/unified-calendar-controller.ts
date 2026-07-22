import { lstat, realpath, stat } from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

import { parse } from 'yaml';

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

function validateBase(content: string): void {
  try {
    const document = parse(content) as unknown;
    if (document === null || typeof document !== 'object') throw new Error('invalid');
    if (!Array.isArray((document as { views?: unknown }).views)) throw new Error('invalid');
  } catch {
    throw new UnifiedCalendarError('统一日历文件格式无效，ATL 未做任何修改。');
  }
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
      validateBase(await this.fileSystem.read(path));
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
      validateBase(await this.fileSystem.read(path));
      return { path, created: false };
    }
  }
}
