import type { Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export class RecoverExpiredClaimAuditFailedError extends Error {
  readonly code = 'task_claim_expiry_audit_failed';

  constructor() {
    super('Task claim expiry audit failed');
    this.name = 'RecoverExpiredClaimAuditFailedError';
  }
}

export class RecoverExpiredClaimRecoveryError extends Error {
  readonly code = 'task_claim_expiry_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Task claim expiry recovery required');
    this.name = 'RecoverExpiredClaimRecoveryError';
  }
}

function isExpiredClaim(task: Task, now: Date): boolean {
  return task.status === 'in_progress'
    && task.claim !== null
    && Date.parse(task.claim.leaseExpiresAt) <= now.getTime();
}

export async function recoverExpiredClaims(
  ctx: ServiceContext,
): Promise<Task[]> {
  const now = ctx.clock();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('Invalid recovery date');
  }
  const timestamp = now.toISOString();
  const candidates = (await ctx.tasks.list())
    .filter((task) => isExpiredClaim(task, now));
  const recovered: Task[] = [];

  for (const candidate of candidates) {
    const task = await ctx.tasks.withTaskLock(candidate.taskId, async () => {
      const current = await ctx.tasks.get(candidate.taskId);
      if (!isExpiredClaim(current, now) || current.claim === null) {
        return null;
      }
      assertTransition('in_progress', 'ready');
      const ready: Task = {
        ...current,
        status: 'ready',
        claim: null,
        updatedAt: timestamp,
      };
      let saved: Task;
      let staleIndexError: TaskSavedIndexStaleError | null = null;
      try {
        saved = await ctx.tasks.save(ready);
      } catch (error) {
        if (!(error instanceof TaskSavedIndexStaleError)) {
          throw error;
        }
        saved = ready;
        staleIndexError = error;
      }
      try {
        await ctx.audit.append({
          event: 'task.claim_expired',
          at: timestamp,
          taskId: saved.taskId,
          runId: current.claim.runId,
          details: { lastError: 'lease_expired' },
        });
      } catch {
        try {
          await ctx.tasks.save(current);
        } catch {
          throw new RecoverExpiredClaimRecoveryError();
        }
        throw new RecoverExpiredClaimAuditFailedError();
      }
      if (staleIndexError !== null) {
        throw staleIndexError;
      }
      return saved;
    });
    if (task !== null) {
      recovered.push(task);
    }
  }
  return recovered;
}
