import { join } from 'node:path';

import {
  DwsSelfAcceptanceDelivery,
  type DwsCommandRunner,
} from '../connectors/dws-self-acceptance-delivery.js';
import type { Task } from '../domain/task.js';
import { FileDecisionNotificationLedger } from '../storage/file-decision-notification-ledger.js';
import { MarkdownTaskRepository } from '../storage/markdown-task-repository.js';
import {
  notifyDecision,
  type DecisionNotificationRecord,
} from './notify-decision.js';

export interface DecisionNotifier {
  (task: Task): Promise<DecisionNotificationRecord>;
}

interface DecisionNotifierOptions {
  vaultRoot: string;
  profile: string | null;
  robotCode?: string | null;
  clock?: () => Date;
  dwsRunner?: DwsCommandRunner;
}

export function createDecisionNotifier(
  options: DecisionNotifierOptions & { profile: null },
): undefined;
export function createDecisionNotifier(
  options: DecisionNotifierOptions & { profile: string; robotCode: string },
): DecisionNotifier;
export function createDecisionNotifier(
  options: DecisionNotifierOptions,
): DecisionNotifier | undefined;
export function createDecisionNotifier(
  options: DecisionNotifierOptions,
): DecisionNotifier | undefined {
  if (options.profile === null || options.robotCode == null) return undefined;
  const tasks = new MarkdownTaskRepository(options.vaultRoot);
  const context = {
    ledger: new FileDecisionNotificationLedger(join(
      options.vaultRoot,
      '.atl-runtime',
    )),
    delivery: new DwsSelfAcceptanceDelivery({
      profile: options.profile,
      robotCode: options.robotCode,
      ...(options.dwsRunner === undefined ? {} : { runner: options.dwsRunner }),
    }),
    target: { kind: 'self' } as const,
    getTask: async (taskId: string) => {
      try {
        return await tasks.get(taskId);
      } catch {
        return null;
      }
    },
    clock: options.clock ?? (() => new Date()),
  };
  return (task: Task) => notifyDecision(context, task);
}
