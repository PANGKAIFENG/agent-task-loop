import {
  isExecutionLinkActivationComplete,
} from '../domain/execution-link.js';
import type { Task } from '../domain/task.js';
import {
  MULTICA_DISPATCH_IN_FLIGHT_MS,
  type DispatchOutcome,
} from '../services/dispatch-development-task.js';

// PAW-GOAL-003-V0.5 D2 (PRD 4.4): the six DispatchOutcome values map onto
// exactly four UI states. The mapping is total and pure — the Modal renders
// whatever this module returns and never re-derives state, and an unknown
// remote fact can never render as success.

export type DispatchResultView =
  | {
    status: 'linked';
    issueId: string;
    issueIdentifier: string;
    dispatchedAt: string | null;
    recovered: boolean;
  }
  | { status: 'reconciling'; reason: string }
  | { status: 'conflict'; candidateIssueIds: string[] }
  | { status: 'failed'; reason: string };

export type DispatchEntryView =
  | { kind: 'contract' }
  | { kind: 'result'; result: DispatchResultView };

export const DISPATCH_EXPECTATION_MINUTES = Math.round(
  MULTICA_DISPATCH_IN_FLIGHT_MS / 60_000,
);

// Outcome → view. `linked`/`already_linked` are the only success shapes and
// both surface the unique TEP identifier; `in_flight` and
// `remote_write_unknown` both mean "the remote fact is unknown, wait for
// reconciliation" and must never render as delivered.
export function outcomeView(
  outcome: DispatchOutcome,
  dispatchedAt: string | null = null,
): DispatchResultView {
  switch (outcome.status) {
    case 'linked':
      return {
        status: 'linked',
        issueId: outcome.issueId,
        issueIdentifier: outcome.issueIdentifier,
        dispatchedAt,
        recovered: outcome.recovered,
      };
    case 'already_linked':
      return {
        status: 'linked',
        issueId: outcome.issueId,
        issueIdentifier: outcome.issueIdentifier,
        dispatchedAt,
        recovered: true,
      };
    case 'in_flight':
    case 'remote_write_unknown':
      return { status: 'reconciling', reason: outcome.reason };
    case 'duplicate_conflict':
      return {
        status: 'conflict',
        candidateIssueIds: [...outcome.candidateIssueIds],
      };
    case 'failed':
      return { status: 'failed', reason: outcome.reason };
  }
}

// Admission errors carry the exact service gap list; the Modal routes those
// back to the gated Contract step instead of inventing a failure reason.
export function admissionErrorSources(error: unknown): string[] | null {
  if (!(error instanceof Error) || !('errors' in error)) return null;
  const coded = error as Error & { code?: unknown; errors?: unknown };
  if (
    (coded.code === 'task_development_authorization_not_ready'
      || coded.code === 'development_dispatch_not_admitted')
    && Array.isArray(coded.errors)
    && coded.errors.every((item) => typeof item === 'string')
  ) {
    return coded.errors as string[];
  }
  return null;
}

// Non-admission failures (invalid state, wiring/config problems) surface as
// an honest failed outcome; nothing here can render as success.
export function dispatchFailureView(error: unknown): DispatchResultView {
  const code = error instanceof Error && 'code' in error
    ? String((error as Error & { code?: unknown }).code)
    : 'unexpected_dispatch_error';
  if (code === 'task_agent_authorization_invalid_state') {
    return {
      status: 'failed',
      reason: '任务状态已变化（可能已在别处授权或投递），请刷新看板后重试',
    };
  }
  return {
    status: 'failed',
    reason: `投递调用失败（${code}）：请检查 Multica 桌面端是否运行并已登录，然后从命令面板重投`,
  };
}

// Read-back entry (PRD 4.4 / 4.5): what the 补投入口 should show when it
// opens on an already-dispatched task. Anything past not_requested/failed
// is a live remote state — no re-dispatch offer, only the honest projection.
export function executionLinkEntryView(task: Task): DispatchEntryView {
  const link = task.executionLink ?? null;
  if (link === null) return { kind: 'contract' };
  if (isExecutionLinkActivationComplete(link)) {
    return {
      kind: 'result',
      result: {
        status: 'linked',
        issueId: link.issueId ?? '',
        issueIdentifier: link.issueIdentifier ?? '',
        dispatchedAt: link.lastSyncedAt,
        recovered: true,
      },
    };
  }
  switch (link.dispatchState) {
    case 'pending':
    case 'resolving_remote':
    case 'remote_write_unknown':
      return {
        kind: 'result',
        result: {
          status: 'reconciling',
          reason: `dispatch state: ${link.dispatchState} (lastAttemptAt: ${link.lastAttemptAt ?? 'unknown'})`,
        },
      };
    case 'duplicate_conflict':
      return {
        kind: 'result',
        result: { status: 'conflict', candidateIssueIds: [] },
      };
    case 'not_requested':
    case 'failed':
    default:
      return { kind: 'contract' };
  }
}
