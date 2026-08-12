import { join } from 'node:path';

import {
  DwsSelfAcceptanceDelivery,
  type DwsCommandRunner,
} from '../connectors/dws-self-acceptance-delivery.js';
import {
  projectAcceptanceObjects,
  type AcceptanceObject,
  type AcceptanceWeeklyProjection,
} from '../domain/acceptance-object.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';
import { FileAcceptanceNotificationLedger } from '../storage/file-acceptance-notification-ledger.js';
import { MarkdownArtifactRepository } from '../storage/markdown-artifact-repository.js';
import { MarkdownTaskRepository } from '../storage/markdown-task-repository.js';
import { MarkdownWeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import { FileWeeklyReviewDecisionRepository } from '../storage/weekly-review-decision-repository.js';
import {
  notifyAcceptance,
  retryFailedAcceptanceNotifications,
  type AcceptanceNotificationRecord,
} from './notify-acceptance.js';

export interface AcceptanceNotifier {
  (object: AcceptanceObject): Promise<unknown>;
  retryFailed(): Promise<AcceptanceNotificationRecord[]>;
}

interface AcceptanceNotifierOptions {
  vaultRoot: string;
  profile: string | null;
  clock?: () => Date;
  dwsRunner?: DwsCommandRunner;
}

export function createAcceptanceNotifier(
  options: AcceptanceNotifierOptions & { profile: null },
): undefined;
export function createAcceptanceNotifier(
  options: AcceptanceNotifierOptions & { profile: string },
): AcceptanceNotifier;
export function createAcceptanceNotifier(
  options: AcceptanceNotifierOptions,
): AcceptanceNotifier | undefined;
export function createAcceptanceNotifier(
  options: AcceptanceNotifierOptions,
): AcceptanceNotifier | undefined {
  if (options.profile === null) return undefined;

  const tasks = new MarkdownTaskRepository(options.vaultRoot);
  const artifacts = new MarkdownArtifactRepository(options.vaultRoot);
  const weeklyReports = new MarkdownWeeklyReportRepository(options.vaultRoot);
  const weeklyDecisions = new FileWeeklyReviewDecisionRepository(options.vaultRoot);
  const ledger = new FileAcceptanceNotificationLedger(join(
    options.vaultRoot,
    '.atl-runtime',
  ));
  const delivery = new DwsSelfAcceptanceDelivery({
    profile: options.profile,
    ...(options.dwsRunner === undefined ? {} : { runner: options.dwsRunner }),
  });

  const listAcceptanceObjects = async (): Promise<AcceptanceObject[]> => {
    const [currentTasks, currentReports] = await Promise.all([
      tasks.list(),
      weeklyReports.listCurrent(),
    ]);
    const weekly: AcceptanceWeeklyProjection[] = await Promise.all(
      currentReports.map(async (report) => {
        const decisions = (await weeklyDecisions.listForWeekly(report.weeklyId))
          .filter((decision) => decision.version === report.version)
          .sort((left, right) => (
            left.decidedAt.localeCompare(right.decidedAt)
            || left.eventId.localeCompare(right.eventId)
          ));
        return {
          weeklyId: report.weeklyId,
          version: report.version,
          weekKey: report.weekKey,
          acceptanceState: decisions.at(-1)?.action ?? report.acceptanceState,
          pendingCount: report.pendingCount,
          path: `09_Progress/Weekly/${report.weekKey}-v${report.version}.md`,
        };
      }),
    );
    return projectAcceptanceObjects(currentTasks, weekly);
  };

  const context = {
    ledger,
    delivery,
    target: { kind: 'self' },
    listAcceptanceObjects,
    clock: options.clock ?? (() => new Date()),
  } as const;
  const notify = (object: AcceptanceObject) => notifyAcceptance(context, object);
  const listHydratedAcceptanceObjects = async (): Promise<AcceptanceObject[]> => {
    const visible = await listAcceptanceObjects();
    const hydrated = await Promise.all(visible.map(async (object) => {
      if (object.objectType !== 'artifact') return object;
      const task = await tasks.get(object.objectId);
      const ref = task.artifactRefs.find((candidate) => (
        parseArtifactReference(candidate, task.taskId)?.attempt === object.version
      ));
      if (ref === undefined) return null;
      let summary: Awaited<ReturnType<typeof artifacts.readSummary>>;
      try {
        summary = await artifacts.readSummary(ref);
      } catch {
        return null;
      }
      if (summary.checks === undefined) return null;
      return {
        ...object,
        artifact: {
          reference: `${task.taskId}@v${object.version}`,
          summary: summary.summary,
          evidenceCount: summary.evidenceCount,
          checks: summary.checks,
        },
      };
    }));
    return hydrated.filter(
      (object): object is AcceptanceObject => object !== null,
    );
  };
  notify.retryFailed = async (): Promise<AcceptanceNotificationRecord[]> => {
    return retryFailedAcceptanceNotifications({
      ...context,
      listAcceptanceObjects: listHydratedAcceptanceObjects,
    });
  };
  return notify;
}
