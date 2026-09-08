import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MulticaCliConnector,
  type MulticaCommandRunner,
  type MulticaDispatchConnector,
  type MulticaIssueSnapshot,
  type MulticaRoundtripConnector,
} from '../../../src/connectors/multica-cli-connector.js';
import type { ExecutionLink } from '../../../src/domain/execution-link.js';
import type { Task } from '../../../src/domain/task.js';
import type { DispatchDevelopmentTaskDependencies } from '../../../src/services/dispatch-development-task.js';
import type { ServiceContext } from '../../../src/services/service-context.js';
import {
  InvalidReconcileOptionError,
  parseReconcileMaxTasks,
  planReconciliation,
  reconcileMulticaDispatch,
} from '../../../src/services/reconcile-multica-dispatch.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';
const RUN_ID = 'run-initial';

class ScriptedConnector implements MulticaDispatchConnector {
  ensureCalls = 0;
  inspectCalls = 0;
  ensureResults: Awaited<ReturnType<MulticaDispatchConnector['ensureIssue']>>[] = [];
  ensureError: Error | null = null;
  snapshots = new Map<string, MulticaIssueSnapshot>();

  async ensureIssue() {
    this.ensureCalls += 1;
    if (this.ensureError !== null) {
      throw this.ensureError;
    }
    const next = this.ensureResults.shift()
      ?? {
        status: 'linked' as const,
        ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
        recovered: false,
        activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: false },
      };
    return next;
  }

  async inspect(issueId: string) {
    this.inspectCalls += 1;
    const snapshot = this.snapshots.get(issueId);
    if (snapshot === undefined) {
      throw new Error(`no snapshot scripted for ${issueId}`);
    }
    return snapshot;
  }
}

function developmentTask(
  taskId: string,
  overrides: Partial<Task> & { executionLink?: ExecutionLink | null } = {},
): Task {
  return {
    schemaVersion: 1,
    taskId,
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
    sourceKey: `test:${taskId}`,
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

function link(overrides: Partial<ExecutionLink> = {}): ExecutionLink {
  return {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: 'atl:task-20260820-abc00001',
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    issueId: null,
    issueIdentifier: null,
    activationAssigneeId: SQUAD_ID,
    activationRunId: RUN_ID,
    dispatchState: 'not_requested',
    remoteState: null,
    lastCommentId: null,
    lastEventId: null,
    summary: null,
    artifactRefs: [],
    lastAttemptAt: null,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe('planReconciliation', () => {
  it('orders recovery before backfill, isolates conflicts, and skips fresh in-flight attempts', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    const plan = planReconciliation([
      developmentTask('task-recovery', {
        executionLink: link({ dispatchState: 'remote_write_unknown', idempotencyKey: 'atl:task-recovery' }),
      }),
      developmentTask('task-backfill'),
      developmentTask('task-inflight', {
        executionLink: link({
          dispatchState: 'pending',
          idempotencyKey: 'atl:task-inflight',
          lastAttemptAt: '2026-08-20T11:59:30.000Z',
        }),
      }),
      developmentTask('task-stale', {
        executionLink: link({
          dispatchState: 'resolving_remote',
          idempotencyKey: 'atl:task-stale',
          lastAttemptAt: '2026-08-20T09:00:00.000Z',
        }),
      }),
      developmentTask('task-legacy-linked', {
        executionLink: link({
          dispatchState: 'linked',
          idempotencyKey: 'atl:task-legacy-linked',
          issueId: ISSUE_ID,
          issueIdentifier: 'TEP-42',
          activationAssigneeId: undefined,
          activationRunId: undefined,
        }),
      }),
      developmentTask('task-conflict', {
        executionLink: link({ dispatchState: 'duplicate_conflict', idempotencyKey: 'atl:task-conflict' }),
      }),
      developmentTask('task-ready', { status: 'ready' }),
      developmentTask('task-research', { taskType: 'research', permissionProfile: 'read_only_research', executionTarget: null }),
    ], { inFlightSkipMs: 120_000, now });

    expect(plan.recovery.map((task) => task.taskId)).toEqual(['task-recovery']);
    expect(plan.backfill.map((task) => task.taskId)).toEqual([
      'task-backfill',
      'task-stale',
      'task-legacy-linked',
    ]);
    expect(plan.sync).toEqual([]);
    expect(plan.conflicts.map((task) => task.taskId)).toEqual(['task-conflict']);
  });
});

describe('reconcileMulticaDispatch', () => {
  let harness: TestServiceContext;
  let connector: ScriptedConnector;
  let dependencies: DispatchDevelopmentTaskDependencies;

  beforeEach(async () => {
    harness = await createTestServiceContext();
    connector = new ScriptedConnector();
    dependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('backfills unlinked tasks and reports the backlog when the cap hits', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1'));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-2'));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-3'));

    const summary = await reconcileMulticaDispatch(harness.ctx, dependencies, {
      maxTasks: 2,
      totalBudgetMs: 60_000,
    });

    expect(summary.attempted).toBe(2);
    expect(summary.remainingBacklog).toBe(1);
    expect(summary.outcomes.map((outcome) => outcome.action)).toEqual([
      'dispatched',
      'dispatched',
    ]);
    expect(connector.ensureCalls).toBe(2);
    const third = await harness.ctx.tasks.get('task-3');
    expect(third.executionLink ?? null).toBeNull();
  });

  it('isolates a single task failure and still processes the rest of the batch', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1'));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-2'));

    let calls = 0;
    connector.ensureError = null;
    const flaky: MulticaDispatchConnector = {
      ensureIssue: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('connection reset');
        }
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

    const summary = await reconcileMulticaDispatch(
      harness.ctx,
      { ...dependencies, connector: flaky },
      {},
    );

    expect(summary.outcomes.map((outcome) => outcome.action)).toEqual([
      'failed',
      'dispatched',
    ]);
    expect(summary.outcomes[0]?.detail).toContain('connection reset');
    const second = await harness.ctx.tasks.get('task-2');
    expect(second.executionLink?.dispatchState).toBe('linked');
  });

  it('never retries duplicate_conflict tasks and records them as skipped', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1', {
      executionLink: link({ dispatchState: 'duplicate_conflict', idempotencyKey: 'atl:task-1' }),
    }));

    const summary = await reconcileMulticaDispatch(harness.ctx, dependencies, {});

    expect(summary.outcomes).toEqual([{
      taskId: 'task-1',
      action: 'skipped_conflict',
      dispatchState: 'duplicate_conflict',
      detail: 'duplicate remote issues require human resolution',
    }]);
    expect(connector.ensureCalls).toBe(0);
  });

  it('recovers a remote_write_unknown task to the same single issue', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1', {
      executionLink: link({
        dispatchState: 'remote_write_unknown',
        idempotencyKey: 'atl:task-1',
        lastAttemptAt: '2026-08-20T11:00:00.000Z',
      }),
    }));
    // The remote already holds the issue from the interrupted attempt, so the
    // connector reports an existing-issue bind instead of a fresh create.
    connector.ensureResults.push({
      status: 'linked',
      ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
      recovered: true,
      activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: true },
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, dependencies, {});

    expect(summary.outcomes[0]?.action).toBe('recovered');
    const task = await harness.ctx.tasks.get('task-1');
    expect(task.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId: ISSUE_ID,
    });
    expect(connector.ensureCalls).toBe(1);
  });

  it('recovers a persisted legacy linked record before sync after restart', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-legacy-linked', {
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-legacy-linked',
        activationAssigneeId: undefined,
        activationRunId: undefined,
      }),
    }));

    // A new repository instance models launchd restarting after upgrading a
    // Vault that already contains an issue-bound, pre-activation record.
    const restarted = harness.createIndependentContext();
    connector.ensureResults.push({
      status: 'linked',
      ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
      recovered: true,
      activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: true },
    });

    const recovered = await reconcileMulticaDispatch(restarted, dependencies, {});

    expect(recovered.outcomes[0]).toMatchObject({
      taskId: 'task-legacy-linked',
      action: 'recovered',
    });
    expect(connector.ensureCalls).toBe(1);
    expect(connector.inspectCalls).toBe(0);
    const activated = await restarted.tasks.get('task-legacy-linked');
    expect(activated.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId: ISSUE_ID,
      activationAssigneeId: SQUAD_ID,
      activationRunId: RUN_ID,
    });

    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'in_progress',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    const nextRestart = harness.createIndependentContext();
    const synced = await reconcileMulticaDispatch(nextRestart, dependencies, {});

    expect(synced.outcomes[0]?.action).toBe('synced');
    expect(connector.ensureCalls).toBe(1);
    expect(connector.inspectCalls).toBe(1);
  });

  it('syncs a linked task without changing the ATL task status', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1', {
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-1',
        lastSyncedAt: '2026-08-20T10:00:00.000Z',
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'done',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, dependencies, {});

    expect(summary.outcomes[0]).toMatchObject({ action: 'synced', detail: 'completed' });
    expect(connector.inspectCalls).toBe(1);
    const task = await harness.ctx.tasks.get('task-1');
    expect(task.status).toBe('agent_executable');
    expect(task.executionLink).toMatchObject({ remoteState: 'completed' });
    expect(task.executionLink?.lastSyncedAt).not.toBe('2026-08-20T10:00:00.000Z');
  });

  it('automatically records a completed Artifact for a linked research task', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-research', {
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-research',
        executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
        remoteArtifactReceiptIds: [],
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'in_progress',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    const readArtifacts = vi.fn().mockResolvedValue({
      status: 'recorded',
      taskId: 'task-research',
      receiptId: 'rar_0123456789abcdef01234567',
      sourceCount: 1,
      created: true,
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, {
      ...dependencies,
      readResearchArtifacts: readArtifacts,
    }, {});

    expect(readArtifacts).toHaveBeenCalledWith('task-research', expect.objectContaining({
      deadlineAt: expect.any(Number),
    }));
    expect(summary.outcomes[0]).toMatchObject({
      taskId: 'task-research',
      action: 'artifact_recorded',
      detail: 'rar_0123456789abcdef01234567',
    });
  });

  it('keeps an unfinished Research run pending without reporting a task failure', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-research-pending', {
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-research-pending',
        executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
        remoteArtifactReceiptIds: [],
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'in_progress',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    const readArtifacts = vi.fn().mockResolvedValue({
      status: 'pending',
      taskId: 'task-research-pending',
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, {
      ...dependencies,
      readResearchArtifacts: readArtifacts,
    }, {});

    expect(summary.outcomes).toEqual([expect.objectContaining({
      taskId: 'task-research-pending',
      action: 'synced',
    })]);
    expect(summary.outcomes.some((outcome) => outcome.action === 'failed')).toBe(false);
  });

  it('does not revisit Multica Artifact APIs after a receipt is already projected', async () => {
    const readArtifacts = vi.fn();
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-research-recorded', {
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'completed',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-research-recorded',
        executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
        remoteArtifactReceiptIds: ['rar_0123456789abcdef01234567'],
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'done',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, {
      ...dependencies,
      readResearchArtifacts: readArtifacts,
    }, {});

    expect(summary.outcomes[0]).toMatchObject({
      taskId: 'task-research-recorded',
      action: 'synced',
    });
    expect(readArtifacts).not.toHaveBeenCalled();
  });

  it('isolates one Artifact read failure and continues with the next linked Research task', async () => {
    const secondIssueId = '11234567-89ab-4cde-8f01-234567890abc';
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-research-failed', {
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-research-failed',
        executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
        remoteArtifactReceiptIds: [],
      }),
    }));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-research-recorded', {
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: secondIssueId,
        issueIdentifier: 'TEP-43',
        idempotencyKey: 'atl:task-research-recorded',
        executionBindingReceiptId: 'ebr_1123456789abcdef01234567',
        remoteArtifactReceiptIds: [],
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'in_progress',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    connector.snapshots.set(secondIssueId, {
      issueId: secondIssueId,
      issueIdentifier: 'TEP-43',
      status: 'done',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    const readArtifacts = vi.fn().mockImplementation(async (taskId: string) => {
      if (taskId === 'task-research-failed') throw new Error('synthetic Artifact read failure');
      return {
        status: 'recorded' as const,
        taskId,
        receiptId: 'rar_1123456789abcdef01234567',
        sourceCount: 1,
        created: true,
      };
    });

    const summary = await reconcileMulticaDispatch(harness.ctx, {
      ...dependencies,
      readResearchArtifacts: readArtifacts,
    }, {});

    expect(summary.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-research-failed', action: 'failed' }),
      expect.objectContaining({ taskId: 'task-research-recorded', action: 'artifact_recorded' }),
    ]));
    expect(readArtifacts).toHaveBeenCalledTimes(2);
  });

  // T2 CR fix 4: with the roundtrip connector wired, the event-driven
  // remote_state is authoritative — the raw issue status refresh in the same
  // cycle must not flatten needs_decision/failed/release_candidate_ready
  // back onto active | blocked | completed.
  it('keeps the ingested event remote_state over the raw issue status', async () => {
    const eventComment = {
      commentId: 'c-event',
      body: `\`\`\`json\n${JSON.stringify({
        schema_version: 1,
        event_id: 'evt-0002',
        atl_task_id: 'task-1',
        state: 'needs_decision',
        summary: '选择 synthetic canary 的恢复策略',
        decision: {
          question: '真实 Vault 写入前选择恢复策略',
          options: [{ id: 'retry_with_fixture', label: '使用合成数据重试' }],
        },
        artifact_refs: [],
        occurred_at: '2026-08-20T11:00:00.000Z',
      })}\n\`\`\``,
      createdAt: '2026-08-20T11:00:00.000Z',
      parentCommentId: null,
      authorType: 'agent',
    };
    const roundtrip: MulticaRoundtripConnector = {
      ensureIssue: async () => ({ status: 'failed', reason: 'unused' }),
      inspect: async () => { throw new Error('unused'); },
      listComments: async () => ({ comments: [eventComment] }),
      appendResponse: async () => { throw new Error('unused'); },
      resume: async () => { throw new Error('unused'); },
      runIds: async () => [],
    };
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1', {
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'active',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-1',
        lastSyncedAt: '2026-08-20T10:00:00.000Z',
      }),
    }));
    // The raw Multica issue is still in_progress — the raw mapping would say
    // 'active', which must NOT overwrite the needs_decision event projection.
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'in_progress',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });

    const summary = await reconcileMulticaDispatch(
      harness.ctx,
      { ...dependencies, roundtrip },
      {},
    );

    expect(summary.outcomes[0]?.action).toBe('synced');
    const task = await harness.ctx.tasks.get('task-1');
    expect(task.status).toBe('waiting_for_decision');
    expect(task.executionLink?.remoteState).toBe('needs_decision');
    expect(task.actionRequest?.eventId).toBe('evt-0002');
    const audits = await harness.ctx.audit.listForTask('task-1');
    expect(audits.filter((event) => event.event === 'multica.status_drift')).toHaveLength(0);
  });

  it('records a raw done without a terminal event as drift evidence only', async () => {
    const roundtrip: MulticaRoundtripConnector = {
      ensureIssue: async () => ({ status: 'failed', reason: 'unused' }),
      inspect: async () => { throw new Error('unused'); },
      listComments: async () => ({ comments: [] }),
      appendResponse: async () => { throw new Error('unused'); },
      resume: async () => { throw new Error('unused'); },
      runIds: async () => [],
    };
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1', {
      status: 'waiting_for_decision',
      executionLink: link({
        dispatchState: 'linked',
        remoteState: 'needs_decision',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        idempotencyKey: 'atl:task-1',
        lastSyncedAt: '2026-08-20T10:00:00.000Z',
      }),
    }));
    connector.snapshots.set(ISSUE_ID, {
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      status: 'done',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });

    await reconcileMulticaDispatch(harness.ctx, { ...dependencies, roundtrip }, {});

    // The event projection survives; the raw done is only audit evidence.
    const task = await harness.ctx.tasks.get('task-1');
    expect(task.status).toBe('waiting_for_decision');
    expect(task.executionLink?.remoteState).toBe('needs_decision');
    const audits = await harness.ctx.audit.listForTask('task-1');
    expect(audits.filter((event) => event.event === 'multica.status_drift')).toHaveLength(1);
  });

  it('stops when the total budget is exhausted and reports the backlog', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1'));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-2'));

    const summary = await reconcileMulticaDispatch(harness.ctx, dependencies, {
      totalBudgetMs: -1,
    });

    expect(summary.attempted).toBe(0);
    expect(summary.remainingBacklog).toBe(2);
    expect(connector.ensureCalls).toBe(0);
  });

  it('CR fix 3: rejects invalid maxTasks overrides instead of unbounding the batch', async () => {
    for (const maxTasks of [0, -1, 1.5, 11, Number.POSITIVE_INFINITY]) {
      await expect(
        reconcileMulticaDispatch(harness.ctx, dependencies, { maxTasks }),
      ).rejects.toThrowError(/between 1 and 10/);
    }
    expect(connector.ensureCalls).toBe(0);
  });

  it('CR fix 3: a multi-stage slow ensure cannot push the round past its budget', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-1'));
    await harness.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-2'));

    // One shared virtual clock: the cycle's deadline and every connector
    // timeout read the same now, and each CLI stage consumes 50s of it.
    let virtualNow = Date.parse('2026-08-20T12:00:00.000Z');
    const issuedTimeouts: number[] = [];
    const runner: MulticaCommandRunner = async ({ args, timeoutMs }) => {
      issuedTimeouts.push(timeoutMs ?? -1);
      virtualNow += 50_000;
      if (args.includes('list')) {
        return { stdout: JSON.stringify({ issues: [] }), stderr: '' };
      }
      if (args.includes('create')) {
        return {
          stdout: JSON.stringify({
            id: ISSUE_ID,
            identifier: 'TEP-42',
            workspace_id: WORKSPACE_ID,
            project_id: PROJECT_ID,
            description: '[ATL_TASK_ID:atl:task-1]',
            status: 'backlog',
          }),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    };
    const connector = new MulticaCliConnector({
      binaryPath: '/applications/multica/bin/multica',
      profile: 'desktop-api.multica.ai',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      callTimeoutMs: 20_000,
      runner,
      clock: () => new Date(virtualNow),
    });
    const ctx: ServiceContext = { ...harness.ctx, clock: () => new Date(virtualNow) };

    const summary = await reconcileMulticaDispatch(
      ctx,
      { ...dependencies, connector },
      { totalBudgetMs: 120_000 },
    );

    // Task 1 ran: metadata search, one marker-scan page, and a create each
    // clipped to the connector cap (and the remaining budget). Since FIX-3
    // the dispatch leg is bounded by the lease deadline (round start + 120s
    // minus the 5s margin) — tighter than the round deadline — so the create
    // is clipped to the 15s left on the lease, and the post-create bind is
    // refused because that budget is spent.
    expect(issuedTimeouts).toEqual([20_000, 20_000, 15_000]);
    expect(summary.attempted).toBe(1);
    expect(summary.remainingBacklog).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({
      taskId: 'task-1',
      action: 'failed',
      detail: 'metadata set: multica_budget_exhausted',
    });
    // The round ended at its budget: task 2 never reached the connector.
    const second = await harness.ctx.tasks.get('task-2');
    expect(second.executionLink ?? null).toBeNull();
  });
});

describe('parseReconcileMaxTasks', () => {
  it('accepts bounded decimal integers only (CR fix 3)', () => {
    for (const valid of ['1', '10', '3']) {
      expect(parseReconcileMaxTasks(valid)).toBe(Number(valid));
    }
    for (const invalid of [
      'nope', '5x', '0', '-1', '1e3', 'Infinity', 'NaN', '3.0', '0x5', '11', '', '  ',
    ]) {
      expect(() => parseReconcileMaxTasks(invalid)).toThrowError(InvalidReconcileOptionError);
    }
  });
});

describe('reconcile + dispatch integration (Goal AC 4/6)', () => {
  it('runs the full FI-01 loop through the reconciliation cycle', async () => {
    const harness2 = await createTestServiceContext();
    try {
      const scripted = new ScriptedConnector();
      const deps: DispatchDevelopmentTaskDependencies = {
        connector: scripted,
        target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      };
      await harness2.ctx.tasks.createIfSourceKeyAbsent(developmentTask('task-fi01'));

      // First cycle: create succeeds remotely, local write-back is uncertain.
      scripted.ensureResults.push({
        status: 'remote_write_unknown',
        reason: 'issue create: multica_call_timed_out',
      });
      const first = await reconcileMulticaDispatch(harness2.ctx, deps, {});
      expect(first.outcomes[0]?.action).toBe('failed');
      let task = await harness2.ctx.tasks.get('task-fi01');
      expect(task.executionLink?.dispatchState).toBe('remote_write_unknown');
      expect(scripted.ensureCalls).toBe(1);

      // Second cycle: the remote already holds the issue; the same idempotency
      // key resolves it and exactly one ensure attempt happened per cycle.
      scripted.ensureResults.push({
        status: 'linked',
        ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
        recovered: true,
        activation: { assigneeId: SQUAD_ID, runId: RUN_ID, recovered: true },
      });
      const second = await reconcileMulticaDispatch(harness2.ctx, deps, {});
      expect(second.outcomes[0]?.action).toBe('recovered');
      task = await harness2.ctx.tasks.get('task-fi01');
      expect(task.executionLink).toMatchObject({
        dispatchState: 'linked',
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
      });

      // Third cycle: the bound link is synced, not re-dispatched.
      scripted.snapshots.set(ISSUE_ID, {
        issueId: ISSUE_ID,
        issueIdentifier: 'TEP-42',
        status: 'in_progress',
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
      });
      const third = await reconcileMulticaDispatch(harness2.ctx, deps, {});
      expect(third.outcomes[0]?.action).toBe('synced');
      expect(scripted.ensureCalls).toBe(2);
      expect(scripted.inspectCalls).toBe(1);
    } finally {
      await harness2.cleanup();
    }
  });
});
