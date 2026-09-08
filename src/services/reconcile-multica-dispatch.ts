import type {
  MulticaIssueSnapshot,
  MulticaRoundtripConnector,
} from '../connectors/multica-cli-connector.js';
import { isExecutionLinkActivationComplete } from '../domain/execution-link.js';
import { isExternalExecutionTask, type Task } from '../domain/task.js';
import {
  DevelopmentDispatchNotAdmittedError,
  MULTICA_DISPATCH_IN_FLIGHT_MS,
  attemptAgeMs as executionAttemptAgeMs,
  dispatchDevelopmentTask,
  type DispatchDevelopmentTaskDependencies,
  type DispatchOutcome,
} from './dispatch-development-task.js';
import { ingestMulticaEvents, type IngestMulticaEventsDependencies } from './ingest-multica-events.js';
import type { ReadResearchArtifactsOutcome } from './read-research-artifacts.js';
import type { ServiceContext } from './service-context.js';

// PAW-GOAL-003 T1 (TECH §7): per-cycle budgets for the Multica leg of the
// 15-minute reconciliation. A single task failure is isolated — it can never
// block the remaining Multica work, the Qianwen sync or the local research
// runner.
export const MULTICA_RECONCILE_MAX_TASKS = 10;
export const MULTICA_RECONCILE_TOTAL_BUDGET_MS = 120_000;
export const MULTICA_RECONCILE_IN_FLIGHT_MS = MULTICA_DISPATCH_IN_FLIGHT_MS;

export class InvalidReconcileOptionError extends Error {
  readonly code = 'invalid_reconcile_option';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidReconcileOptionError';
  }
}

// CR fix 3: `--max-tasks` accepts one bounded positive decimal integer only.
// Malformed, suffixed, zero, negative, non-finite, and over-cap input is
// rejected instead of silently disabling or unbounding the batch.
export function parseReconcileMaxTasks(raw: string): number {
  const trimmed = raw.trim();
  const expected = `--max-tasks must be a decimal integer between 1 and ${MULTICA_RECONCILE_MAX_TASKS}`;
  if (!/^[0-9]{1,8}$/.test(trimmed)) {
    throw new InvalidReconcileOptionError(expected);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MULTICA_RECONCILE_MAX_TASKS) {
    throw new InvalidReconcileOptionError(expected);
  }
  return parsed;
}

export interface ReconcileMulticaOptions {
  maxTasks?: number;
  totalBudgetMs?: number;
  inFlightSkipMs?: number;
}

// PAW-GOAL-003 T2 (TECH §7): the round adds the response-ledger continuation
// ahead of dispatch recovery, and linked tasks sync their versioned events
// through the roundtrip connector when it is provided. Both stay optional so
// the T1 dispatch surface keeps working without the T2 wiring.
export interface ReconcileMulticaDependencies extends DispatchDevelopmentTaskDependencies {
  roundtrip?: MulticaRoundtripConnector | undefined;
  notify?: IngestMulticaEventsDependencies['notify'];
  continueResponses?: (() => Promise<{ processed: number; remaining: number }>) | undefined;
  readResearchArtifacts?: ((
    taskId: string,
    options: { deadlineAt: number },
  ) => Promise<ReadResearchArtifactsOutcome | { status: 'pending'; taskId: string }>) | undefined;
}

export type ReconcileAction =
  | 'dispatched'
  | 'recovered'
  | 'already_linked'
  | 'skipped_in_flight'
  | 'skipped_conflict'
  | 'synced'
  | 'artifact_recorded'
  | 'failed';

export interface ReconcileTaskOutcome {
  taskId: string;
  action: ReconcileAction;
  dispatchState: string;
  detail: string | null;
}

export interface ReconcileMulticaSummary {
  attempted: number;
  outcomes: ReconcileTaskOutcome[];
  remainingBacklog: number;
}

interface ReconcilePlan {
  recovery: Task[];
  backfill: Task[];
  sync: Task[];
  conflicts: Task[];
}

function attemptAgeMs(task: Task, now: number): number {
  return executionAttemptAgeMs(task.executionLink?.lastAttemptAt, now);
}

// T2: linked tasks stay reconciled in every non-terminal status — external
// events move them to waiting_for_decision / blocked / review and the cycle
// must keep ingesting new events there, not only in agent_executable.
const SYNCHRONIZED_STATUSES: readonly string[] = [
  'agent_executable',
  'in_progress',
  'waiting_for_decision',
  'blocked',
  'review',
];

export function planReconciliation(
  tasks: readonly Task[],
  options: Required<Pick<ReconcileMulticaOptions, 'inFlightSkipMs'>> & { now: number },
): ReconcilePlan {
  const plan: ReconcilePlan = { recovery: [], backfill: [], sync: [], conflicts: [] };
  for (const task of tasks) {
    if (!isExternalExecutionTask(task) || !SYNCHRONIZED_STATUSES.includes(task.status)) {
      continue;
    }
    const link = task.executionLink ?? null;
    const dispatchState = link?.dispatchState ?? 'not_requested';
    if (dispatchState === 'duplicate_conflict') {
      // Automatic execution stops; only a human resolves the duplicates.
      plan.conflicts.push(task);
      continue;
    }
    if (isExecutionLinkActivationComplete(link)) {
      plan.sync.push(task);
      continue;
    }
    if (task.status !== 'agent_executable') {
      // A task that drifted out of agent_executable without a bound link has
      // no remote to reconcile against; only dispatch admission covers it.
      continue;
    }
    if (dispatchState === 'remote_write_unknown') {
      plan.recovery.push(task);
      continue;
    }
    if (
      (dispatchState === 'pending' || dispatchState === 'resolving_remote')
      && attemptAgeMs(task, options.now) < options.inFlightSkipMs
    ) {
      // Another dispatcher may still hold the attempt; never race a create.
      continue;
    }
    plan.backfill.push(task);
  }
  return plan;
}

function remoteStateForIssue(snapshot: MulticaIssueSnapshot): 'active' | 'blocked' | 'completed' {
  if (snapshot.status === 'done') {
    return 'completed';
  }
  if (snapshot.status === 'blocked') {
    return 'blocked';
  }
  return 'active';
}

function actionForDispatchOutcome(outcome: DispatchOutcome): ReconcileAction {
  switch (outcome.status) {
    case 'linked':
      return outcome.recovered ? 'recovered' : 'dispatched';
    case 'already_linked':
      return 'already_linked';
    case 'in_flight':
      return 'skipped_in_flight';
    default:
      return 'failed';
  }
}

function detailForDispatchOutcome(outcome: DispatchOutcome): string | null {
  if (
    outcome.status === 'failed'
    || outcome.status === 'remote_write_unknown'
    || outcome.status === 'in_flight'
  ) {
    return outcome.reason;
  }
  if (outcome.status === 'duplicate_conflict') {
    return outcome.candidateIssueIds.join(',');
  }
  return null;
}

async function syncLinkedTask(
  ctx: ServiceContext,
  connector: DispatchDevelopmentTaskDependencies['connector'],
  task: Task,
  options: {
    deadlineAt: number;
    roundtrip?: MulticaRoundtripConnector | undefined;
    notify?: IngestMulticaEventsDependencies['notify'];
    readResearchArtifacts?: ReconcileMulticaDependencies['readResearchArtifacts'];
  },
): Promise<ReconcileTaskOutcome> {
  const link = task.executionLink;
  const issueId = link?.issueId ?? null;
  if (link === null || link === undefined || issueId === null || issueId === '') {
    throw new Error('linked task is missing an issue reference');
  }
  // T2: when the roundtrip connector is wired, sync first ingests the
  // versioned comment events (the only legal status driver), then refreshes
  // the raw remote snapshot below.
  if (options.roundtrip !== undefined) {
    await ingestMulticaEvents(ctx, {
      connector: options.roundtrip,
      ...(options.notify === undefined ? {} : { notify: options.notify }),
    }, task.taskId);
  }
  const snapshot = await connector.inspect(issueId, { deadlineAt: options.deadlineAt });
  // T1 sync only refreshes the execution link projection. ATL task status is
  // driven by versioned external events (T2), never by the raw remote status;
  // a remote done without a consumed terminal event is recorded as drift.
  await ctx.tasks.withTaskLock(task.taskId, async () => {
    const current = await ctx.tasks.get(task.taskId);
    const timestamp = ctx.clock().toISOString();
    // CR fix 4: with the roundtrip connector wired, the event-driven
    // remote_state projected by ingestion is authoritative — the raw issue
    // status must never overwrite it in the same cycle (or any later one).
    // The raw status only produces drift evidence in the audit below. The
    // raw mapping still bootstraps the field before the first event lands.
    const remoteState = options.roundtrip !== undefined
      ? (current.executionLink?.remoteState ?? remoteStateForIssue(snapshot))
      : remoteStateForIssue(snapshot);
    const drift = snapshot.status === 'done' && remoteState !== 'completed';
    await ctx.tasks.save({
      ...current,
      executionLink: {
        ...(current.executionLink ?? link),
        remoteState,
        lastSyncedAt: timestamp,
      },
      updatedAt: timestamp,
    });
    await ctx.audit.append({
      event: drift ? 'multica.status_drift' : 'multica.link_synced',
      at: timestamp,
      taskId: task.taskId,
      details: {
        issueId: snapshot.issueId,
        issueIdentifier: snapshot.issueIdentifier,
        remoteStatus: snapshot.status,
        remoteState,
      },
    });
  });
  if (
    task.taskType === 'research'
    && task.executionLink?.executionBindingReceiptId !== undefined
    && task.executionLink.executionBindingReceiptId !== null
    && (task.executionLink.remoteArtifactReceiptIds?.length ?? 0) === 0
    && options.readResearchArtifacts !== undefined
  ) {
    const artifact = await options.readResearchArtifacts(task.taskId, {
      deadlineAt: options.deadlineAt,
    });
    if (artifact.status === 'recorded') {
      return {
        taskId: task.taskId,
        action: 'artifact_recorded',
        dispatchState: link.dispatchState,
        detail: artifact.receiptId,
      };
    }
  }
  return {
    taskId: task.taskId,
    action: 'synced',
    dispatchState: link.dispatchState,
    detail: remoteStateForIssue(snapshot),
  };
}

export async function reconcileMulticaDispatch(
  ctx: ServiceContext,
  dependencies: ReconcileMulticaDependencies,
  options: ReconcileMulticaOptions = {},
): Promise<ReconcileMulticaSummary> {
  const maxTasks = options.maxTasks ?? MULTICA_RECONCILE_MAX_TASKS;
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MULTICA_RECONCILE_MAX_TASKS) {
    throw new InvalidReconcileOptionError(
      `--max-tasks must be a decimal integer between 1 and ${MULTICA_RECONCILE_MAX_TASKS}`,
    );
  }
  const totalBudgetMs = options.totalBudgetMs ?? MULTICA_RECONCILE_TOTAL_BUDGET_MS;
  const inFlightSkipMs = options.inFlightSkipMs ?? MULTICA_RECONCILE_IN_FLIGHT_MS;
  const startedAt = ctx.clock().getTime();
  const deadline = startedAt + totalBudgetMs;

  const outcomes: ReconcileTaskOutcome[] = [];

  // TECH §7: in-flight response ledgers are reconciled before anything else —
  // a reply stuck at remote_response_confirmed must not wait behind new work.
  let responseBacklog = 0;
  if (dependencies.continueResponses !== undefined) {
    try {
      const continued = await dependencies.continueResponses();
      responseBacklog = continued.remaining;
      outcomes.push({
        taskId: '-',
        action: 'synced',
        dispatchState: 'linked',
        detail: `responses continued: ${continued.processed}, remaining: ${continued.remaining}`,
      });
    } catch (error) {
      outcomes.push({
        taskId: '-',
        action: 'failed',
        dispatchState: 'linked',
        detail: error instanceof Error ? error.message.slice(0, 300) : 'response continuation failed',
      });
    }
  }

  const tasks = await ctx.tasks.list();
  const plan = planReconciliation(tasks, { inFlightSkipMs, now: startedAt });
  for (const task of plan.conflicts) {
    outcomes.push({
      taskId: task.taskId,
      action: 'skipped_conflict',
      dispatchState: 'duplicate_conflict',
      detail: 'duplicate remote issues require human resolution',
    });
  }

  const queue: { task: Task; kind: 'recovery' | 'backfill' | 'sync' }[] = [
    ...plan.recovery.map((task) => ({ task, kind: 'recovery' as const })),
    ...plan.backfill.map((task) => ({ task, kind: 'backfill' as const })),
    ...plan.sync.map((task) => ({ task, kind: 'sync' as const })),
  ];

  let attempted = 0;
  let processed = 0;
  for (const entry of queue) {
    if (attempted >= maxTasks || ctx.clock().getTime() >= deadline) {
      break;
    }
    attempted += 1;
    processed += 1;
    try {
      if (entry.kind === 'sync') {
        outcomes.push(await syncLinkedTask(ctx, dependencies.connector, entry.task, {
          deadlineAt: deadline,
          ...(dependencies.roundtrip === undefined ? {} : { roundtrip: dependencies.roundtrip }),
          ...(dependencies.notify === undefined ? {} : { notify: dependencies.notify }),
          ...(dependencies.readResearchArtifacts === undefined
            ? {}
            : { readResearchArtifacts: dependencies.readResearchArtifacts }),
        }));
        continue;
      }
      // CR fix 3: the round deadline travels into every task/CLI operation,
      // so a task started near the deadline cannot chain slow CLI calls past
      // it and delay the Qianwen/research runners of the same cycle.
      const outcome = await dispatchDevelopmentTask(
        ctx,
        dependencies,
        entry.task.taskId,
        { deadlineAt: deadline },
      );
      outcomes.push({
        taskId: entry.task.taskId,
        action: actionForDispatchOutcome(outcome),
        dispatchState: outcome.status,
        detail: detailForDispatchOutcome(outcome),
      });
    } catch (error) {
      const detail = error instanceof DevelopmentDispatchNotAdmittedError
        ? error.errors.join('; ')
        : error instanceof Error
          ? error.message.slice(0, 300)
          : 'unexpected reconciliation error';
      outcomes.push({
        taskId: entry.task.taskId,
        action: 'failed',
        dispatchState: entry.task.executionLink?.dispatchState ?? 'not_requested',
        detail,
      });
    }
  }

  const remainingBacklog = queue.length - processed;
  const timestamp = ctx.clock().toISOString();
  try {
    await ctx.audit.append({
      event: 'multica.reconcile_cycle',
      at: timestamp,
      details: {
        attempted,
        failures: outcomes.filter((outcome) => outcome.action === 'failed').length,
        backlog: remainingBacklog,
        ...(responseBacklog > 0 ? { responseBacklog } : {}),
      },
    });
  } catch {
    // The audit trail is evidence, not a gate; the cycle result still returns.
  }
  return { attempted, outcomes, remainingBacklog };
}
