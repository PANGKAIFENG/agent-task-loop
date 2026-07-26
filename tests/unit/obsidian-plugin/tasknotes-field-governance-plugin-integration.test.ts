import { describe, expect, it, vi } from 'vitest';

import {
  GOVERNED_TASKNOTES_FIELD_IDS,
  type TaskNotesFieldGovernanceBackupStore,
  type TaskNotesFieldGovernanceStatus,
  type TaskNotesFieldLayoutBackup,
} from '../../../src/obsidian-plugin/tasknotes-field-governance-controller.js';
import {
  createTaskNotesFieldGovernancePluginIntegration,
  taskNotesFieldControlState,
  type TaskNotesFieldGovernanceActions,
} from '../../../src/obsidian-plugin/tasknotes-field-governance-plugin-integration.js';
import { SerializedSettingsWriter } from '../../../src/obsidian-plugin/serialized-settings-writer.js';

function runtimeSettings() {
  return {
    modalFieldsConfig: {
      version: 1,
      fields: GOVERNED_TASKNOTES_FIELD_IDS.map((id, index) => ({
        id,
        visibleInCreation: index % 2 === 0,
        visibleInEdit: index % 2 !== 0,
      })),
    },
  };
}

function backupFixture(): TaskNotesFieldLayoutBackup {
  return {
    version: 1,
    fields: Object.fromEntries(GOVERNED_TASKNOTES_FIELD_IDS.map((id, index) => [id, {
      visibleInCreation: index % 2 === 0,
      visibleInEdit: index % 2 !== 0,
    }])) as TaskNotesFieldLayoutBackup['fields'],
  };
}

function validRuntime() {
  return {
    settings: runtimeSettings(),
    saveSettings: vi.fn(async () => undefined),
  };
}

function statusFixture(overrides: Partial<TaskNotesFieldGovernanceStatus> = {}) {
  return {
    available: true,
    applied: false,
    restorable: false,
    ...overrides,
  };
}

function actionFixture(overrides: Partial<TaskNotesFieldGovernanceActions> = {}) {
  return {
    status: vi.fn(async () => statusFixture()),
    applyPreset: vi.fn(async () => undefined),
    restorePreset: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('TaskNotes field governance plugin integration', () => {
  it('reports malformed TaskNotes runtime as unavailable and fails closed on apply', async () => {
    const notices: string[] = [];
    const malformedRuntime = { settings: { modalFieldsConfig: { version: 1 } } };
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn(() => malformedRuntime) },
      getSettings: () => ({ allowVaultManagement: true }),
      saveSettings: vi.fn(async () => undefined),
      notice: (message) => notices.push(message),
    });

    await expect(integration.status()).resolves.toEqual({
      available: false,
      applied: false,
      restorable: false,
    });
    await integration.apply();

    expect(notices).toEqual(['TaskNotes 运行时不可用。']);
  });

  it('persists the first ATL backup and never overwrites it on a later apply', async () => {
    const runtime = validRuntime();
    const settings: { allowVaultManagement: boolean; taskNotesFieldLayoutBackup?: unknown } = {
      allowVaultManagement: true,
    };
    const saveSettings = vi.fn(async () => undefined);
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn(() => runtime) },
      getSettings: () => settings,
      saveSettings,
      notice: vi.fn(),
    });

    await integration.apply();
    const firstBackup = structuredClone(settings.taskNotesFieldLayoutBackup);
    await integration.apply();

    expect(firstBackup).toBeDefined();
    expect(settings.taskNotesFieldLayoutBackup).toEqual(firstBackup);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('rolls back the in-memory ATL backup when its first persistence fails', async () => {
    const runtime = validRuntime();
    const settings: { allowVaultManagement: boolean; taskNotesFieldLayoutBackup?: unknown } = {
      allowVaultManagement: true,
    };
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn(() => runtime) },
      getSettings: () => settings,
      saveSettings: vi.fn(async () => {
        throw new Error('ATL save failed');
      }),
      notice: vi.fn(),
    });

    await integration.apply();

    expect(settings).not.toHaveProperty('taskNotesFieldLayoutBackup');
    expect(runtime.saveSettings).not.toHaveBeenCalled();
  });

  it('persists removal of an ATL backup when the first save persists and then rejects', async () => {
    const runtime = validRuntime();
    const settings: { allowVaultManagement: boolean; taskNotesFieldLayoutBackup?: unknown } = {
      allowVaultManagement: true,
    };
    const persistedSettings: typeof settings[] = [];
    const saveSettings = vi.fn(async () => {
      persistedSettings.push(structuredClone(settings));
      if (persistedSettings.length === 1) throw new Error('ATL save failed after persistence');
    });
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn(() => runtime) },
      getSettings: () => settings,
      saveSettings,
      notice: vi.fn(),
    });

    await integration.apply();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(persistedSettings[0]).toHaveProperty('taskNotesFieldLayoutBackup');
    expect(persistedSettings[1]).not.toHaveProperty('taskNotesFieldLayoutBackup');
    expect(settings).not.toHaveProperty('taskNotesFieldLayoutBackup');
    expect(runtime.saveSettings).not.toHaveBeenCalled();
  });

  it('clears only the matching ATL backup and persists its removal', async () => {
    const settings: { allowVaultManagement: boolean; taskNotesFieldLayoutBackup?: unknown } = {
      allowVaultManagement: true,
    };
    const backup = backupFixture();
    const saveSettings = vi.fn(async () => undefined);
    let capturedBackups: TaskNotesFieldGovernanceBackupStore | undefined;
    const actions = actionFixture({
      applyPreset: vi.fn(async () => {
        if (capturedBackups === undefined) throw new Error('missing backup store');
        await capturedBackups.persistFirstBackup(backup);
        await expect(capturedBackups.clearBackupIfMatches(backup)).resolves.toBe(true);
      }),
    });
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn() },
      getSettings: () => settings,
      saveSettings,
      notice: vi.fn(),
      createActions: (_runtime, backups) => {
        capturedBackups = backups;
        return actions;
      },
    });

    await integration.apply();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(settings).not.toHaveProperty('taskNotesFieldLayoutBackup');
  });

  it('persists the field backup after an earlier stale ATL settings save', async () => {
    const runtime = validRuntime();
    const settings: { allowVaultManagement: boolean; taskNotesFieldLayoutBackup?: unknown } = {
      allowVaultManagement: true,
    };
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteStarted: (() => void) | undefined;
    const firstWriteRunning = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let persistedSettings: typeof settings | undefined;
    let writeCount = 0;
    const writer = new SerializedSettingsWriter<typeof settings>(async (snapshot) => {
      writeCount += 1;
      if (writeCount === 1) {
        firstWriteStarted?.();
        await firstWriteBlocked;
      }
      persistedSettings = structuredClone(snapshot);
    });
    const staleSave = writer.write(structuredClone(settings));
    await firstWriteRunning;
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn(() => runtime) },
      getSettings: () => settings,
      saveSettings: () => writer.write(structuredClone(settings)),
      notice: vi.fn(),
    });

    const apply = integration.apply();
    await Promise.resolve();

    expect(writeCount).toBe(1);
    expect(runtime.saveSettings).not.toHaveBeenCalled();
    releaseFirstWrite?.();
    await Promise.all([staleSave, apply]);

    expect(writeCount).toBe(2);
    expect(persistedSettings?.taskNotesFieldLayoutBackup).toBeDefined();
    expect(runtime.settings.modalFieldsConfig.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ visibleInCreation: false, visibleInEdit: false }),
    ]));
  });

  it('does not invoke the controller when Vault management is disabled', async () => {
    const notices: string[] = [];
    const actions = actionFixture();
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn() },
      getSettings: () => ({ allowVaultManagement: false }),
      saveSettings: vi.fn(async () => undefined),
      notice: (message) => notices.push(message),
      createActions: () => actions,
    });

    await integration.apply();
    await integration.restore();

    expect(actions.applyPreset).not.toHaveBeenCalled();
    expect(actions.restorePreset).not.toHaveBeenCalled();
    expect(notices).toEqual([
      '请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault',
      '请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault',
    ]);
  });

  it('gives apply and restore their own restart notices after success', async () => {
    const notices: string[] = [];
    const actions = actionFixture();
    const integration = createTaskNotesFieldGovernancePluginIntegration({
      registry: { getPlugin: vi.fn() },
      getSettings: () => ({ allowVaultManagement: true }),
      saveSettings: vi.fn(async () => undefined),
      notice: (message) => notices.push(message),
      createActions: () => actions,
    });

    await integration.apply();
    await integration.restore();

    expect(actions.applyPreset).toHaveBeenCalledOnce();
    expect(actions.restorePreset).toHaveBeenCalledOnce();
    expect(notices).toEqual([
      '已应用精简字段，重启 Obsidian 后生效。',
      '已恢复原字段，重启 Obsidian 后生效。',
    ]);
  });

  it.each([
    [
      'loading',
      null,
      false,
      {
        description: '正在检查 TaskNotes 任务编辑字段…',
        showApply: false,
        showRestore: false,
        disabled: true,
      },
    ],
    [
      'missing',
      statusFixture({ available: false }),
      true,
      {
        description: 'TaskNotes 未安装或运行时不可用，无法管理字段。',
        showApply: false,
        showRestore: false,
        disabled: true,
      },
    ],
    [
      'unapplied',
      statusFixture(),
      true,
      {
        description: '当前未应用精简字段。',
        showApply: true,
        showRestore: false,
        disabled: false,
      },
    ],
    [
      'unapplied without Vault management permission',
      statusFixture(),
      false,
      {
        description: '当前未应用精简字段。',
        showApply: true,
        showRestore: false,
        disabled: true,
      },
    ],
    [
      'applied',
      statusFixture({ applied: true }),
      false,
      {
        description: '已隐藏 9 项低频或系统字段。',
        showApply: false,
        showRestore: false,
        disabled: true,
      },
    ],
    [
      'applied and restorable',
      statusFixture({ applied: true, restorable: true }),
      true,
      {
        description: '已隐藏 9 项低频或系统字段；可恢复原字段。',
        showApply: false,
        showRestore: true,
        disabled: false,
      },
    ],
    [
      'restorable',
      statusFixture({ restorable: true }),
      true,
      {
        description: '当前未应用精简字段；已保留可恢复的原字段备份。',
        showApply: true,
        showRestore: true,
        disabled: false,
      },
    ],
    [
      'restorable without Vault management permission',
      statusFixture({ restorable: true }),
      false,
      {
        description: '当前未应用精简字段；已保留可恢复的原字段备份。',
        showApply: true,
        showRestore: true,
        disabled: true,
      },
    ],
  ])('maps %s status into its field-control description and buttons', (_name, status, canManage, expected) => {
    expect(taskNotesFieldControlState(status, canManage)).toEqual(expected);
  });
});
