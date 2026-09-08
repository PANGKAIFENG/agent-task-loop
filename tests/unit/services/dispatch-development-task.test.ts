import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MulticaCommandRunner,
  MulticaDispatchConnector,
} from '../../../src/connectors/multica-cli-connector.js';
import { MulticaCliConnector } from '../../../src/connectors/multica-cli-connector.js';
import { executionLinkIdempotencyKey } from '../../../src/domain/execution-link.js';
import type { Task } from '../../../src/domain/task.js';
import type { TaskRepository } from '../../../src/storage/contracts.js';
import {
  DevelopmentDispatchNotAdmittedError,
  DevelopmentDispatchWriteBackError,
  MULTICA_DISPATCH_IN_FLIGHT_MS,
  attemptAgeMs,
  buildDispatchEnvelope,
  dispatchDevelopmentTask,
  freshExecutionLink,
  type DispatchDevelopmentTaskDependencies,
} from '../../../src/services/dispatch-development-task.js';
import type { ServiceContext } from '../../../src/services/service-context.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';
const RUN_ID = 'run-initial';

interface FakeConnectorCall {
  kind: 'ensureIssue' | 'inspect';
  idempotencyKey?: string;
}

class FakeConnector implements MulticaDispatchConnector {
  ensureIssueCalls: FakeConnectorCall[] = [];
  remoteIssuesByMetadata = 0;
  createdIssues = 0;

  async ensureIssue(envelope: { idempotencyKey: string }): Promise<{
    status: 'linked';
    ref: { issueId: string; issueIdentifier: string };
    recovered: boolean;
    activation: { assigneeId: string; runId: string; recovered: boolean };
  }> {
    this.ensureIssueCalls.push({ kind: 'ensureIssue', idempotencyKey: envelope.idempotencyKey });
    if (this.remoteIssuesByMetadata === 0) {
      this.createdIssues += 1;
    } else {
      this.remoteIssuesByMetadata -= 1;
    }
    return {
      status: 'linked',
      ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
      recovered: true,
      activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: true },
    };
  }

  async inspect(): Promise<never> {
    this.ensureIssueCalls.push({ kind: 'inspect' });
    throw new Error('inspect is not part of the dispatch path');
  }

  createdIssueCount(): number {
    return this.createdIssues;
  }
}

class SaveFailingTaskRepository implements TaskRepository {
  private saves = 0;

  constructor(
    private readonly delegate: TaskRepository,
    private readonly failOnSaveCalls: readonly number[],
  ) {}

  async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    return this.delegate.withTaskLock(taskId, operation);
  }

  async list(): Promise<Task[]> {
    return this.delegate.list();
  }

  async get(taskId: string): Promise<Task> {
    return this.delegate.get(taskId);
  }

  async findBySourceKey(sourceKey: string): Promise<Task | null> {
    return this.delegate.findBySourceKey(sourceKey);
  }

  async createIfSourceKeyAbsent(task: Task) {
    return this.delegate.createIfSourceKeyAbsent(task);
  }

  async save(task: Task): Promise<Task> {
    this.saves += 1;
    if (this.failOnSaveCalls.includes(this.saves)) {
      throw new Error('simulated local write-back failure');
    }
    return this.delegate.save(task);
  }

  async saveBody(task: Task): Promise<Task> {
    return this.delegate.saveBody(task);
  }

  saveCount(): number {
    return this.saves;
  }
}

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260820-abc00001',
    title: 'Ship the dispatch slice',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Deliver the unique Multica dispatch',
    acceptanceCriteria: ['Exactly one remote issue per authorized task'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:development-1',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

// FIX-3 helpers: a shared virtual clock plus a runner that models the
// worst-case legitimate slow CLI — every call consumes its full (already
// budget-clipped) timeout and every marker-scan page comes back full, so the
// board keeps paging. Unbounded, this workload runs for minutes; it is what
// used to outlive the 120s single-flight lease from entry points that carry
// no deadline of their own.
function sharedClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    nowMs: () => nowMs,
    advanceBy: (ms: number) => {
      nowMs += ms;
    },
  };
}

interface SlowRunnerCall {
  startedAtMs: number;
  timeoutMs: number | undefined;
  args: string[];
}

function fillerIssue(index: number) {
  return {
    id: `t1-filler-${index}`,
    identifier: `TEP-${1000 + index}`,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: `T1 filler board issue ${index}`,
    description: `Unrelated board filler ${index}; it carries no ATL marker.`,
    status: 'backlog',
  };
}

class SlowBoardRunner {
  readonly calls: SlowRunnerCall[] = [];
  readonly gateEntered: Promise<void>;
  private readonly gateAtIndex: number | null;
  private resolveGateEntered: (() => void) | null = null;
  private releaseGate: (() => void) | null = null;

  constructor(
    private readonly clock: ReturnType<typeof sharedClock>,
    gateAtIndex: number | null,
  ) {
    this.gateAtIndex = gateAtIndex;
    this.gateEntered = gateAtIndex === null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        this.resolveGateEntered = resolve;
      });
  }

  run: MulticaCommandRunner = async (request) => {
    const startedAtMs = this.clock.nowMs();
    this.calls.push({ startedAtMs, timeoutMs: request.timeoutMs, args: [...request.args] });
    if (this.gateAtIndex === this.calls.length - 1) {
      this.resolveGateEntered?.();
      await new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
    }
    this.clock.advanceBy(request.timeoutMs ?? 0);
    if (request.args.includes('list')) {
      // The remote-filtered metadata search has no match (short page, done);
      // the unfiltered marker scan pages over an endless board.
      if (request.args.includes('--metadata')) {
        return { stdout: JSON.stringify({ issues: [] }), stderr: '' };
      }
      const offset = Number(request.args[request.args.indexOf('--offset') + 1]);
      const limit = Number(request.args[request.args.indexOf('--limit') + 1]);
      const issues = Array.from({ length: limit }, (_, index) => fillerIssue(offset + index));
      return { stdout: JSON.stringify({ issues }), stderr: '' };
    }
    return { stdout: '{}', stderr: '' };
  };

  release(): void {
    this.releaseGate?.();
  }
}

function connectorOnRunner(
  runner: MulticaCommandRunner,
  clock: () => Date,
): MulticaCliConnector {
  return new MulticaCliConnector({
    binaryPath: '/usr/bin/true',
    profile: 'desktop-api.multica.ai',
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    runner,
    clock,
  });
}

describe('dispatchDevelopmentTask', () => {
  let harness: TestServiceContext;
  let connector: FakeConnector;
  let dependencies: DispatchDevelopmentTaskDependencies;

  const loadTask = async (ctx: ServiceContext, taskId = 'task-20260820-abc00001') => ctx.tasks.get(taskId);

  beforeEach(async () => {
    harness = await createTestServiceContext();
    connector = new FakeConnector();
    dependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask());
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('fails closed with field reasons and never calls the connector for a research task', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      taskId: 'task-20260820-abc00002',
      executionTarget: null,
      sourceKey: 'test:research-1',
      taskType: 'research',
      permissionProfile: 'read_only_research',
    }));

    await expect(dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-abc00002',
    )).rejects.toThrowError(DevelopmentDispatchNotAdmittedError);

    expect(connector.ensureIssueCalls).toHaveLength(0);
    const untouched = await loadTask(harness.ctx, 'task-20260820-abc00002');
    expect(untouched.executionLink ?? null).toBeNull();
  });

  it('fails closed with field reasons for an incomplete development task', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask({
      taskId: 'task-20260820-abc00003',
      contextRefs: [],
      objective: null,
      sourceKey: 'test:development-incomplete',
    }));

    const error = await dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-abc00003',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DevelopmentDispatchNotAdmittedError);
    expect((error as DevelopmentDispatchNotAdmittedError).errors).toEqual([
      'objective is required',
      'contextRefs requires at least one item',
    ]);
    expect(connector.ensureIssueCalls).toHaveLength(0);
  });

  it('persists the intent, links the unique issue, and writes back the reference', async () => {
    const outcome = await dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-abc00001',
    );

    expect(outcome).toMatchObject({ status: 'linked', issueId: ISSUE_ID });
    const task = await loadTask(harness.ctx);
    expect(task.status).toBe('agent_executable');
    expect(task.executionLink).toMatchObject({
      provider: 'multica',
      idempotencyKey: executionLinkIdempotencyKey(task.taskId),
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      dispatchState: 'linked',
      remoteState: 'active',
    });
    expect(typeof task.executionLink?.lastSyncedAt).toBe('string');
  });

  it('is idempotent: a second dispatch returns already_linked without a new create', async () => {
    await dispatchDevelopmentTask(harness.ctx, dependencies, 'task-20260820-abc00001');
    const second = await dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-abc00001',
    );

    expect(second).toMatchObject({ status: 'already_linked', issueId: ISSUE_ID });
    expect(connector.ensureIssueCalls).toHaveLength(1);
    expect(connector.createdIssueCount()).toBe(1);
  });

  it('re-enters idempotent activation recovery for a legacy issue-bound link', async () => {
    const current = await loadTask(harness.ctx);
    await harness.ctx.tasks.save({
      ...current,
      executionLink: {
        ...freshExecutionLink(current.taskId, dependencies.target),
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        dispatchState: 'linked',
        remoteState: 'active',
      },
    });
    connector.remoteIssuesByMetadata = 1;

    const recovered = await dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      current.taskId,
    );

    expect(recovered).toMatchObject({ status: 'linked', recovered: true, issueId: ISSUE_ID });
    expect(connector.ensureIssueCalls).toHaveLength(1);
    expect(connector.createdIssueCount()).toBe(0);
    const activated = await loadTask(harness.ctx);
    expect(activated.executionLink).toMatchObject({
      activationAssigneeId: SQUAD_ID,
      activationRunId: RUN_ID,
    });
  });

  it('persists duplicate_conflict and refuses further automatic dispatch', async () => {
    const conflictConnector: MulticaDispatchConnector = {
      ensureIssue: async () => ({
        status: 'duplicate_conflict',
        candidateIssueIds: [ISSUE_ID, '01234567-89ab-4cde-8f01-234567890abd'],
      }),
      inspect: async () => {
        throw new Error('not used');
      },
    };
    const first = await dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: conflictConnector },
      'task-20260820-abc00001',
    );
    expect(first).toMatchObject({ status: 'duplicate_conflict' });

    const task = await loadTask(harness.ctx);
    expect(task.executionLink?.dispatchState).toBe('duplicate_conflict');

    const second = await dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: conflictConnector },
      'task-20260820-abc00001',
    );
    expect(second).toMatchObject({ status: 'duplicate_conflict' });
    expect(connector.ensureIssueCalls).toHaveLength(0);
  });

  it('persists remote_write_unknown for an uncertain remote result', async () => {
    const unknownConnector: MulticaDispatchConnector = {
      ensureIssue: async () => ({
        status: 'remote_write_unknown' as const,
        reason: 'issue create: multica_call_timed_out',
      }),
      inspect: async () => {
        throw new Error('not used');
      },
    };

    const outcome = await dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: unknownConnector },
      'task-20260820-abc00001',
    );

    expect(outcome).toMatchObject({ status: 'remote_write_unknown' });
    const task = await loadTask(harness.ctx);
    expect(task.executionLink?.dispatchState).toBe('remote_write_unknown');
  });

  it('FI-01: create succeeded but the local write-back failed — the next run recovers the same issue and never creates again', async () => {
    // Save #1 persists the pending intent, save #2 resolving_remote, save #3
    // would persist the linked outcome — we crash exactly there.
    const failingTasks = new SaveFailingTaskRepository(harness.ctx.tasks, [3]);
    const crashingCtx: ServiceContext = { ...harness.ctx, tasks: failingTasks };

    const error = await dispatchDevelopmentTask(
      crashingCtx,
      dependencies,
      'task-20260820-abc00001',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DevelopmentDispatchWriteBackError);
    // The remote issue was created before the crash.
    expect(connector.createdIssueCount()).toBe(1);
    const afterCrash = await loadTask(harness.ctx);
    expect(afterCrash.executionLink?.dispatchState).toBe('resolving_remote');

    // CR fix 1: the fresh resolving_remote lease is indistinguishable from a
    // live dispatcher, so an immediate retry fails closed as in-flight and
    // never touches the remote.
    const immediate = await dispatchDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-abc00001',
    );
    expect(immediate).toMatchObject({ status: 'in_flight' });
    expect(connector.ensureIssueCalls).toHaveLength(1);

    // Recovery: the remote already holds the issue, so once the in-flight
    // lease goes stale the metadata search resolves it and no second create
    // happens.
    connector.remoteIssuesByMetadata = 1;
    const laterCtx = harness.createIndependentContext({
      now: new Date('2026-07-14T00:02:01.000Z'),
    });
    const recovered = await dispatchDevelopmentTask(
      laterCtx,
      dependencies,
      'task-20260820-abc00001',
    );

    expect(recovered).toMatchObject({ status: 'linked', issueId: ISSUE_ID });
    expect(connector.ensureIssueCalls).toHaveLength(2);
    expect(connector.createdIssueCount()).toBe(1);
    const finalTask = await loadTask(harness.ctx);
    expect(finalTask.executionLink?.dispatchState).toBe('linked');
    expect(finalTask.executionLink?.issueId).toBe(ISSUE_ID);
  });

  it('single-flight: two concurrent dispatches share one connector create and one stable local link', async () => {
    const [first, second] = await Promise.all([
      dispatchDevelopmentTask(harness.ctx, dependencies, 'task-20260820-abc00001'),
      dispatchDevelopmentTask(harness.ctx, dependencies, 'task-20260820-abc00001'),
    ]);

    // Exactly one dispatcher owns the remote ensure; the other fails closed
    // as in-flight (or observes the completed link), never a second create.
    const linked = [first, second].filter((outcome) => outcome.status === 'linked');
    expect(linked).toHaveLength(1);
    const other = [first, second].find((outcome) => outcome.status !== 'linked');
    expect(['in_flight', 'already_linked']).toContain(other?.status);
    expect(connector.ensureIssueCalls).toHaveLength(1);
    expect(connector.createdIssueCount()).toBe(1);
    const task = await loadTask(harness.ctx);
    expect(task.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
    });
  });

  it('single-flight: a dispatch overlapping the remote ensure returns in_flight without a second connector call', async () => {
    const gates: { enter: (() => void) | null; release: (() => void) | null } = {
      enter: null,
      release: null,
    };
    const ensureEntered = new Promise<void>((resolveEnter) => {
      gates.enter = resolveEnter;
    });
    const blockingConnector: MulticaDispatchConnector = {
      ensureIssue: async (envelope: { idempotencyKey: string }) => {
        connector.ensureIssueCalls.push({ kind: 'ensureIssue', idempotencyKey: envelope.idempotencyKey });
        gates.enter?.();
        await new Promise<void>((resolveRelease) => {
          gates.release = resolveRelease;
        });
        return {
          status: 'linked',
          ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
          recovered: false,
          activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: false },
        };
      },
      inspect: async () => {
        throw new Error('not used');
      },
    };

    const firstDispatch = dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: blockingConnector },
      'task-20260820-abc00001',
    );
    await ensureEntered;

    const overlapping = await dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: blockingConnector },
      'task-20260820-abc00001',
    );
    expect(overlapping).toMatchObject({ status: 'in_flight' });
    expect(connector.ensureIssueCalls).toHaveLength(1);

    gates.release?.();
    const first = await firstDispatch;
    expect(first).toMatchObject({ status: 'linked', issueId: ISSUE_ID });
    const task = await loadTask(harness.ctx);
    expect(task.executionLink).toMatchObject({ dispatchState: 'linked', issueId: ISSUE_ID });

    const third = await dispatchDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: blockingConnector },
      'task-20260820-abc00001',
    );
    expect(third).toMatchObject({ status: 'already_linked', issueId: ISSUE_ID });
    expect(connector.ensureIssueCalls).toHaveLength(1);
  });

  // FIX-3 (TEP-45 P1): the single-flight lease must cover the entire remote
  // ensure. A manual dispatch (like immediate authorization) carries no
  // deadline of its own, so the dispatcher derives one from the lease it
  // persists; with the real connector every CLI call is clipped to that
  // budget, and the deep marker-scan pages fail closed — the ensure can no
  // longer be still running once the lease goes stale.
  it('FIX-3: a manual dispatch without a caller budget bounds the whole remote ensure inside the lease', async () => {
    const leaseStartMs = Date.parse('2026-07-14T00:00:00.000Z');
    const clock = sharedClock(leaseStartMs);
    const runner = new SlowBoardRunner(clock, null);
    const slowDependencies: DispatchDevelopmentTaskDependencies = {
      ...dependencies,
      connector: connectorOnRunner(runner.run, clock.now),
    };
    const ctx: ServiceContext = { ...harness.ctx, clock: clock.now };

    const outcome = await dispatchDevelopmentTask(
      ctx,
      slowDependencies,
      'task-20260820-abc00001',
    );

    expect(outcome).toMatchObject({ status: 'remote_write_unknown' });
    if (outcome.status === 'remote_write_unknown') {
      expect(outcome.reason).toContain('multica_budget_exhausted');
    }
    expect(runner.calls.filter((call) => call.args.includes('create'))).toHaveLength(0);

    // Every remote call ends at or before the lease expiry: the winner's
    // lease (lastAttemptAt) was written at leaseStartMs, and the final full
    // call was clipped below the 20s connector cap by the remaining budget.
    const leaseExpiryMs = leaseStartMs + MULTICA_DISPATCH_IN_FLIGHT_MS;
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      expect(call.startedAtMs + (call.timeoutMs ?? 0)).toBeLessThanOrEqual(leaseExpiryMs);
    }
    expect(runner.calls.map((call) => call.timeoutMs)).toContain(15_000);
    expect(clock.nowMs()).toBe(leaseStartMs + 115_000);

    // The ensure terminated while its lease was still fresh — a competing
    // entry at this instant would fail closed, not race a live dispatcher.
    const task = await loadTask(ctx);
    expect(attemptAgeMs(task.executionLink?.lastAttemptAt, clock.nowMs()))
      .toBeLessThan(MULTICA_DISPATCH_IN_FLIGHT_MS);
  });

  it('FIX-3: a caller deadline beyond the lease is clamped to the lease bound', async () => {
    const leaseStartMs = Date.parse('2026-07-14T00:00:00.000Z');
    const clock = sharedClock(leaseStartMs);
    const runner = new SlowBoardRunner(clock, null);
    const slowDependencies: DispatchDevelopmentTaskDependencies = {
      ...dependencies,
      connector: connectorOnRunner(runner.run, clock.now),
    };
    const ctx: ServiceContext = { ...harness.ctx, clock: clock.now };

    const outcome = await dispatchDevelopmentTask(
      ctx,
      slowDependencies,
      'task-20260820-abc00001',
      { deadlineAt: leaseStartMs + 600_000 },
    );

    expect(outcome).toMatchObject({ status: 'remote_write_unknown' });
    const leaseExpiryMs = leaseStartMs + MULTICA_DISPATCH_IN_FLIGHT_MS;
    for (const call of runner.calls) {
      expect(call.startedAtMs + (call.timeoutMs ?? 0)).toBeLessThanOrEqual(leaseExpiryMs);
    }
    expect(runner.calls.map((call) => call.timeoutMs)).toContain(15_000);
    expect(runner.calls.filter((call) => call.args.includes('create'))).toHaveLength(0);
  });

  it('FIX-3: an entry overlapping a slow ensure deep inside the lease window still fails closed with zero connector calls', async () => {
    const leaseStartMs = Date.parse('2026-07-14T00:00:00.000Z');
    const clock = sharedClock(leaseStartMs);
    // Gate the marker-scan page that starts at leaseStart+100s: the ensure
    // is far beyond any quick call yet still legitimately inside its lease.
    const runner = new SlowBoardRunner(clock, 5);
    const slowDependencies: DispatchDevelopmentTaskDependencies = {
      ...dependencies,
      connector: connectorOnRunner(runner.run, clock.now),
    };
    const ctx: ServiceContext = { ...harness.ctx, clock: clock.now };

    const firstDispatch = dispatchDevelopmentTask(
      ctx,
      slowDependencies,
      'task-20260820-abc00001',
    );
    await runner.gateEntered;
    expect(clock.nowMs()).toBe(leaseStartMs + 100_000);

    const callsBeforeOverlap = runner.calls.length;
    const overlapping = await dispatchDevelopmentTask(
      ctx,
      slowDependencies,
      'task-20260820-abc00001',
    );
    expect(overlapping).toMatchObject({ status: 'in_flight' });
    expect(runner.calls.length).toBe(callsBeforeOverlap);

    runner.release();
    const first = await firstDispatch;
    expect(first).toMatchObject({ status: 'remote_write_unknown' });
    const leaseExpiryMs = leaseStartMs + MULTICA_DISPATCH_IN_FLIGHT_MS;
    for (const call of runner.calls) {
      expect(call.startedAtMs + (call.timeoutMs ?? 0)).toBeLessThanOrEqual(leaseExpiryMs);
    }
    const task = await loadTask(ctx);
    expect(task.executionLink?.dispatchState).toBe('remote_write_unknown');
  });

  it('FIX-3: concurrent manual entries against a lease older than 120s still produce exactly one remote ensure', async () => {
    // A dispatcher crashed 121s ago (fixed test clock): the stale lease is
    // reclaimable, but only one concurrent entry may run the remote ensure.
    const seeded = await loadTask(harness.ctx);
    await harness.ctx.tasks.save({
      ...seeded,
      executionLink: {
        ...freshExecutionLink('task-20260820-abc00001', {
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
        }),
        dispatchState: 'resolving_remote',
        lastAttemptAt: '2026-07-13T23:57:59.000Z',
      },
    });

    // Gate the winner inside its remote ensure so the loser deterministically
    // reads the reclaimed lease while the ensure is still in flight.
    let ensureCalls = 0;
    const gates: { enter: (() => void) | null; release: (() => void) | null } = {
      enter: null,
      release: null,
    };
    const ensureEntered = new Promise<void>((resolveEnter) => {
      gates.enter = resolveEnter;
    });
    const gatedConnector: MulticaDispatchConnector = {
      ensureIssue: async (envelope: { idempotencyKey: string }) => {
        ensureCalls += 1;
        connector.ensureIssueCalls.push({ kind: 'ensureIssue', idempotencyKey: envelope.idempotencyKey });
        gates.enter?.();
        await new Promise<void>((resolveRelease) => {
          gates.release = resolveRelease;
        });
        return {
          status: 'linked',
          ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
          recovered: true,
          activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: true },
        };
      },
      inspect: async () => {
        throw new Error('not used');
      },
    };
    const gatedDependencies: DispatchDevelopmentTaskDependencies = {
      ...dependencies,
      connector: gatedConnector,
    };

    const firstDispatch = dispatchDevelopmentTask(
      harness.ctx,
      gatedDependencies,
      'task-20260820-abc00001',
    );
    await ensureEntered;

    const second = await dispatchDevelopmentTask(
      harness.ctx,
      gatedDependencies,
      'task-20260820-abc00001',
    );
    expect(second).toMatchObject({ status: 'in_flight' });
    expect(ensureCalls).toBe(1);

    gates.release?.();
    const first = await firstDispatch;
    expect(first).toMatchObject({ status: 'linked', issueId: ISSUE_ID });
    expect(ensureCalls).toBe(1);
    const final = await loadTask(harness.ctx);
    expect(final.executionLink?.dispatchState).toBe('linked');
    expect(final.executionLink?.issueId).toBe(ISSUE_ID);
  });
});

describe('buildDispatchEnvelope', () => {
  it('embeds the exact marker and the bounded task projection', () => {
    const envelope = buildDispatchEnvelope(
      developmentTask(),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      '2026-08-20T00:00:00.000Z',
    );

    expect(envelope.idempotencyKey).toBe('atl:task-20260820-abc00001');
    expect(envelope.description).toContain('[ATL_TASK_ID:atl:task-20260820-abc00001]');
    expect(envelope.description).toContain('## Objective');
    expect(envelope.description).toContain('- Exactly one remote issue per authorized task');
    expect(envelope.description).toContain('- docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md');
    expect(envelope.description.length).toBeLessThan(20_000);
  });
});
