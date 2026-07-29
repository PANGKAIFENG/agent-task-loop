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
const MANAGED_KANBAN_NAMES = new Set([
  '任务总看板',
  '工作任务',
  '个人实践',
  '待归类',
]);
const COLLECTED_AT_FORMULA = 'if(created_at.isEmpty(), file.ctime, if(date(created_at).isEmpty(), file.ctime, date(created_at)))';
const PLANNED_AT_FORMULA = 'if(scheduled.isEmpty(), null, date(scheduled))';
const MANUAL_CARD_FIELDS = [
  'project_id',
  'source_date',
  'formula.atlCollectedAt',
  'formula.atlPlannedAt',
  'priority',
];
const MANUAL_CARD_SORT = [
  { column: 'tasknotes_manual_order', direction: 'DESC' },
  { column: 'formula.atlCollectedAt', direction: 'DESC' },
  { column: 'source_date', direction: 'DESC' },
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
  managedViews: BaseView[];
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

function optionalRecordSection(
  document: BaseDocument,
  key: 'formulas' | 'properties',
): BaseView | undefined {
  const value = document[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`invalid ${key}`);
  return value;
}

function recordSection(
  document: BaseDocument,
  key: 'formulas' | 'properties',
): BaseView {
  const existing = optionalRecordSection(document, key);
  if (existing !== undefined) return existing;
  const created: BaseView = {};
  document[key] = created;
  return created;
}

function parseBoard(content: string): ParsedBoard {
  try {
    const document = parse(content) as unknown;
    if (!isRecord(document)) throw new Error('invalid');
    const views = (document as { views?: unknown }).views;
    if (!Array.isArray(views)) throw new Error('invalid');
    optionalRecordSection(document as BaseDocument, 'formulas');
    optionalRecordSection(document as BaseDocument, 'properties');
    const managedByName = new Map<string, BaseView>();
    for (const view of views) {
      if (
        !isRecord(view)
        || view.type !== 'tasknotesKanban'
        || typeof view.name !== 'string'
        || !MANAGED_KANBAN_NAMES.has(view.name)
      ) continue;
      if (managedByName.has(view.name)) throw new Error('ambiguous');
      managedByName.set(view.name, view);
    }
    if (!managedByName.has('任务总看板')) throw new Error('missing');
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
      managedViews: [...MANAGED_KANBAN_NAMES]
        .map((name) => managedByName.get(name))
        .filter((view): view is BaseView => view !== undefined),
      calendar,
    };
  } catch {
    throw new BoardAppearanceError('任务总看板配置无效，未做任何修改。');
  }
}

function propertyDisplayNameApplied(
  properties: BaseView | undefined,
  key: string,
  displayName: string,
): boolean {
  const value = properties?.[key];
  return isRecord(value) && value.displayName === displayName;
}

function boardMetadataApplied(document: BaseDocument): boolean {
  const formulas = optionalRecordSection(document, 'formulas');
  const properties = optionalRecordSection(document, 'properties');
  return formulas?.atlCollectedAt === COLLECTED_AT_FORMULA
    && formulas.atlPlannedAt === PLANNED_AT_FORMULA
    && propertyDisplayNameApplied(properties, 'source_date', '来源日期')
    && propertyDisplayNameApplied(
      properties,
      'formula.atlCollectedAt',
      '入箱时间',
    )
    && propertyDisplayNameApplied(
      properties,
      'formula.atlPlannedAt',
      '计划时间',
    );
}

function viewPresetApplied(view: BaseView): boolean {
  return view.groupBy !== null
    && typeof view.groupBy === 'object'
    && (view.groupBy as BaseView).property === 'status'
    && (view.groupBy as BaseView).direction === 'ASC'
    && view.pinnedColumns === 'inbox,ready,in_progress,done'
    && view.columnOrder === MANUAL_COLUMN_ORDER
    && view.hideEmptyColumns === true
    && stringArrayEquals(view.order, MANUAL_CARD_FIELDS)
    && sortEquals(view.sort)
    && view.columnWidth === 320
    && view.cardLayout === 'compact';
}

function applyViewPreset(view: BaseView): void {
  view.groupBy = { property: 'status', direction: 'ASC' };
  view.pinnedColumns = 'inbox,ready,in_progress,done';
  view.columnOrder = MANUAL_COLUMN_ORDER;
  view.hideEmptyColumns = true;
  view.order = [...MANUAL_CARD_FIELDS];
  view.sort = MANUAL_CARD_SORT.map((item) => ({ ...item }));
  view.columnWidth = 320;
  view.cardLayout = 'compact';
}

function applyBoardMetadata(document: BaseDocument): void {
  const formulas = recordSection(document, 'formulas');
  formulas.atlCollectedAt = COLLECTED_AT_FORMULA;
  formulas.atlPlannedAt = PLANNED_AT_FORMULA;

  const properties = recordSection(document, 'properties');
  const displayNames = {
    source_date: '来源日期',
    'formula.atlCollectedAt': '入箱时间',
    'formula.atlPlannedAt': '计划时间',
  } as const;
  for (const [key, displayName] of Object.entries(displayNames)) {
    const existing = properties[key];
    properties[key] = {
      ...(isRecord(existing) ? existing : {}),
      displayName,
    };
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
      const { document, managedViews, calendar } = parseBoard(content);
      applied = boardMetadataApplied(document)
        && managedViews.every(viewPresetApplied)
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
    const { document, managedViews, calendar } = parseBoard(content);
    await createBackup(`${basePath}.atl-backup`, content, root);
    applyBoardMetadata(document);
    managedViews.forEach(applyViewPreset);
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
