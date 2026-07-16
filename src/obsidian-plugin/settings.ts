import type {
  BackgroundSettings,
  BackgroundState,
} from './background-runtime-controller.js';

export interface AtlPluginSettings {
  allowVaultManagement: boolean;
  taskCardThemeEnabled: boolean;
  background: BackgroundSettings;
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  nodeExecutable: '',
  claudeExecutable: '',
  claudeConfigDirectory: '',
  allowedLocalRoots: [],
  model: 'claude-sonnet-4-5',
  dailyLimit: 3,
};

export const DEFAULT_SETTINGS: AtlPluginSettings = {
  allowVaultManagement: false,
  taskCardThemeEnabled: true,
  background: DEFAULT_BACKGROUND_SETTINGS,
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function modelValue(value: unknown): string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
    ? value
    : DEFAULT_BACKGROUND_SETTINGS.model;
}

export function normalizeSettings(value: unknown): AtlPluginSettings {
  const root = value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const rawBackground = root.background !== null
    && typeof root.background === 'object'
    ? root.background as Record<string, unknown>
    : {};
  const roots = Array.isArray(rawBackground.allowedLocalRoots)
    ? rawBackground.allowedLocalRoots.filter((path): path is string => (
      typeof path === 'string' && path.trim() !== ''
    ))
    : [];
  return {
    allowVaultManagement: root.allowVaultManagement === true,
    taskCardThemeEnabled: root.taskCardThemeEnabled !== false,
    background: {
      nodeExecutable: stringValue(rawBackground.nodeExecutable),
      claudeExecutable: stringValue(rawBackground.claudeExecutable),
      claudeConfigDirectory: stringValue(rawBackground.claudeConfigDirectory),
      allowedLocalRoots: [...new Set(roots)],
      model: modelValue(rawBackground.model),
      dailyLimit: Number.isSafeInteger(rawBackground.dailyLimit)
        && Number(rawBackground.dailyLimit) > 0
        ? Number(rawBackground.dailyLimit)
        : DEFAULT_BACKGROUND_SETTINGS.dailyLimit,
    },
  };
}

export interface BackgroundActionState {
  primaryLabel: string;
  canRunNow: boolean;
  canDisable: boolean;
}

export function backgroundActionState(
  inspection: Pick<{ state: BackgroundState }, 'state'>,
): BackgroundActionState {
  switch (inspection.state) {
    case 'installable':
      return {
        primaryLabel: '启用后台执行',
        canRunNow: false,
        canDisable: false,
      };
    case 'ready':
      return {
        primaryLabel: '更新后台配置',
        canRunNow: true,
        canDisable: true,
      };
    case 'running':
      return {
        primaryLabel: '更新后台配置',
        canRunNow: false,
        canDisable: true,
      };
    case 'error':
      return {
        primaryLabel: '重新检测',
        canRunNow: false,
        canDisable: true,
      };
    case 'unconfigured':
      return {
        primaryLabel: '检测环境',
        canRunNow: false,
        canDisable: false,
      };
  }
}
