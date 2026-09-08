import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import {
  computeTaskStatistics,
  type AgentQueueStatistics,
  type TaskIntegrityIssues,
  type TaskStatusCounts,
} from './task-statistics.js';

export interface QueryPersonalHomeInput {
  tasks: Task[];
  projects: Project[];
  now: Date;
}

export interface PersonalHomeTask {
  taskId: string;
  title: string;
  status: string;
  reviewState: Task['reviewState'];
  projectName: string;
  origin: string;
  priority: Task['priority'];
  updatedAt: string;
  artifactCount: number;
}

export interface PersonalHomeSnapshot {
  total: number;
  // Raw workflow status counts — identical to what the task index model
  // reports for the same tasks; always sum to total.
  counts: TaskStatusCounts;
  // Agent queue admission counts, derived from the same predicate the
  // runner uses to claim. The home "Agent 待执行" number is
  // agentQueue.admittedCount, NOT counts.agentExecutable.
  agentQueue: AgentQueueStatistics;
  integrityIssues: TaskIntegrityIssues;
  expiredClaimTaskIds: string[];
  focusTasks: PersonalHomeTask[];
  inboxTasks: PersonalHomeTask[];
  nextAction: PersonalHomeTask | null;
}

const priorityRank: Record<Task['priority'], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTasks(left: Task, right: Task): number {
  return priorityRank[left.priority] - priorityRank[right.priority]
    || timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || left.title.localeCompare(right.title);
}

function compareFocusTasks(left: Task, right: Task): number {
  const ranks: Record<string, number> = {
    in_progress: 0,
    agent_executable: 1,
    ready: 2,
  };
  const leftRank = ranks[left.status] ?? 3;
  const rightRank = ranks[right.status] ?? 3;
  return leftRank - rightRank || compareTasks(left, right);
}

function toDto(task: Task, projectNames: Map<string, string>): PersonalHomeTask {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    reviewState: task.reviewState,
    projectName: task.projectId === null
      ? '未归类'
      : projectNames.get(task.projectId) ?? '未归类',
    origin: task.origin,
    priority: task.priority,
    updatedAt: task.updatedAt,
    artifactCount: task.artifactRefs.length,
  };
}

// Issue #3: the home page derives every count from computeTaskStatistics —
// the same shared rule that backs the task index model (status filtering)
// and the agent queue model (isClaimEligible admission).
export function queryPersonalHome(input: QueryPersonalHomeInput): PersonalHomeSnapshot {
  const projectNames = new Map(input.projects.map((project) => [project.projectId, project.name]));
  const knownProjectIds = new Set(input.projects.map((project) => project.projectId));
  const statistics = computeTaskStatistics(input.tasks, {
    now: input.now,
    knownProjectIds,
  });
  const admitted = new Set(statistics.agentQueue.admittedTaskIds);
  // Focus work is ACTIONABLE work: quarantined agent tasks (unconfirmed,
  // flagged duplicates, unexpected claims, …) are not actionable and must
  // not surface as focus tasks or as the suggested next action.
  const focus = input.tasks
    .filter((task) => (
      task.status === 'in_progress'
      || task.status === 'ready'
      || (task.status === 'agent_executable' && admitted.has(task.taskId))
    ))
    .sort(compareFocusTasks);
  const inbox = input.tasks
    .filter((task) => task.status === 'inbox')
    .sort(compareTasks);
  const focusTasks = focus.map((task) => toDto(task, projectNames));
  const inboxTasks = inbox.map((task) => toDto(task, projectNames));
  return {
    total: statistics.total,
    counts: statistics.statusCounts,
    agentQueue: statistics.agentQueue,
    integrityIssues: statistics.integrityIssues,
    expiredClaimTaskIds: statistics.expiredClaimTaskIds,
    focusTasks,
    inboxTasks,
    nextAction: focusTasks[0] ?? null,
  };
}
