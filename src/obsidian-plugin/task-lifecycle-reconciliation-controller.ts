import type { ServiceContext } from '../services/service-context.js';
import {
  reconcileExternalTaskLifecycle,
} from '../services/reconcile-external-task-lifecycle.js';
import { taskIdFromPath } from './task-eligibility.js';

type ReconcileResult = { reconciled: boolean; taskId: string };
type Reconcile = (
  context: ServiceContext,
  taskId: string,
  relativePath: string,
) => Promise<ReconcileResult>;

export interface TaskLifecycleReconciliationControllerOptions {
  context: ServiceContext;
  delayMs?: number;
  reconcile?: Reconcile;
  onError?: (error: unknown) => void;
}

export class TaskLifecycleReconciliationController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly context: ServiceContext;
  private readonly delayMs: number;
  private readonly reconcile: Reconcile;
  private readonly onError: (error: unknown) => void;

  constructor(options: TaskLifecycleReconciliationControllerOptions) {
    this.context = options.context;
    this.delayMs = options.delayMs ?? 250;
    this.reconcile = options.reconcile ?? reconcileExternalTaskLifecycle;
    this.onError = options.onError ?? (() => undefined);
  }

  schedule(relativePath: string): boolean {
    const taskId = taskIdFromPath(relativePath);
    if (taskId === null) return false;

    const pending = this.timers.get(taskId);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      if (this.timers.get(taskId) !== timer) return;
      this.timers.delete(taskId);
      void this.reconcile(this.context, taskId, relativePath).catch(this.onError);
    }, this.delayMs);
    this.timers.set(taskId, timer);
    return true;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
