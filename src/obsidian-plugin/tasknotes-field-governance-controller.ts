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

type GovernedTaskNotesFieldId = (typeof GOVERNED_TASKNOTES_FIELD_IDS)[number];
type JsonRecord = Record<string, unknown>;
type Visibility = {
  visibleInCreation: boolean;
  visibleInEdit: boolean;
};
type TaskNotesConfiguration = {
  settings: JsonRecord;
  fields: JsonRecord[];
};

export interface TaskNotesRuntimeAdapter {
  settings: unknown;
  saveSettings(): Promise<void>;
}

export interface TaskNotesFieldLayoutBackup {
  version: 1;
  fields: Record<GovernedTaskNotesFieldId, Visibility>;
}

export interface TaskNotesFieldGovernanceBackupStore {
  getBackup(): Promise<unknown | null | undefined>;
  persistFirstBackup(backup: TaskNotesFieldLayoutBackup): Promise<void>;
}

export interface TaskNotesFieldGovernanceStatus {
  available: boolean;
  applied: boolean;
  restorable: boolean;
}

const runtimeTransactions = new WeakMap<object, Promise<void>>();

export class TaskNotesFieldGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskNotesFieldGovernanceError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runtimeAdapter(value: unknown): TaskNotesRuntimeAdapter | undefined {
  if (!isRecord(value) || !('settings' in value) || typeof value.saveSettings !== 'function') {
    return undefined;
  }
  return value as unknown as TaskNotesRuntimeAdapter;
}

function backupStore(value: unknown): TaskNotesFieldGovernanceBackupStore {
  if (!isRecord(value)
    || typeof value.getBackup !== 'function'
    || typeof value.persistFirstBackup !== 'function') {
    throw new TaskNotesFieldGovernanceError('ATL 字段布局备份存储不可用。');
  }
  return value as unknown as TaskNotesFieldGovernanceBackupStore;
}

function parseConfiguration(settings: unknown): TaskNotesConfiguration {
  try {
    if (!isRecord(settings) || !isRecord(settings.modalFieldsConfig)) {
      throw new Error('invalid configuration');
    }
    const modalFieldsConfig = settings.modalFieldsConfig;
    if (modalFieldsConfig.version !== 1 || !Array.isArray(modalFieldsConfig.fields)) {
      throw new Error('unsupported configuration');
    }
    if (!modalFieldsConfig.fields.every(isRecord)) throw new Error('invalid field');
    const fields = modalFieldsConfig.fields as JsonRecord[];
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const matches = fields.filter((field) => field.id === id);
      const field = matches[0];
      if (matches.length !== 1 || field === undefined
        || typeof field.visibleInCreation !== 'boolean'
        || typeof field.visibleInEdit !== 'boolean') {
        throw new Error('invalid governed field');
      }
    }
    return { settings, fields };
  } catch {
    throw new TaskNotesFieldGovernanceError(
      'TaskNotes 字段配置无效或版本不受支持，未做任何修改。',
    );
  }
}

function governedField(configuration: TaskNotesConfiguration, id: GovernedTaskNotesFieldId): JsonRecord {
  const field = configuration.fields.find((candidate) => candidate.id === id);
  if (field === undefined) {
    throw new TaskNotesFieldGovernanceError('TaskNotes 字段配置无效或版本不受支持，未做任何修改。');
  }
  return field;
}

function createBackup(configuration: TaskNotesConfiguration): TaskNotesFieldLayoutBackup {
  const fields = {} as TaskNotesFieldLayoutBackup['fields'];
  for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
    const field = governedField(configuration, id);
    fields[id] = {
      visibleInCreation: field.visibleInCreation as boolean,
      visibleInEdit: field.visibleInEdit as boolean,
    };
  }
  return { version: 1, fields };
}

function parseBackup(value: unknown): TaskNotesFieldLayoutBackup {
  try {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.fields)) {
      throw new Error('invalid backup');
    }
    const fields = value.fields;
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
    return value as unknown as TaskNotesFieldLayoutBackup;
  } catch {
    throw new TaskNotesFieldGovernanceError('ATL 字段布局备份无效，未做任何修改。');
  }
}

function visibilityEquals(
  left: TaskNotesFieldLayoutBackup,
  right: TaskNotesFieldLayoutBackup,
): boolean {
  return GOVERNED_TASKNOTES_FIELD_IDS.every((id) => (
    left.fields[id].visibleInCreation === right.fields[id].visibleInCreation
    && left.fields[id].visibleInEdit === right.fields[id].visibleInEdit
  ));
}

function presetApplied(configuration: TaskNotesConfiguration): boolean {
  return GOVERNED_TASKNOTES_FIELD_IDS.every((id) => {
    const field = governedField(configuration, id);
    return field.visibleInCreation === false && field.visibleInEdit === false;
  });
}

function applyVisibility(
  configuration: TaskNotesConfiguration,
  visibility: TaskNotesFieldLayoutBackup,
): void {
  for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
    const field = governedField(configuration, id);
    const target = visibility.fields[id];
    field.visibleInCreation = target.visibleInCreation;
    field.visibleInEdit = target.visibleInEdit;
  }
}

function hiddenVisibility(): TaskNotesFieldLayoutBackup {
  const fields = {} as TaskNotesFieldLayoutBackup['fields'];
  for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
    fields[id] = { visibleInCreation: false, visibleInEdit: false };
  }
  return { version: 1, fields };
}

function rollbackVisibilityIfUnchanged(
  runtime: TaskNotesRuntimeAdapter,
  expectedSettings: JsonRecord,
  previous: TaskNotesFieldLayoutBackup,
  applied: TaskNotesFieldLayoutBackup,
): void {
  if (runtime.settings !== expectedSettings) return;
  try {
    const configuration = parseConfiguration(runtime.settings);
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      const field = governedField(configuration, id);
      const target = applied.fields[id];
      const prior = previous.fields[id];
      if (field.visibleInCreation === target.visibleInCreation) {
        field.visibleInCreation = prior.visibleInCreation;
      }
      if (field.visibleInEdit === target.visibleInEdit) {
        field.visibleInEdit = prior.visibleInEdit;
      }
    }
  } catch {
    // The runtime replaced or invalidated settings while its save failed.
  }
}

async function withRuntimeTransaction<T>(
  runtime: TaskNotesRuntimeAdapter,
  operation: () => Promise<T>,
): Promise<T> {
  const key = runtime as object;
  const previous = runtimeTransactions.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtimeTransactions.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (runtimeTransactions.get(key) === current) runtimeTransactions.delete(key);
  }
}

async function loadBackup(store: TaskNotesFieldGovernanceBackupStore): Promise<TaskNotesFieldLayoutBackup | undefined> {
  try {
    const value = await store.getBackup();
    if (value === null || value === undefined) return undefined;
    return parseBackup(value);
  } catch (error) {
    if (error instanceof TaskNotesFieldGovernanceError) throw error;
    throw new TaskNotesFieldGovernanceError('无法读取 ATL 字段布局备份。');
  }
}

async function persistFirstBackup(
  store: TaskNotesFieldGovernanceBackupStore,
  backup: TaskNotesFieldLayoutBackup,
): Promise<void> {
  try {
    await store.persistFirstBackup(backup);
  } catch {
    throw new TaskNotesFieldGovernanceError('无法保存 ATL 字段布局备份。');
  }
}

export class TaskNotesFieldGovernanceController {
  constructor(
    private readonly runtime: unknown,
    private readonly backups: unknown,
  ) {}

  async status(): Promise<TaskNotesFieldGovernanceStatus> {
    const runtime = runtimeAdapter(this.runtime);
    if (runtime === undefined) return { available: false, applied: false, restorable: false };

    let configuration: TaskNotesConfiguration;
    try {
      const store = backupStore(this.backups);
      const backup = await loadBackup(store);
      configuration = parseConfiguration(runtime.settings);
      return {
        available: true,
        applied: presetApplied(configuration),
        restorable: backup !== undefined,
      };
    } catch {
      try {
        configuration = parseConfiguration(runtime.settings);
      } catch {
        return { available: true, applied: false, restorable: false };
      }
      return { available: true, applied: presetApplied(configuration), restorable: false };
    }
  }

  async applyPreset(): Promise<void> {
    const runtime = runtimeAdapter(this.runtime);
    if (runtime === undefined) {
      throw new TaskNotesFieldGovernanceError('TaskNotes 运行时不可用。');
    }
    await withRuntimeTransaction(runtime, async () => {
      const store = backupStore(this.backups);
      const existingBackup = await loadBackup(store);
      let configuration = parseConfiguration(runtime.settings);
      if (existingBackup === undefined) {
        const firstBackup = createBackup(configuration);
        await persistFirstBackup(store, firstBackup);
        configuration = parseConfiguration(runtime.settings);
        if (!visibilityEquals(firstBackup, createBackup(configuration))) {
          throw new TaskNotesFieldGovernanceError('TaskNotes 配置已变更，请重试。');
        }
      }
      const previous = createBackup(configuration);
      const applied = hiddenVisibility();
      applyVisibility(configuration, applied);
      try {
        await runtime.saveSettings();
      } catch {
        rollbackVisibilityIfUnchanged(runtime, configuration.settings, previous, applied);
        throw new TaskNotesFieldGovernanceError('保存 TaskNotes 字段设置失败，已回滚本次内存修改。');
      }
    });
  }

  async restorePreset(): Promise<void> {
    const runtime = runtimeAdapter(this.runtime);
    if (runtime === undefined) {
      throw new TaskNotesFieldGovernanceError('TaskNotes 运行时不可用。');
    }
    await withRuntimeTransaction(runtime, async () => {
      const store = backupStore(this.backups);
      const backup = await loadBackup(store);
      if (backup === undefined) {
        throw new TaskNotesFieldGovernanceError('没有可恢复的 ATL 字段布局备份。');
      }
      const configuration = parseConfiguration(runtime.settings);
      const previous = createBackup(configuration);
      applyVisibility(configuration, backup);
      try {
        await runtime.saveSettings();
      } catch {
        rollbackVisibilityIfUnchanged(runtime, configuration.settings, previous, backup);
        throw new TaskNotesFieldGovernanceError('保存 TaskNotes 字段设置失败，已回滚本次内存修改。');
      }
    });
  }
}
