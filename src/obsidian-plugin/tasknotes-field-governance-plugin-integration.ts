import {
  TaskNotesFieldGovernanceController,
  type TaskNotesFieldGovernanceBackupStore,
  type TaskNotesFieldGovernanceStatus,
  type TaskNotesFieldLayoutBackup,
} from './tasknotes-field-governance-controller.js';

type AtlTaskNotesFieldSettings = {
  allowVaultManagement: boolean;
  taskNotesFieldLayoutBackup?: unknown;
};

export interface TaskNotesPluginRegistry {
  getPlugin(id: string): unknown;
}

export interface TaskNotesFieldGovernanceActions {
  status(): Promise<TaskNotesFieldGovernanceStatus>;
  applyPreset(): Promise<void>;
  restorePreset(): Promise<void>;
}

export interface TaskNotesFieldGovernancePluginIntegrationOptions {
  registry?: TaskNotesPluginRegistry | undefined;
  getSettings(): AtlTaskNotesFieldSettings;
  saveSettings(): Promise<void>;
  notice(message: string): void;
  createActions?: (
    runtime: unknown,
    backups: TaskNotesFieldGovernanceBackupStore,
  ) => TaskNotesFieldGovernanceActions;
}

export interface TaskNotesFieldControlState {
  description: string;
  showApply: boolean;
  showRestore: boolean;
  disabled: boolean;
}

const VAULT_PERMISSION_NOTICE = '请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

export function taskNotesFieldControlState(
  status: TaskNotesFieldGovernanceStatus | null,
  canManage: boolean,
): TaskNotesFieldControlState {
  if (status === null) {
    return {
      description: '正在检查 TaskNotes 任务编辑字段…',
      showApply: false,
      showRestore: false,
      disabled: true,
    };
  }
  if (!status.available) {
    return {
      description: 'TaskNotes 未安装或运行时不可用，无法管理字段。',
      showApply: false,
      showRestore: false,
      disabled: true,
    };
  }
  if (status.applied) {
    return {
      description: status.restorable
        ? '已隐藏 9 项低频或系统字段；可恢复原字段。'
        : '已隐藏 9 项低频或系统字段。',
      showApply: false,
      showRestore: status.restorable,
      disabled: !canManage,
    };
  }
  return {
    description: status.restorable
      ? '当前未应用精简字段；已保留可恢复的原字段备份。'
      : '当前未应用精简字段。',
    showApply: true,
    showRestore: status.restorable,
    disabled: !canManage,
  };
}

export function createTaskNotesFieldGovernancePluginIntegration(
  options: TaskNotesFieldGovernancePluginIntegrationOptions,
) {
  const backups: TaskNotesFieldGovernanceBackupStore = {
    getBackup: async () => options.getSettings().taskNotesFieldLayoutBackup,
    persistFirstBackup: async (backup: TaskNotesFieldLayoutBackup) => {
      const settings = options.getSettings();
      const previous = settings.taskNotesFieldLayoutBackup;
      if (previous !== undefined && previous !== null) return;
      settings.taskNotesFieldLayoutBackup = backup;
      try {
        await options.saveSettings();
      } catch (error) {
        if (previous === undefined) {
          delete settings.taskNotesFieldLayoutBackup;
        } else {
          settings.taskNotesFieldLayoutBackup = previous;
        }
        throw error;
      }
    },
  };

  const actions = (): TaskNotesFieldGovernanceActions => {
    const runtime = options.registry?.getPlugin('tasknotes');
    return options.createActions?.(runtime, backups)
      ?? new TaskNotesFieldGovernanceController(runtime, backups);
  };

  const run = async (
    action: 'applyPreset' | 'restorePreset',
    successNotice: string,
    failureNotice: string,
  ): Promise<void> => {
    if (!options.getSettings().allowVaultManagement) {
      options.notice(VAULT_PERMISSION_NOTICE);
      return;
    }
    try {
      await actions()[action]();
      options.notice(successNotice);
    } catch (error) {
      options.notice(errorMessage(error, failureNotice));
    }
  };

  return {
    status: async (): Promise<TaskNotesFieldGovernanceStatus> => actions().status(),
    apply: async (): Promise<void> => run(
      'applyPreset',
      '已应用精简字段，重启 Obsidian 后生效。',
      '无法应用精简字段',
    ),
    restore: async (): Promise<void> => run(
      'restorePreset',
      '已恢复原字段，重启 Obsidian 后生效。',
      '无法恢复原字段',
    ),
  };
}
