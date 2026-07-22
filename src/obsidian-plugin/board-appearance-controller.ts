import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { parse, stringify } from 'yaml';

export const ATL_BOARD_PATH = '10_Tasks/Views/任务总看板.base';
const MANUAL_COLUMN_ORDER = JSON.stringify({
  status: ['inbox', 'ready', 'in_progress', 'done'],
});
const MANUAL_CARD_FIELDS = ['project_id', 'scheduled', 'due', 'priority'];
const MANUAL_CARD_SORT = [
  { column: 'tasknotes_manual_order', direction: 'DESC' },
  { column: 'formula.atlPriorityRank', direction: 'ASC' },
];
const SUPPORTED_CALENDAR_NAMES = new Set(['日历', '日历视图']);

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function sortEquals(value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(MANUAL_CARD_SORT);
}

export interface BoardPresetStatus {
  available: boolean;
  applied: boolean;
  restorable: boolean;
}

type BaseView = Record<string, unknown>;
type BaseDocument = Record<string, unknown> & { views: BaseView[] };
type ParsedBoard = {
  document: BaseDocument;
  view: BaseView;
  calendar: BaseView | undefined;
};

export class BoardAppearanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardAppearanceError';
  }
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function canonicalVault(vaultRoot: string): Promise<string> {
  try {
    const canonical = await realpath(vaultRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not directory');
    return canonical;
  } catch {
    throw new BoardAppearanceError('当前 Vault 路径无效。');
  }
}

async function readSafeFile(path: string, root: string): Promise<string | null> {
  let handle;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new BoardAppearanceError('任务总看板文件不安全，未做任何修改。');
    }
    const canonical = await realpath(path);
    if (!isWithin(root, canonical)) {
      throw new BoardAppearanceError('任务总看板文件不安全，未做任何修改。');
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new BoardAppearanceError('任务总看板文件不安全，未做任何修改。');
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return null;
    if (error instanceof BoardAppearanceError) throw error;
    throw new BoardAppearanceError('任务总看板文件不安全，未做任何修改。');
  } finally {
    await handle?.close();
  }
}

function isRecord(value: unknown): value is BaseView {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function calendarOptions(calendar: BaseView): BaseView | undefined {
  if (calendar.options === undefined) return undefined;
  if (!isRecord(calendar.options)) throw new Error('invalid calendar options');
  return calendar.options;
}

function parseBoard(content: string): ParsedBoard {
  try {
    const document = parse(content) as unknown;
    if (!isRecord(document)) throw new Error('invalid');
    const views = (document as { views?: unknown }).views;
    if (!Array.isArray(views)) throw new Error('invalid');
    const matching = views.filter((view): view is BaseView => (
      isRecord(view)
      && view.type === 'tasknotesKanban'
      && view.name === '任务总看板'
    ));
    if (matching.length !== 1) throw new Error('ambiguous');
    const calendars = views.filter((view): view is BaseView => (
      isRecord(view)
      && view.type === 'tasknotesCalendar'
      && typeof view.name === 'string'
      && SUPPORTED_CALENDAR_NAMES.has(view.name)
    ));
    if (calendars.length > 1) throw new Error('ambiguous');
    const calendar = calendars[0];
    if (calendar !== undefined) calendarOptions(calendar);
    return {
      document: document as BaseDocument,
      view: matching[0] as BaseView,
      calendar,
    };
  } catch {
    throw new BoardAppearanceError('任务总看板配置无效，未做任何修改。');
  }
}

function calendarPresetApplied(calendar: BaseView | undefined): boolean {
  return calendar === undefined
    || calendarOptions(calendar)?.slotEventOverlap === false;
}

function applyCalendarPreset(calendar: BaseView | undefined): void {
  if (calendar === undefined) return;
  const options = calendarOptions(calendar) ?? {};
  options.slotEventOverlap = false;
  calendar.options = options;
}

async function createBackup(path: string, content: string, root: string): Promise<void> {
  const existing = await readSafeFile(path, root);
  if (existing !== null) return;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    temporaryExists = false;
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error;
  } finally {
    await handle?.close();
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
  await readSafeFile(path, root);
}

async function atomicWrite(path: string, content: string, root: string): Promise<void> {
  const parent = await realpath(dirname(path));
  if (!isWithin(root, parent)) {
    throw new BoardAppearanceError('任务总看板文件不安全，未做任何修改。');
  }
  const temporaryPath = join(parent, `.atl-board-${randomUUID()}.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await readSafeFile(path, root);
    await rename(temporaryPath, path);
    temporaryExists = false;
  } finally {
    await handle?.close();
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export class BoardAppearanceController {
  async status(vaultRoot: string): Promise<BoardPresetStatus> {
    const root = await canonicalVault(vaultRoot);
    const basePath = join(root, ATL_BOARD_PATH);
    const backupPath = `${basePath}.atl-backup`;
    const [content, backup] = await Promise.all([
      readSafeFile(basePath, root),
      readSafeFile(backupPath, root),
    ]);
    if (content === null) {
      return { available: false, applied: false, restorable: backup !== null };
    }
    let applied = false;
    try {
      const { view, calendar } = parseBoard(content);
      applied = view.groupBy !== null
        && typeof view.groupBy === 'object'
        && (view.groupBy as BaseView).property === 'status'
        && (view.groupBy as BaseView).direction === 'ASC'
        && view.pinnedColumns === 'inbox,ready,in_progress,done'
        && view.columnOrder === MANUAL_COLUMN_ORDER
        && view.hideEmptyColumns === true
        && stringArrayEquals(view.order, MANUAL_CARD_FIELDS)
        && sortEquals(view.sort)
        && view.columnWidth === 320
        && view.cardLayout === 'compact'
        && calendarPresetApplied(calendar);
    } catch {
      applied = false;
    }
    return { available: true, applied, restorable: backup !== null };
  }

  async applyRecommendedPreset(vaultRoot: string): Promise<void> {
    const root = await canonicalVault(vaultRoot);
    const basePath = join(root, ATL_BOARD_PATH);
    const content = await readSafeFile(basePath, root);
    if (content === null) {
      throw new BoardAppearanceError('未找到 TaskNotes 任务总看板。');
    }
    const { document, view, calendar } = parseBoard(content);
    await createBackup(`${basePath}.atl-backup`, content, root);
    view.groupBy = { property: 'status', direction: 'ASC' };
    view.pinnedColumns = 'inbox,ready,in_progress,done';
    view.columnOrder = MANUAL_COLUMN_ORDER;
    view.hideEmptyColumns = true;
    view.order = [...MANUAL_CARD_FIELDS];
    view.sort = MANUAL_CARD_SORT.map((item) => ({ ...item }));
    view.columnWidth = 320;
    view.cardLayout = 'compact';
    applyCalendarPreset(calendar);
    await atomicWrite(basePath, stringify(document, { lineWidth: 0 }), root);
  }

  async restorePreset(vaultRoot: string): Promise<void> {
    const root = await canonicalVault(vaultRoot);
    const basePath = join(root, ATL_BOARD_PATH);
    const backup = await readSafeFile(`${basePath}.atl-backup`, root);
    if (backup === null) {
      throw new BoardAppearanceError('没有可恢复的 ATL 看板备份。');
    }
    if (await readSafeFile(basePath, root) === null) {
      throw new BoardAppearanceError('未找到 TaskNotes 任务总看板。');
    }
    await atomicWrite(basePath, backup, root);
  }
}
