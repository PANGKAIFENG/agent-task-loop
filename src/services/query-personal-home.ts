import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';

export interface QueryPersonalHomeInput {
  tasks: Task[];
  projects: Project[];
}

export interface PersonalHomeTask {
  taskId: string;
  title: string;
  status: string;
  reviewState: Task['reviewState'];
  projectName: string;
  priority: Task['priority'];
  updatedAt: string;
  artifactCount: number;
}

export interface PersonalHomeSnapshot {
  counts: {
    inbox: number;
    ready: number;
    inProgress: number;
    review: number;
    blocked: number;
  };
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
  const leftRank = left.status === 'in_progress' ? 0 : 1;
  const rightRank = right.status === 'in_progress' ? 0 : 1;
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
    priority: task.priority,
    updatedAt: task.updatedAt,
    artifactCount: task.artifactRefs.length,
  };
}

export function queryPersonalHome(input: QueryPersonalHomeInput): PersonalHomeSnapshot {
  const projectNames = new Map(input.projects.map((project) => [project.projectId, project.name]));
  const counts = {
    inbox: input.tasks.filter((task) => task.status === 'inbox').length,
    ready: input.tasks.filter((task) => task.status === 'ready').length,
    inProgress: input.tasks.filter((task) => task.status === 'in_progress').length,
    review: input.tasks.filter((task) => task.status === 'review').length,
    blocked: input.tasks.filter((task) => task.status === 'blocked').length,
  };
  const focus = input.tasks
    .filter((task) => task.status === 'in_progress' || task.status === 'ready')
    .sort(compareFocusTasks);
  const inbox = input.tasks
    .filter((task) => task.status === 'inbox')
    .sort(compareTasks);
  const focusTasks = focus.map((task) => toDto(task, projectNames));
  const inboxTasks = inbox.map((task) => toDto(task, projectNames));
  return {
    counts,
    focusTasks,
    inboxTasks,
    nextAction: focusTasks[0] ?? null,
  };
}
