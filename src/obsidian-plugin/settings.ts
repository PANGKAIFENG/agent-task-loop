import { isIP } from 'node:net';

import type {
  BackgroundSettings,
  BackgroundState,
} from './background-runtime-controller.js';
import type { DailyTokenUsage } from './opentoken-adapter.js';
import type {
  DingTalkCalendarSettings,
  DingTalkEventLedgerEntry,
  DingTalkRemoteSnapshot,
  DingTalkSyncResult,
} from './dingtalk-calendar-types.js';

export interface AtlPluginSettings {
  allowVaultManagement: boolean;
  taskCardThemeEnabled: boolean;
  capture: CaptureState;
  background: BackgroundSettings;
  dashboard: DashboardTokenCache;
  dingtalkCalendar: DingTalkCalendarSettings;
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
  dingtalkCalendar: {
    stateVersion: 1,
    enabled: false,
    serverUrl: '',
    username: '',
    calendarId: 'primary',
    syncWindowDays: 90,
    intervalMinutes: 15,
    syncToken: null,
    lastSuccessfulSyncAt: null,
    lastResult: null,
    lastError: null,
    events: {},
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

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string'
    && value.length <= maximum
    && !/[\0\r\n]/.test(value)
    ? value
    : null;
}

function normalizeCalendarUrl(value: unknown): string {
  const normalized = normalizeBaseUrl(value);
  if (normalized === undefined) return '';
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' || isLoopbackHostname(parsed.hostname)
      ? normalized
      : '';
  } catch {
    return '';
  }
}

function remoteSnapshot(value: unknown): DingTalkRemoteSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = boundedString(raw.title, 1000);
  const start = boundedString(raw.start, 64);
  const end = raw.end === null ? null : boundedString(raw.end, 64);
  const description = raw.description === null
    ? null
    : boundedString(raw.description, 100_000);
  const location = raw.location === null ? null : boundedString(raw.location, 2000);
  if (
    title === null
    || start === null
    || end === null && raw.end !== null
    || typeof raw.allDay !== 'boolean'
    || description === null && raw.description !== null
    || location === null && raw.location !== null
    || (raw.state !== 'active' && raw.state !== 'cancelled')
  ) return null;
  return {
    title,
    start,
    end,
    allDay: raw.allDay,
    description,
    location,
    state: raw.state,
  };
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function ledgerEntry(key: string, value: unknown): DingTalkEventLedgerEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const snapshot = remoteSnapshot(raw.remoteSnapshot);
  const eventKeyHash = boundedString(raw.eventKeyHash, 71);
  const remoteUid = boundedString(raw.remoteUid, 2000);
  const recurrenceId = raw.recurrenceId === null
    ? null
    : boundedString(raw.recurrenceId, 128);
  const href = boundedString(raw.href, 4000);
  const etag = raw.etag === null ? null : boundedString(raw.etag, 1000);
  const taskPath = raw.taskPath === null ? null : boundedString(raw.taskPath, 4000);
  const remoteSnapshotHash = boundedString(raw.remoteSnapshotHash, 71);
  const lastSeenAt = timestampValue(raw.lastSeenAt);
  const locallyDeletedAt = raw.locallyDeletedAt === null
    ? null
    : timestampValue(raw.locallyDeletedAt);
  if (
    eventKeyHash !== key
    || !SHA256_PATTERN.test(eventKeyHash)
    || remoteUid === null
    || recurrenceId === null && raw.recurrenceId !== null
    || href === null
    || etag === null && raw.etag !== null
    || taskPath === null && raw.taskPath !== null
    || remoteSnapshotHash === null
    || !SHA256_PATTERN.test(remoteSnapshotHash)
    || snapshot === null
    || lastSeenAt === null
    || locallyDeletedAt === null && raw.locallyDeletedAt !== null
    || typeof raw.cancelledBySync !== 'boolean'
  ) return null;
  return {
    eventKeyHash,
    remoteUid,
    recurrenceId,
    href,
    etag,
    taskPath,
    remoteSnapshotHash,
    remoteSnapshot: snapshot,
    lastSeenAt,
    locallyDeletedAt,
    cancelledBySync: raw.cancelledBySync,
  };
}

function syncCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function syncResult(value: unknown): DingTalkSyncResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const startedAt = timestampValue(raw.startedAt);
  const finishedAt = timestampValue(raw.finishedAt);
  const counts = {
    added: syncCount(raw.added),
    updated: syncCount(raw.updated),
    cancelled: syncCount(raw.cancelled),
    skipped: syncCount(raw.skipped),
    conflicts: syncCount(raw.conflicts),
    errors: syncCount(raw.errors),
  };
  if (
    startedAt === null
    || finishedAt === null
    || Object.values(counts).some((count) => count === null)
  ) return null;
  return {
    startedAt,
    finishedAt,
    added: counts.added as number,
    updated: counts.updated as number,
    cancelled: counts.cancelled as number,
    skipped: counts.skipped as number,
    conflicts: counts.conflicts as number,
    errors: counts.errors as number,
  };
}

function normalizeDingTalkCalendar(value: unknown): DingTalkCalendarSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS.dingtalkCalendar, events: {} };
  }
  const raw = value as Record<string, unknown>;
  if (raw.stateVersion !== 1) {
    return { ...DEFAULT_SETTINGS.dingtalkCalendar, events: {} };
  }
  const serverUrl = normalizeCalendarUrl(raw.serverUrl);
  const username = boundedString(raw.username, 320)?.trim() ?? '';
  const rawEvents = raw.events !== null
    && typeof raw.events === 'object'
    && !Array.isArray(raw.events)
    ? Object.entries(raw.events as Record<string, unknown>)
    : [];
  const entries = rawEvents.flatMap(([key, entry]) => {
    const normalized = ledgerEntry(key, entry);
    return normalized === null ? [] : [[key, normalized] as const];
  }).sort((left, right) => (
    left[1].lastSeenAt.localeCompare(right[1].lastSeenAt)
  )).slice(-5000);
  const lastError = raw.lastError === null ? null : boundedString(raw.lastError, 1000);
  return {
    stateVersion: 1,
    enabled: raw.enabled === true && serverUrl !== '' && username !== '',
    serverUrl,
    username,
    calendarId: 'primary',
    syncWindowDays: 90,
    intervalMinutes: 15,
    syncToken: raw.syncToken === null ? null : boundedString(raw.syncToken, 4000),
    lastSuccessfulSyncAt: timestampValue(raw.lastSuccessfulSyncAt),
    lastResult: syncResult(raw.lastResult),
    lastError: lastError === null && raw.lastError !== null ? null : lastError,
    events: Object.fromEntries(entries),
  };
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
  const dingtalkCalendar = normalizeDingTalkCalendar(root.dingtalkCalendar);
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
    dingtalkCalendar,
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
