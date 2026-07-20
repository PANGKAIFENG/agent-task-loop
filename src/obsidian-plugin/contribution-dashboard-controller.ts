import {
  queryContribution,
  type ContributionRange,
  type ContributionSnapshot,
} from '../services/query-contribution.js';
import type { ServiceContext } from '../services/service-context.js';
import {
  OpenTokenAdapterError,
  type OpenTokenSnapshot,
} from './opentoken-adapter.js';
import type { DashboardTokenCache } from './settings.js';

export interface ContributionDashboardState {
  range: ContributionRange;
  selectedDate: string;
  contribution: {
    status: 'loading' | 'ready' | 'error';
    snapshot: ContributionSnapshot | null;
    errorCode: string | null;
  };
  token: {
    status: 'loading' | 'cached' | 'ready' | 'missing' | 'stale' | 'error';
    snapshot: OpenTokenSnapshot | null;
    errorCode: string | null;
  };
  refreshing: boolean;
}

export interface ContributionDashboardDependencies {
  context: ServiceContext;
  openToken: { preview(since: string): Promise<OpenTokenSnapshot> };
  getTokenCache: () => DashboardTokenCache;
  saveTokenCache: (cache: DashboardTokenCache) => Promise<void>;
  clock: () => Date;
  timeZone: string;
}

type StateListener = (state: ContributionDashboardState) => void;

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    day: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
  });
}

function localDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date)
    .map(({ type, value }) => [type, value]));
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
}

function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function rangeStart(today: string, range: ContributionRange): string {
  switch (range) {
    case '7d': return addDays(today, -6);
    case '12w': return addDays(today, -83);
    case '1y': return addDays(today, -364);
  }
}

function snapshotFromCache(cache: DashboardTokenCache): OpenTokenSnapshot | null {
  if (
    cache.days.length === 0
    || cache.updatedAt === null
    || cache.version === null
    || cache.since === null
  ) return null;
  return {
    version: cache.version,
    updatedAt: cache.updatedAt,
    since: cache.since,
    days: cache.days,
  };
}

function cacheFromSnapshot(snapshot: OpenTokenSnapshot): DashboardTokenCache {
  return {
    tokenCacheVersion: 1,
    updatedAt: snapshot.updatedAt,
    version: snapshot.version,
    since: snapshot.since,
    days: snapshot.days,
  };
}

export class ContributionDashboardController {
  private readonly dependencies: ContributionDashboardDependencies;
  private readonly listeners = new Set<StateListener>();
  private state: ContributionDashboardState;
  private disposed = false;
  private tokenRefresh: Promise<void> | null = null;
  private pendingTokenSince: string | null = null;
  private allRefresh: Promise<void> | null = null;

  constructor(dependencies: ContributionDashboardDependencies) {
    this.dependencies = dependencies;
    const today = localDate(dependencies.clock(), dependencies.timeZone);
    const cached = snapshotFromCache(dependencies.getTokenCache());
    this.state = {
      range: '12w',
      selectedDate: today,
      contribution: { status: 'loading', snapshot: null, errorCode: null },
      token: {
        status: cached === null ? 'loading' : 'cached',
        snapshot: cached,
        errorCode: null,
      },
      refreshing: false,
    };
  }

  getState(): ContributionDashboardState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.refreshContribution();
    if (!this.disposed) this.startTokenRefresh(this.requiredTokenSince());
  }

  async setRange(range: ContributionRange): Promise<void> {
    if (this.disposed || this.state.range === range) return;
    this.patch({ range });
    await this.refreshContribution();
    const since = this.requiredTokenSince();
    if (!this.tokenCovers(since)) this.startTokenRefresh(since);
  }

  async setSelectedDate(selectedDate: string): Promise<void> {
    if (this.disposed || this.state.selectedDate === selectedDate) return;
    this.patch({ selectedDate });
    await this.refreshContribution();
  }

  refreshContribution(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.patch({
      contribution: {
        status: 'loading',
        snapshot: this.state.contribution.snapshot,
        errorCode: null,
      },
    });
    return this.loadContribution();
  }

  refreshAll(): Promise<void> {
    if (this.allRefresh !== null) return this.allRefresh;
    const operation = Promise.all([
      this.refreshContribution(),
      this.startTokenRefresh(this.requiredTokenSince()),
    ]).then(() => undefined).finally(() => {
      if (this.allRefresh === operation) this.allRefresh = null;
    });
    this.allRefresh = operation;
    return operation;
  }

  async waitForTokenRefresh(): Promise<void> {
    while (this.tokenRefresh !== null) {
      await this.tokenRefresh;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private async loadContribution(): Promise<void> {
    const now = this.dependencies.clock();
    try {
      const from = new Date(0).toISOString();
      const to = new Date(now.getTime() + 2 * 86_400_000).toISOString();
      const [tasks, projects, auditEvents] = await Promise.all([
        this.dependencies.context.tasks.list(),
        this.dependencies.context.projects.list(),
        this.dependencies.context.audit.listBetween({
          fromInclusive: from,
          toExclusive: to,
        }),
      ]);
      if (this.disposed) return;
      const snapshot = queryContribution({
        tasks,
        projects,
        auditEvents,
        now,
        timeZone: this.dependencies.timeZone,
        range: this.state.range,
        selectedDate: this.state.selectedDate,
      });
      this.patch({
        contribution: { status: 'ready', snapshot, errorCode: null },
      });
    } catch {
      if (!this.disposed) {
        this.patch({
          contribution: {
            status: 'error',
            snapshot: this.state.contribution.snapshot,
            errorCode: 'query_failed',
          },
        });
      }
    }
  }

  private startTokenRefresh(since: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.tokenRefresh !== null) {
      if (this.pendingTokenSince === null || since < this.pendingTokenSince) {
        this.pendingTokenSince = since;
      }
      return this.tokenRefresh;
    }
    this.patch({ refreshing: true });
    const operation = this.loadToken(since).finally(() => {
      if (this.tokenRefresh === operation) this.tokenRefresh = null;
      const pendingSince = this.pendingTokenSince;
      this.pendingTokenSince = null;
      if (!this.disposed) {
        this.patch({ refreshing: false });
        if (pendingSince !== null && this.state.token.errorCode !== 'missing'
          && !this.tokenCovers(pendingSince)) {
          void this.startTokenRefresh(pendingSince);
        }
      }
    });
    this.tokenRefresh = operation;
    return operation;
  }

  private async loadToken(since: string): Promise<void> {
    try {
      const snapshot = await this.dependencies.openToken.preview(since);
      if (this.disposed) return;
      try {
        await this.dependencies.saveTokenCache(cacheFromSnapshot(snapshot));
      } catch {
        // Cache persistence must not invalidate a successful read-only snapshot.
      }
      if (this.disposed) return;
      this.patch({
        token: { status: 'ready', snapshot, errorCode: null },
      });
    } catch (error) {
      if (this.disposed) return;
      const code = error instanceof OpenTokenAdapterError
        ? error.code
        : 'process_failed';
      const snapshot = this.state.token.snapshot;
      this.patch({
        token: {
          status: snapshot !== null ? 'stale' : code === 'missing' ? 'missing' : 'error',
          snapshot,
          errorCode: code,
        },
      });
    }
  }

  private requiredTokenSince(): string {
    const today = localDate(this.dependencies.clock(), this.dependencies.timeZone);
    return rangeStart(today, this.state.range);
  }

  private tokenCovers(since: string): boolean {
    return this.state.token.snapshot?.since !== undefined
      && this.state.token.snapshot.since <= since;
  }

  private patch(patch: Partial<ContributionDashboardState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
