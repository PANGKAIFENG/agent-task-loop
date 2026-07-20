import { isIP } from 'node:net';

import type {
  BackgroundSettings,
  BackgroundState,
} from './background-runtime-controller.js';
import type { DailyTokenUsage } from './opentoken-adapter.js';

export interface AtlPluginSettings {
  allowVaultManagement: boolean;
  taskCardThemeEnabled: boolean;
  capture: CaptureState;
  background: BackgroundSettings;
  dashboard: DashboardTokenCache;
}

export interface CaptureState {
  captureStateVersion: 2;
  lastSuccessfulScanAt: string | null;
  reviewedFingerprints: string[];
  processedRecordFingerprints: string[];
}

export interface DashboardTokenCache {
  tokenCacheVersion: 1;
  updatedAt: string | null;
  version: string | null;
  since: string | null;
  days: DailyTokenUsage[];
}

export const MAX_REVIEWED_FINGERPRINTS = 10_000;

export function compactReviewedFingerprints(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => (
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  )))].slice(-MAX_REVIEWED_FINGERPRINTS);
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
  capture: {
    captureStateVersion: 2,
    lastSuccessfulScanAt: null,
    reviewedFingerprints: [],
    processedRecordFingerprints: [],
  },
  background: DEFAULT_BACKGROUND_SETTINGS,
  dashboard: {
    tokenCacheVersion: 1,
    updatedAt: null,
    version: null,
    since: null,
    days: [],
  },
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '[::1]'
    || (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
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
      || (
        parsed.protocol === 'http:'
        && !isLoopbackHostname(parsed.hostname)
      )
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

function isRemoteHttpBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:'
      && !isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function timestampValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function localDateValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    ? value
    : null;
}

function tokenNumberValue(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function normalizeTokenDay(value: unknown): DailyTokenUsage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const day = value as Record<string, unknown>;
  const date = localDateValue(day.date);
  const numericKeys = [
    'normalized',
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
  ] as const;
  if (
    date === null
    || numericKeys.some((key) => !tokenNumberValue(day[key]))
    || !Array.isArray(day.tools)
    || day.tools.some((tool) => (
      typeof tool !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tool)
    ))
  ) {
    return null;
  }
  return {
    date,
    normalized: day.normalized as number,
    input: day.input as number,
    output: day.output as number,
    cacheRead: day.cacheRead as number,
    cacheWrite: day.cacheWrite as number,
    tools: [...new Set(day.tools as string[])].sort(),
  };
}

function normalizeDashboard(value: unknown): DashboardTokenCache {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS.dashboard, days: [] };
  }
  const raw = value as Record<string, unknown>;
  if (raw.tokenCacheVersion !== 1) {
    return { ...DEFAULT_SETTINGS.dashboard, days: [] };
  }
  const byDate = new Map<string, DailyTokenUsage>();
  if (Array.isArray(raw.days)) {
    for (const value of raw.days) {
      const day = normalizeTokenDay(value);
      if (day !== null) byDate.set(day.date, day);
    }
  }
  const days = [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-370);
  return {
    tokenCacheVersion: 1,
    updatedAt: timestampValue(raw.updatedAt),
    version: typeof raw.version === 'string'
      && /^[A-Za-z0-9._-]{1,64}$/.test(raw.version)
      ? raw.version
      : null,
    since: localDateValue(raw.since),
    days,
  };
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
    ? isRemoteHttpBaseUrl(input.baseUrl)
      ? 'Base URL 必须使用 HTTPS；本机地址可以使用 HTTP。'
      : 'Base URL 必须是完整的 http 或 https 地址。'
    : null;
  return {
    valid: modelError === null && baseUrlError === null,
    model,
    baseUrl,
    modelError,
    baseUrlError,
  };
}

export interface ModelServiceFieldState {
  showCustomFields: boolean;
  canApply: boolean;
  modelError: string | null;
  baseUrlError: string | null;
}

export function modelServiceFieldState(
  input: Pick<BackgroundSettings, 'modelServiceMode' | 'model' | 'baseUrl'>,
): ModelServiceFieldState {
  const configuration = modelServiceConfiguration(input);
  return {
    showCustomFields: input.modelServiceMode === 'custom',
    canApply: configuration.valid,
    modelError: configuration.modelError,
    baseUrlError: configuration.baseUrlError,
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
  const rawCapture = root.capture !== null && typeof root.capture === 'object'
    ? root.capture as Record<string, unknown>
    : {};
  const dashboard = normalizeDashboard(root.dashboard);
  const currentCaptureState = rawCapture.captureStateVersion === 2;
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
    capture: {
      captureStateVersion: 2,
      lastSuccessfulScanAt: timestampValue(rawCapture.lastSuccessfulScanAt),
      reviewedFingerprints: compactReviewedFingerprints(
        currentCaptureState && Array.isArray(rawCapture.reviewedFingerprints)
          ? rawCapture.reviewedFingerprints
          : [],
      ),
      processedRecordFingerprints: compactReviewedFingerprints(
        currentCaptureState && Array.isArray(rawCapture.processedRecordFingerprints)
          ? rawCapture.processedRecordFingerprints
          : [],
      ),
    },
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
    dashboard,
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
