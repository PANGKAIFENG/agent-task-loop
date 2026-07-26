import { describe, expect, it, vi } from 'vitest';

import {
  GOVERNED_TASKNOTES_FIELD_IDS,
  TaskNotesFieldGovernanceController,
  type TaskNotesFieldLayoutBackup,
  type TaskNotesRuntimeAdapter,
} from '../../../src/obsidian-plugin/tasknotes-field-governance-controller.js';

type Field = Record<string, unknown> & { id: string };
type TaskNotesSettings = {
  modalFieldsConfig: {
    version: number;
    fields: Field[];
    userFields: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
};

function settingsFixture(): TaskNotesSettings {
  return {
    generalSetting: { keep: 'unchanged' },
    modalFieldsConfig: {
      version: 1,
      userFields: [{ id: 'custom', label: 'Custom field' }],
      fields: [
        ...GOVERNED_TASKNOTES_FIELD_IDS.map((id, index) => ({
          id,
          displayName: `Field ${index}`,
          type: 'text',
          enabled: true,
          visibleInCreation: index % 2 === 0,
          visibleInEdit: index % 2 !== 0,
          preserved: { index },
        })),
        {
          id: 'atl_origin',
          displayName: 'Origin',
          type: 'text',
          enabled: true,
          visibleInCreation: true,
          visibleInEdit: true,
        },
      ],
    },
  };
}

function runtime(settings = settingsFixture(), saveSettings = vi.fn(async () => undefined)) {
  return {
    settings,
    saveSettings,
  } satisfies TaskNotesRuntimeAdapter & { saveSettings: ReturnType<typeof vi.fn> };
}

function backupStore(initialBackup?: unknown, onPersist?: () => Promise<void>) {
  let backup = initialBackup;
  return {
    getBackup: vi.fn(async () => backup),
    persistFirstBackup: vi.fn(async (candidate: TaskNotesFieldLayoutBackup) => {
      if (backup === undefined || backup === null) backup = candidate;
      await onPersist?.();
    }),
    backup: () => backup,
  };
}

function field(settings: TaskNotesSettings, id: string): Field {
  const candidate = settings.modalFieldsConfig.fields.find((item) => item.id === id);
  if (candidate === undefined) throw new Error(`missing ${id}`);
  return candidate;
}

describe('TaskNotesFieldGovernanceController', () => {
  it('hides only the governed visibility pairs and persists a selective first backup', async () => {
    const taskNotes = runtime();
    const original = structuredClone(taskNotes.settings);
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await controller.applyPreset();

    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      expect(field(taskNotes.settings, id)).toEqual({
        ...field(original, id),
        visibleInCreation: false,
        visibleInEdit: false,
      });
    }
    expect(field(taskNotes.settings, 'atl_origin')).toEqual(field(original, 'atl_origin'));
    expect(taskNotes.settings.generalSetting).toEqual(original.generalSetting);
    expect(taskNotes.settings.modalFieldsConfig.userFields).toEqual(
      original.modalFieldsConfig.userFields,
    );
    expect(store.backup()).toEqual({
      version: 1,
      fields: Object.fromEntries(GOVERNED_TASKNOTES_FIELD_IDS.map((id) => [id, {
        visibleInCreation: field(original, id).visibleInCreation,
        visibleInEdit: field(original, id).visibleInEdit,
      }])),
    });
    expect(taskNotes.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the first backup when the preset is reapplied', async () => {
    const taskNotes = runtime();
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);
    await controller.applyPreset();
    const firstBackup = structuredClone(store.backup());

    await controller.applyPreset();

    expect(store.backup()).toEqual(firstBackup);
    expect(store.persistFirstBackup).toHaveBeenCalledTimes(1);
    expect(taskNotes.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('restores only backed-up visibility pairs after unrelated live settings change', async () => {
    const taskNotes = runtime();
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);
    await controller.applyPreset();
    taskNotes.settings.generalSetting = { keep: 'changed later' };
    field(taskNotes.settings, 'atl_origin').displayName = 'Renamed later';

    await controller.restorePreset();

    expect(taskNotes.settings.generalSetting).toEqual({ keep: 'changed later' });
    expect(field(taskNotes.settings, 'atl_origin')).toMatchObject({ displayName: 'Renamed later' });
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      expect(field(taskNotes.settings, id)).toMatchObject(field(settingsFixture(), id));
    }
    expect(taskNotes.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('reports live availability, application, and valid backup restoration state', async () => {
    const taskNotes = runtime();
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.status()).resolves.toEqual({
      available: true,
      applied: false,
      restorable: false,
    });
    await controller.applyPreset();
    await expect(controller.status()).resolves.toEqual({
      available: true,
      applied: true,
      restorable: true,
    });
  });

  it.each([
    ['unsupported version', (settings: TaskNotesSettings) => {
      settings.modalFieldsConfig.version = 2;
    }],
    ['duplicate governed field', (settings: TaskNotesSettings) => {
      settings.modalFieldsConfig.fields.push({ ...field(settings, 'tags') });
    }],
    ['missing governed field', (settings: TaskNotesSettings) => {
      settings.modalFieldsConfig.fields = settings.modalFieldsConfig.fields.filter(
        (item) => item.id !== 'tags',
      );
    }],
    ['invalid visibility', (settings: TaskNotesSettings) => {
      field(settings, 'tags').visibleInEdit = 'yes';
    }],
  ])('fails closed for %s runtime settings', async (_name, mutate) => {
    const taskNotes = runtime();
    mutate(taskNotes.settings);
    const before = structuredClone(taskNotes.settings);
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.applyPreset()).rejects.toThrow('TaskNotes 字段配置无效或版本不受支持');
    expect(taskNotes.settings).toEqual(before);
    expect(store.persistFirstBackup).not.toHaveBeenCalled();
    expect(taskNotes.saveSettings).not.toHaveBeenCalled();
    await expect(controller.status()).resolves.toEqual({
      available: true,
      applied: false,
      restorable: false,
    });
  });

  it.each([
    ['missing runtime', undefined],
    ['missing save method', { settings: settingsFixture() }],
  ])('fails closed when TaskNotes runtime is %s', async (_name, taskNotes) => {
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.status()).resolves.toEqual({
      available: false,
      applied: false,
      restorable: false,
    });
    await expect(controller.applyPreset()).rejects.toThrow('TaskNotes 运行时不可用');
  });

  it('fails closed for a malformed ATL-owned backup', async () => {
    const taskNotes = runtime();
    const store = backupStore({ version: 1, fields: {} });
    const before = structuredClone(taskNotes.settings);
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.status()).resolves.toEqual({
      available: true,
      applied: false,
      restorable: false,
    });
    await expect(controller.applyPreset()).rejects.toThrow('ATL 字段布局备份无效');
    await expect(controller.restorePreset()).rejects.toThrow('ATL 字段布局备份无效');
    expect(taskNotes.settings).toEqual(before);
    expect(taskNotes.saveSettings).not.toHaveBeenCalled();
  });

  it('rejects restore without an ATL-owned backup and leaves live settings untouched', async () => {
    const taskNotes = runtime();
    const before = structuredClone(taskNotes.settings);
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.restorePreset()).rejects.toThrow('没有可恢复的 ATL 字段布局备份');
    expect(taskNotes.settings).toEqual(before);
    expect(taskNotes.saveSettings).not.toHaveBeenCalled();
  });

  it('rolls back only apply visibility mutations in memory when saveSettings fails', async () => {
    const saveFailure = new Error('save failed');
    const taskNotes = runtime(settingsFixture(), vi.fn(async () => {
      throw saveFailure;
    }));
    const before = structuredClone(taskNotes.settings);
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.applyPreset()).rejects.toThrow('保存 TaskNotes 字段设置失败');
    expect(taskNotes.settings).toEqual(before);
    expect(store.backup()).toBeDefined();
  });

  it('persists recovered apply settings after a save persists and then rejects', async () => {
    const taskNotes = runtime();
    const before = structuredClone(taskNotes.settings);
    const persistedSettings: TaskNotesSettings[] = [];
    taskNotes.saveSettings.mockImplementation(async () => {
      persistedSettings.push(structuredClone(taskNotes.settings));
      if (persistedSettings.length === 1) throw new Error('save failed after persistence');
    });
    const controller = new TaskNotesFieldGovernanceController(taskNotes, backupStore());

    await expect(controller.applyPreset()).rejects.toThrow(
      '保存 TaskNotes 字段设置失败，已保存恢复后的内存字段设置',
    );

    expect(persistedSettings).toHaveLength(2);
    const firstPersistedSettings = persistedSettings[0];
    if (firstPersistedSettings === undefined) throw new Error('expected first persisted settings');
    for (const id of GOVERNED_TASKNOTES_FIELD_IDS) {
      expect(field(firstPersistedSettings, id)).toMatchObject({
        visibleInCreation: false,
        visibleInEdit: false,
      });
    }
    expect(persistedSettings[1]).toEqual(before);
    expect(taskNotes.settings).toEqual(before);
  });

  it('reports possible persistence divergence when recovered apply settings cannot be saved', async () => {
    const taskNotes = runtime();
    const persistedSettings: TaskNotesSettings[] = [];
    taskNotes.saveSettings.mockImplementation(async () => {
      if (persistedSettings.length === 0) {
        persistedSettings.push(structuredClone(taskNotes.settings));
      }
      throw new Error('save failed');
    });
    const controller = new TaskNotesFieldGovernanceController(taskNotes, backupStore());

    await expect(controller.applyPreset()).rejects.toThrow(
      '保存 TaskNotes 字段设置失败，且恢复保存失败；持久化状态可能不一致。',
    );

    expect(taskNotes.saveSettings).toHaveBeenCalledTimes(2);
    expect(persistedSettings).toHaveLength(1);
  });

  it('rolls back only restore visibility mutations in memory when saveSettings fails', async () => {
    const taskNotes = runtime();
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);
    await controller.applyPreset();
    const beforeRestore = structuredClone(taskNotes.settings);
    taskNotes.saveSettings.mockRejectedValueOnce(new Error('save failed'));

    await expect(controller.restorePreset()).rejects.toThrow('保存 TaskNotes 字段设置失败');
    expect(taskNotes.settings).toEqual(beforeRestore);
  });

  it('persists recovered restore settings after a save persists and then rejects', async () => {
    const taskNotes = runtime();
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);
    await controller.applyPreset();
    const beforeRestore = structuredClone(taskNotes.settings);
    const persistedSettings: TaskNotesSettings[] = [];
    taskNotes.saveSettings.mockImplementation(async () => {
      persistedSettings.push(structuredClone(taskNotes.settings));
      if (persistedSettings.length === 1) throw new Error('save failed after persistence');
    });

    await expect(controller.restorePreset()).rejects.toThrow(
      '保存 TaskNotes 字段设置失败，已保存恢复后的内存字段设置',
    );

    expect(persistedSettings).toHaveLength(2);
    expect(persistedSettings[0]).toEqual(settingsFixture());
    expect(persistedSettings[1]).toEqual(beforeRestore);
    expect(taskNotes.settings).toEqual(beforeRestore);
  });

  it('fails closed if governed visibility changes while the first backup is persisted', async () => {
    const taskNotes = runtime();
    const store = backupStore(undefined, async () => {
      field(taskNotes.settings, 'tags').visibleInCreation = true;
    });
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    await expect(controller.applyPreset()).rejects.toThrow('TaskNotes 配置已变更，请重试');
    expect(taskNotes.saveSettings).not.toHaveBeenCalled();
  });

  it('serializes overlapping operations against the live runtime', async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCalls = 0;
    const taskNotes = runtime(settingsFixture(), vi.fn(async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        await firstSaveStarted;
      }
    }));
    const store = backupStore();
    const controller = new TaskNotesFieldGovernanceController(taskNotes, store);

    const apply = controller.applyPreset();
    await vi.waitFor(() => expect(saveCalls).toBe(1));
    const restore = controller.restorePreset();
    await Promise.resolve();
    expect(saveCalls).toBe(1);
    releaseFirstSave?.();
    await Promise.all([apply, restore]);

    expect(saveCalls).toBe(2);
    expect(field(taskNotes.settings, 'tags')).toMatchObject({
      visibleInCreation: false,
      visibleInEdit: true,
    });
  });
});
