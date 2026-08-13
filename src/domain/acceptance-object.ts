import type { Task } from './task.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';

export type AcceptanceObjectType = 'artifact' | 'weekly';
export type AcceptanceObjectState = 'pending' | 'later' | 'rejected';

export interface AcceptanceNotificationSnapshot {
  status: 'sent' | 'failed' | 'conflict';
  attemptedAt: string;
  errorCode: string | null;
}

export interface AcceptanceObject {
  objectType: AcceptanceObjectType;
  objectId: string;
  version: number;
  title: string;
  state: AcceptanceObjectState;
  pendingCount: number;
  path: string;
  artifact?: {
    reference: string;
    summary: string;
    evidenceCount: number;
    checks: {
      met: number;
      partial: number;
      notMet: number;
    };
  } | undefined;
  notification: AcceptanceNotificationSnapshot | null;
}

export interface AcceptanceWeeklyProjection {
  weeklyId: string;
  version: number;
  weekKey: string;
  acceptanceState: 'pending' | 'accepted' | 'rejected' | 'later';
  pendingCount: number;
  path: string;
}

function artifactAcceptanceObject(task: Task): AcceptanceObject | null {
  if (task.status !== 'review') return null;
  const artifactRef = task.artifactRefs.at(-1);
  if (artifactRef === undefined) return null;
  const artifact = parseArtifactReference(artifactRef, task.taskId);
  if (artifact === null) return null;
  return {
    objectType: 'artifact',
    objectId: task.taskId,
    version: artifact.attempt,
    title: task.title,
    state: 'pending',
    pendingCount: task.acceptanceCriteria.length,
    path: `10_Tasks/${artifactRef}`,
    notification: null,
  };
}

export function projectAcceptanceObjects(
  tasks: readonly Task[],
  weeklyReports: readonly AcceptanceWeeklyProjection[],
): AcceptanceObject[] {
  const artifacts = tasks
    .map(artifactAcceptanceObject)
    .filter((object): object is AcceptanceObject => object !== null);
  const weekly = weeklyReports.flatMap((report): AcceptanceObject[] => (
    report.acceptanceState === 'accepted'
      ? []
      : [{
        objectType: 'weekly',
        objectId: report.weeklyId,
        version: report.version,
        title: `${report.weekKey} 工作进展周报`,
        state: report.acceptanceState,
        pendingCount: report.pendingCount,
        path: report.path,
        notification: null,
      }]
  ));
  return [...artifacts, ...weekly].sort((left, right) => (
    left.objectType.localeCompare(right.objectType)
    || left.title.localeCompare(right.title, 'zh-CN')
    || left.objectId.localeCompare(right.objectId)
    || left.version - right.version
  ));
}
