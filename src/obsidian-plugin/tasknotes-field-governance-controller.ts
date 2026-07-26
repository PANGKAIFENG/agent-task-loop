import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

export const TASKNOTES_DATA_PATH = '.obsidian/plugins/tasknotes/data.json';
export const TASKNOTES_FIELD_LAYOUT_BACKUP_PATH =
  '.obsidian/plugins/agent-task-loop/tasknotes-field-layout-backup.json';
export const GOVERNED_TASKNOTES_FIELD_IDS = [
  'contexts',
  'tags',
  'projects',
  'blocked-by',
  'blocking',
  'atl_project_id',
  'atl_review_state',
  'atl_task_id',
  'atl_review_feedback',
] as const;

const BACKUP_VERSION = 1;

export interface TaskNotesFieldGovernanceStatus {
  available: boolean;
  applied: boolean;
  restorable: boolean;
}

type JsonRecord = Record<string, unknown>;
type Visibility = {
  visibleInCreation: boolean;
  visibleInEdit: boolean;
};
type TaskNotesConfiguration = {
  document: JsonRecord;
  fields: JsonRecord[];
};
type FieldLayoutBackup = {
  version: number;
  fields: Record<string, Visibility>;
};

export class TaskNotesFieldGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotesFieldGovernanceError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function canonicalVault(vaultRoot: string): Promise<string> {
  try {
    const canonical = await realpath(vaultRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new TaskNotesFieldGovernanceError('当前 Vault 路径无效。');
  }
}

async function readSafeFile(path: string, root: string, label: string): Promise<string | null> {
  let handle;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TaskNotesFieldGovernanceError(`${label}文件不安全，未做任何修改。`);
    }
    const canonical = await realpath(path);
    if (!isWithin(root, canonical)) {
      throw new TaskNotesFieldGovernanceError(`${label}文件不安全，未做任何修改。`);
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) {
      throw new TaskNotesFieldGovernanceError(`${label}文件不安全，未做任何修改。`);
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    if (error instanceof TaskNotesFieldGovernanceError) throw error;
    throw new TaskNotesFieldGovernanceError(`${label}文件不安全，未做任何修改。`);
  } finally {
    await handle?.close();
  }
}

function parseConfiguration(content: string): TaskNotesConfiguration {
  try {
    const document = JSON.parse(content) as unknown;
    if (!isRecord(document) || !isRecord(document.modalFieldsConfig)) {
      throw new Error('invalid configuration');
    }
    const modalFieldsConfig = document.modalFieldsConfig;
    if (modalFieldsConfig.version !== 1 || !Array.isArray(modalFieldsConfig.fields)) {
      throw new Error('unsupported configuration');
    }
    const fields = modalFieldsConfig.fields;
    if (!fields.every(isRecord)) throw new Error('invalid field');
    const records = fields as JsonRecord[];
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const matches = records.filter((field) => field.id === id);
      if (matches.length !== 1) throw new Error('missing or duplicate field');
      const field = matches[0];
      if (field === undefined) throw new Error('missing field');
      if (typeof field.visibleInCreation !== 'boolean'
        || typeof field.visibleInEdit !== 'boolean') {
        throw new Error('invalid visibility');
      }
    }
    return { document, fields: records };
  } catch {
    throw new TaskNotesFieldGovernanceError(
      'TaskNotes 字段配置无效或版本不受支持，未做任何修改。',
    );
  }
}

function governedField(configuration: TaskNotesConfiguration, id: string): JsonRecord {
  const field = configuration.fields.find((candidate) => candidate.id === id);
  if (field === undefined) {
    throw new TaskNotesFieldGovernanceError('TaskNotes 字段配置无效或版本不受支持，未做任何修改。');
  }
  return field;
}

function createBackupDocument(configuration: TaskNotesConfiguration): FieldLayoutBackup {
  return {
    version: BACKUP_VERSION,
    fields: Object.fromEntries(GOVERNED_TASKNOTES_FIELD_IDS.map((id) => {
      const field = governedField(configuration, id);
      return [id, {
        visibleInCreation: field.visibleInCreation as boolean,
        visibleInEdit: field.visibleInEdit as boolean,
      }];
    })),
  };
}

function parseBackup(content: string): FieldLayoutBackup {
  try {
    const backup = JSON.parse(content) as unknown;
    if (!isRecord(backup) || backup.version !== BACKUP_VERSION || !isRecord(backup.fields)) {
      throw new Error('invalid backup');
    }
    const fields = backup.fields;
    const ids = Object.keys(fields);
    if (ids.length !== GOVERNED_TASKNOTES_FIELD_IDS.length
      || !GOVERNED_TASKNOTES_FIELD_IDS.every((id) => ids.includes(id))) {
      throw new Error('invalid backup fields');
    }
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const visibility = fields[id];
      if (!isRecord(visibility)
        || typeof visibility.visibleInCreation !== 'boolean'
        || typeof visibility.visibleInEdit !== 'boolean') {
        throw new Error('invalid backup visibility');
      }
    }
    return backup as FieldLayoutBackup;
  } catch {
    throw new TaskNotesFieldGovernanceError('ATL 字段布局备份无效，未做任何修改。');
  }
}

async function safeParent(path: string, root: string, label: string): Promise<string> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const parent = await realpath(dirname(path));
    if (!isWithin(root, parent)) throw new Error('outside vault');
    return parent;
  } catch {
    throw new TaskNotesFieldGovernanceError(`${label}文件不安全，未做任何修改。`);
  }
}

async function atomicWrite(path: string, content: string, root: string, label: string): Promise<void> {
  const parent = await safeParent(path, root, label);
  const temporaryPath = join(parent, `.atl-tasknotes-fields-${randomUUID()}.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await readSafeFile(path, root, label) === null) {
      throw new TaskNotesFieldGovernanceError(`${label}文件不存在，未做任何修改。`);
    }
    await rename(temporaryPath, path);
    temporaryExists = false;
  } finally {
    await handle?.close();
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function createBackupIfMissing(
  path: string,
  backup: FieldLayoutBackup,
  root: string,
): Promise<void> {
  const existing = await readSafeFile(path, root, 'ATL 字段布局备份');
  if (existing !== null) {
    parseBackup(existing);
    return;
  }
  const parent = await safeParent(path, root, 'ATL 字段布局备份');
  const temporaryPath = join(parent, `.atl-tasknotes-backup-${randomUUID()}.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(JSON.stringify(backup, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    temporaryExists = false;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  } finally {
    await handle?.close();
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
  const persisted = await readSafeFile(path, root, 'ATL 字段布局备份');
  if (persisted === null) {
    throw new TaskNotesFieldGovernanceError('ATL 字段布局备份文件不存在，未做任何修改。');
  }
  parseBackup(persisted);
}

function presetApplied(configuration: TaskNotesConfiguration): boolean {
  return GOVERNED_TASKNOTES_FIELD_IDS.every((id) => {
    const field = governedField(configuration, id);
    return field.visibleInCreation === false && field.visibleInEdit === false;
  });
}

export class TaskNotesFieldGovernanceController {
  async status(vaultRoot: string): Promise<TaskNotesFieldGovernanceStatus> {
    const root = await canonicalVault(vaultRoot);
    const dataPath = join(root, TASKNOTES_DATA_PATH);
    const backupPath = join(root, TASKNOTES_FIELD_LAYOUT_BACKUP_PATH);
    const content = await readSafeFile(dataPath, root, 'TaskNotes 数据');
    if (content === null) return { available: false, applied: false, restorable: false };

    let configuration: TaskNotesConfiguration;
    try {
      configuration = parseConfiguration(content);
    } catch {
      return { available: true, applied: false, restorable: false };
    }

    let restorable = false;
    try {
      const backup = await readSafeFile(backupPath, root, 'ATL 字段布局备份');
      restorable = backup !== null && parseBackup(backup) !== undefined;
    } catch {
      restorable = false;
    }
    return {
      available: true,
      applied: presetApplied(configuration),
      restorable,
    };
  }

  async applyPreset(vaultRoot: string): Promise<void> {
    const root = await canonicalVault(vaultRoot);
    const dataPath = join(root, TASKNOTES_DATA_PATH);
    const content = await readSafeFile(dataPath, root, 'TaskNotes 数据');
    if (content === null) {
      throw new TaskNotesFieldGovernanceError('未找到 TaskNotes 数据配置。');
    }
    const configuration = parseConfiguration(content);
    await createBackupIfMissing(
      join(root, TASKNOTES_FIELD_LAYOUT_BACKUP_PATH),
      createBackupDocument(configuration),
      root,
    );
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const field = governedField(configuration, id);
      field.visibleInCreation = false;
      field.visibleInEdit = false;
    }
    await atomicWrite(dataPath, JSON.stringify(configuration.document, null, 2), root, 'TaskNotes 数据');
  }

  async restorePreset(vaultRoot: string): Promise<void> {
    const root = await canonicalVault(vaultRoot);
    const dataPath = join(root, TASKNOTES_DATA_PATH);
    const backupPath = join(root, TASKNOTES_FIELD_LAYOUT_BACKUP_PATH);
    const [content, backupContent] = await Promise.all([
      readSafeFile(dataPath, root, 'TaskNotes 数据'),
      readSafeFile(backupPath, root, 'ATL 字段布局备份'),
    ]);
    if (content === null) {
      throw new TaskNotesFieldGovernanceError('未找到 TaskNotes 数据配置。');
    }
    if (backupContent === null) {
      throw new TaskNotesFieldGovernanceError('没有可恢复的 ATL 字段布局备份。');
    }
    const configuration = parseConfiguration(content);
    const backup = parseBackup(backupContent);
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const field = governedField(configuration, id);
      const visibility = backup.fields[id];
      if (visibility === undefined) {
        throw new TaskNotesFieldGovernanceError('ATL 字段布局备份无效，未做任何修改。');
      }
      field.visibleInCreation = visibility.visibleInCreation;
      field.visibleInEdit = visibility.visibleInEdit;
    }
    await atomicWrite(dataPath, JSON.stringify(configuration.document, null, 2), root, 'TaskNotes 数据');
  }
}
