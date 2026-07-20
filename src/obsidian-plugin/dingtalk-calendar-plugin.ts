import type { DingTalkSyncResult } from './dingtalk-calendar-types.js';

export type DingTalkSyncSource = 'manual' | 'automatic';

export interface DingTalkCalendarPluginCommand {
  id: string;
  name: string;
  callback(): void;
}

export interface DingTalkCalendarPluginLifecycleDependencies {
  isDesktop: boolean;
  isEnabled: () => boolean;
  sync: () => Promise<DingTalkSyncResult>;
  addCommand: (command: DingTalkCalendarPluginCommand) => void;
  onLayoutReady: (callback: () => void) => void;
  registerInterval: (callback: () => void, milliseconds: number) => void;
  onSuccess: (result: DingTalkSyncResult, source: DingTalkSyncSource) => void;
  onError: (message: string) => void;
}

const INTERVAL_MILLISECONDS = 15 * 60 * 1000;
const REDACTED_SYNC_ERROR = '钉钉日历同步失败，请检查设置后重试';

export function formatDingTalkSyncResult(result: DingTalkSyncResult): string {
  return `钉钉日历同步完成：新增 ${result.added}，更新 ${result.updated}`
    + `，取消 ${result.cancelled}，跳过 ${result.skipped}，失败 ${result.errors}`;
}

export class DingTalkCalendarPluginLifecycle {
  private readonly dependencies: DingTalkCalendarPluginLifecycleDependencies;
  private inFlight: Promise<void> | null = null;

  constructor(dependencies: DingTalkCalendarPluginLifecycleDependencies) {
    this.dependencies = dependencies;
  }

  start(): void {
    this.dependencies.addCommand({
      id: 'sync-dingtalk-calendar',
      name: '立即同步钉钉日历',
      callback: () => {
        void this.run('manual');
      },
    });
    if (!this.dependencies.isDesktop) return;

    this.dependencies.onLayoutReady(() => {
      if (this.dependencies.isEnabled()) void this.run('automatic');
    });
    this.dependencies.registerInterval(() => {
      if (this.dependencies.isEnabled()) void this.run('automatic');
    }, INTERVAL_MILLISECONDS);
  }

  run(source: DingTalkSyncSource): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    let synchronization: Promise<DingTalkSyncResult>;
    try {
      synchronization = this.dependencies.sync();
    } catch {
      this.dependencies.onError(REDACTED_SYNC_ERROR);
      return Promise.resolve();
    }
    const operation = synchronization
      .then((result) => {
        this.dependencies.onSuccess(result, source);
      })
      .catch(() => {
        this.dependencies.onError(REDACTED_SYNC_ERROR);
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }
}
