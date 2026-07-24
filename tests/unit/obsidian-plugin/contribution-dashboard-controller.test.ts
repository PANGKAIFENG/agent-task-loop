import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  ContributionDashboardController,
  type ContributionDashboardState,
} from '../../../src/obsidian-plugin/contribution-dashboard-controller.js';
import { OpenTokenAdapterError } from '../../../src/obsidian-plugin/opentoken-adapter.js';
import type { DashboardTokenCache } from '../../../src/obsidian-plugin/settings.js';
import type { ServiceContext } from '../../../src/services/service-context.js';

const NOW = new Date('2026-07-20T10:00:00+08:00');

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-a',
    title: 'Completed task',
    body: '',
    status: 'done',
    reviewState: 'confirmed',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'source-a',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function context(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    tasks: {
      list: async () => [task()],
    } as ServiceContext['tasks'],
    projects: {
      list: async () => [],
    } as unknown as ServiceContext['projects'],
    audit: {
      listBetween: async () => [{
        event: 'task.lifecycle_reconciled',
        at: '2026-07-20T09:00:00+08:00',
        taskId: 'task-a',
        details: { status: 'done' },
      }],
    } as unknown as ServiceContext['audit'],
    artifacts: {} as ServiceContext['artifacts'],
    clock: () => NOW,
    id: () => 'unused',
    ...overrides,
  };
}

function cache(): DashboardTokenCache {
  return {
    tokenCacheVersion: 1,
    updatedAt: '2026-07-20T01:00:00.000Z',
    version: '0.3.11',
    since: '2026-07-01',
    days: [{
      date: '2026-07-20',
      normalized: 120,
      input: 100,
      output: 20,
      cacheRead: 40,
      cacheWrite: 0,
      tools: ['codex'],
    }],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('ContributionDashboardController', () => {
  it('opens the personal pulse on the confirmed 26-week range', () => {
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview: async () => snapshot() },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    expect(controller.getState().range).toBe('26w');
  });

  it('publishes cached tokens before the asynchronous refresh completes', async () => {
    const refresh = deferred<ReturnType<typeof snapshot>>();
    const states: ContributionDashboardState[] = [];
    const saveTokenCache = vi.fn(async () => undefined);
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview: async () => refresh.promise },
      getTokenCache: cache,
      saveTokenCache,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });
    controller.subscribe((state) => states.push(state));

    await controller.initialize();

    expect(states.some((state) => state.token.status === 'cached')).toBe(true);
    expect(controller.getState().contribution.snapshot?.kpis.completedToday).toBe(1);
    expect(controller.getState().home.snapshot).toMatchObject({
      counts: { inbox: 0, ready: 0, inProgress: 0, review: 0, blocked: 0 },
      nextAction: null,
    });
    refresh.resolve(snapshot());
    await controller.waitForTokenRefresh();
    expect(controller.getState().token.status).toBe('ready');
    expect(saveTokenCache).toHaveBeenCalledOnce();
  });

  it('loads the full audit history for streak and coverage calculations', async () => {
    const listBetween = vi.fn(async () => []);
    const controller = new ContributionDashboardController({
      context: context({
        audit: { listBetween } as unknown as ServiceContext['audit'],
      }),
      openToken: { preview: async () => snapshot() },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();

    expect(listBetween).toHaveBeenCalledWith({
      fromInclusive: '1970-01-01T00:00:00.000Z',
      toExclusive: '2026-07-22T02:00:00.000Z',
    });
  });

  it('keeps task contribution available when OpenToken is missing', async () => {
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview: async () => { throw new OpenTokenAdapterError('missing'); } },
      getTokenCache: () => ({ ...cache(), days: [] }),
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();
    await controller.waitForTokenRefresh();

    expect(controller.getState()).toMatchObject({
      contribution: { status: 'ready' },
      token: { status: 'missing', snapshot: null },
    });
  });

  it('keeps stale cache when a token refresh fails', async () => {
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview: async () => { throw new Error('private error'); } },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();
    await controller.waitForTokenRefresh();

    expect(controller.getState().token).toMatchObject({
      status: 'stale',
      errorCode: 'process_failed',
      snapshot: { version: '0.3.11' },
    });
  });

  it('keeps a fresh token snapshot when cache persistence fails', async () => {
    const fresh = snapshot();
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview: async () => fresh },
      getTokenCache: () => ({ ...cache(), days: [] }),
      saveTokenCache: async () => { throw new Error('disk full'); },
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();
    await controller.waitForTokenRefresh();

    expect(controller.getState().token).toMatchObject({
      status: 'ready',
      snapshot: fresh,
    });
  });

  it('deduplicates concurrent manual refreshes', async () => {
    const refresh = deferred<ReturnType<typeof snapshot>>();
    const preview = vi.fn(async () => refresh.promise);
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    const first = controller.refreshAll();
    const second = controller.refreshAll();
    await Promise.resolve();
    expect(preview).toHaveBeenCalledOnce();
    refresh.resolve(snapshot());
    await Promise.all([first, second]);
  });

  it('changes selected date without rescanning OpenToken', async () => {
    const preview = vi.fn(async () => snapshot());
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });
    await controller.initialize();
    await controller.waitForTokenRefresh();
    preview.mockClear();

    await controller.setSelectedDate('2026-07-19');

    expect(controller.getState().selectedDate).toBe('2026-07-19');
    expect(preview).not.toHaveBeenCalled();
  });

  it('rescans only when a selected range exceeds loaded token coverage', async () => {
    const preview = vi.fn()
      .mockResolvedValueOnce(snapshot('2026-07-14'))
      .mockResolvedValueOnce(snapshot('2025-07-21'));
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview },
      getTokenCache: cache,
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });
    await controller.initialize();
    await controller.waitForTokenRefresh();
    preview.mockClear();

    await controller.setRange('7d');
    expect(preview).not.toHaveBeenCalled();
    await controller.setRange('1y');
    await controller.waitForTokenRefresh();
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith('2025-07-21');
  });

  it('queues a wider token scan selected while the initial scan is running', async () => {
    const initialRefresh = deferred<ReturnType<typeof snapshot>>();
    const preview = vi.fn()
      .mockImplementationOnce(async () => initialRefresh.promise)
      .mockResolvedValueOnce(snapshot('2025-07-21'));
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview },
      getTokenCache: () => ({ ...cache(), days: [] }),
      saveTokenCache: async () => { throw new Error('disk full'); },
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();
    await controller.setRange('1y');
    initialRefresh.resolve(snapshot('2026-04-28'));
    await controller.waitForTokenRefresh();

    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith('2025-07-21');
    expect(controller.getState().token.snapshot?.since).toBe('2025-07-21');
  });

  it('retries a queued wider scan after the initial token scan fails', async () => {
    const initialRefresh = deferred<ReturnType<typeof snapshot>>();
    const preview = vi.fn()
      .mockImplementationOnce(async () => initialRefresh.promise)
      .mockResolvedValueOnce(snapshot('2025-07-21'));
    const controller = new ContributionDashboardController({
      context: context(),
      openToken: { preview },
      getTokenCache: () => ({ ...cache(), days: [] }),
      saveTokenCache: async () => undefined,
      clock: () => NOW,
      timeZone: 'Asia/Shanghai',
    });

    await controller.initialize();
    await controller.setRange('1y');
    initialRefresh.reject(new OpenTokenAdapterError('timeout'));
    await controller.waitForTokenRefresh();

    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith('2025-07-21');
    expect(controller.getState().token).toMatchObject({
      status: 'ready',
      snapshot: { since: '2025-07-21' },
    });
  });
});

function snapshot(since = '2026-07-14') {
  return {
    version: '0.3.11',
    updatedAt: '2026-07-20T02:00:00.000Z',
    since,
    days: [{
      date: '2026-07-20',
      normalized: 180,
      input: 150,
      output: 30,
      cacheRead: 45,
      cacheWrite: 2,
      tools: ['claude-code', 'codex'],
    }],
  };
}
