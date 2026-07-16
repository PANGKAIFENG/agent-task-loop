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
  modelServiceMode: 'inherit',
  model: 'claude-sonnet-4-5',
  baseUrl: '',
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

function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.hostname === ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return undefined;
    }
    const serialized = parsed.toString();
    return parsed.pathname === '/'
      && !candidate.endsWith('/')
      && serialized.endsWith('/')
      ? serialized.slice(0, -1)
      : serialized;
  } catch {
    return undefined;
  }
}

export interface ModelServiceConfiguration {
  valid: boolean;
  model: string | undefined;
  baseUrl: string | undefined;
  modelError: string | null;
  baseUrlError: string | null;
}

export function modelServiceConfiguration(
  input: Pick<BackgroundSettings, 'modelServiceMode' | 'model' | 'baseUrl'>,
): ModelServiceConfiguration {
  if (input.modelServiceMode === 'inherit') {
    return {
      valid: true,
      model: undefined,
      baseUrl: undefined,
      modelError: null,
      baseUrlError: null,
    };
  }
  const model = modelValue(input.model) === input.model
    ? input.model
    : undefined;
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const modelError = model === undefined
    ? 'Model 格式无效，请检查模型名称。'
    : null;
  const baseUrlError = baseUrl === undefined
    ? 'Base URL 必须是完整的 http 或 https 地址。'
    : null;
  return {
    valid: modelError === null && baseUrlError === null,
    model,
    baseUrl,
    modelError,
    baseUrlError,
  };
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
  const model = modelValue(rawBackground.model);
  const baseUrl = normalizeBaseUrl(rawBackground.baseUrl) ?? '';
  const rawMode = rawBackground.modelServiceMode;
  const modelServiceMode = rawMode === 'custom'
    || (
      rawMode === undefined
      && model !== DEFAULT_BACKGROUND_SETTINGS.model
      && baseUrl !== ''
    )
    ? 'custom'
    : 'inherit';
  return {
    allowVaultManagement: root.allowVaultManagement === true,
    taskCardThemeEnabled: root.taskCardThemeEnabled !== false,
    background: {
      nodeExecutable: stringValue(rawBackground.nodeExecutable),
      claudeExecutable: stringValue(rawBackground.claudeExecutable),
      claudeConfigDirectory: stringValue(rawBackground.claudeConfigDirectory),
      allowedLocalRoots: [...new Set(roots)],
      modelServiceMode,
      model,
      baseUrl,
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
