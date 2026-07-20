import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import type { AuditEvent } from '../storage/contracts.js';

export type ContributionRange = '7d' | '12w' | '1y';

export interface ContributionSnapshot {
  range: ContributionRange;
  selectedDate: string;
  kpis: {
    completedToday: number;
    completedThisWeek: number;
    currentStreak: number;
  };
  days: Array<{
    date: string;
    completed: number;
    projectCount: number;
    level: 0 | 1 | 2 | 3 | 4;
  }>;
  projectSummaries: Array<{
    projectId: string | null;
    projectName: string;
    completed: number;
    artifactCount: number;
    evidenceTitles: string[];
  }>;
  outputs: Array<{
    taskId: string;
    title: string;
    projectName: string;
    completedAt: string;
    artifactRef: string | null;
  }>;
  coverage: { historicalCompletionDateUnavailable: number };
}

export interface QueryContributionInput {
  tasks: Task[];
  projects: Project[];
  auditEvents: AuditEvent[];
  now: Date;
  timeZone: string;
  range: ContributionRange;
  selectedDate: string;
}

interface Completion {
  task: Task;
  date: string;
  event: AuditEvent;
  timestamp: number;
  order: number;
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    day: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
  });
}

function localDate(formatter: Intl.DateTimeFormat, value: Date): string {
  const parts = Object.fromEntries(formatter.formatToParts(value)
    .map(({ type, value: part }) => [type, part]));
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function rangeLength(range: ContributionRange): number {
  switch (range) {
    case '7d': return 7;
    case '12w': return 84;
    case '1y': return 365;
  }
}

function isCompletion(event: AuditEvent): boolean {
  return (
    event.event === 'task.reviewed' && event.details?.decision === 'approve'
  ) || (
    event.event === 'task.lifecycle_reconciled'
    && event.details?.status === 'done'
  );
}

function projectName(task: Task, projectsById: Map<string, Project>): string {
  return task.projectId === null
    ? '未归类'
    : projectsById.get(task.projectId)?.name ?? '未归类';
}

function completionMap(
  tasksById: Map<string, Task>,
  auditEvents: AuditEvent[],
  formatter: Intl.DateTimeFormat,
): Map<string, Completion> {
  const map = new Map<string, Completion>();
  auditEvents.forEach((event, order) => {
    if (!isCompletion(event) || event.taskId === undefined) return;
    const task = tasksById.get(event.taskId);
    if (task === undefined) return;
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp)) return;
    const date = localDate(formatter, new Date(timestamp));
    const key = `${event.taskId}\u0000${date}`;
    const previous = map.get(key);
    if (previous === undefined || timestamp > previous.timestamp || (
      timestamp === previous.timestamp && order > previous.order
    )) {
      map.set(key, { task, date, event, timestamp, order });
    }
  });
  return map;
}

function currentStreak(dates: Set<string>, today: string): number {
  let cursor = dates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function queryContribution(input: QueryContributionInput): ContributionSnapshot {
  const formatter = dateFormatter(input.timeZone);
  const today = localDate(formatter, input.now);
  const length = rangeLength(input.range);
  const firstDate = addDays(today, -(length - 1));
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const projectsById = new Map(input.projects.map((project) => [project.projectId, project]));
  const completions = [...completionMap(tasksById, input.auditEvents, formatter).values()];
  const byDate = new Map<string, Completion[]>();
  for (const completion of completions) {
    const values = byDate.get(completion.date) ?? [];
    values.push(completion);
    byDate.set(completion.date, values);
  }

  const days = Array.from({ length }, (_, index) => {
    const date = addDays(firstDate, index);
    const values = byDate.get(date) ?? [];
    const projectIds = new Set(values.map(({ task }) => task.projectId ?? ''));
    const completed = values.length;
    return {
      date,
      completed,
      projectCount: projectIds.size,
      level: Math.min(completed, 4) as 0 | 1 | 2 | 3 | 4,
    };
  });

  const todayCompletions = byDate.get(today) ?? [];
  const weekStart = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const completedThisWeek = completions.filter(({ date }) => (
    date >= weekStart && date <= today
  )).length;
  const selectedCompletions = [...(byDate.get(input.selectedDate) ?? [])]
    .sort((left, right) => right.timestamp - left.timestamp || right.order - left.order);

  const summaries = new Map<string, {
    projectId: string | null;
    projectName: string;
    completed: number;
    artifactCount: number;
    evidenceTitles: string[];
  }>();
  for (const { task } of selectedCompletions) {
    const key = task.projectId ?? '';
    const summary = summaries.get(key) ?? {
      projectId: task.projectId,
      projectName: projectName(task, projectsById),
      completed: 0,
      artifactCount: 0,
      evidenceTitles: [],
    };
    summary.completed += 1;
    summary.artifactCount += task.artifactRefs.length;
    if (summary.evidenceTitles.length < 2) summary.evidenceTitles.push(task.title);
    summaries.set(key, summary);
  }
  const projectSummaries = [...summaries.values()].sort((left, right) => (
    right.completed - left.completed || left.projectName.localeCompare(right.projectName)
  ));

  const completionTaskIds = new Set(completions.map(({ task }) => task.taskId));
  const historicalCompletionDateUnavailable = input.tasks.filter((task) => (
    task.status === 'done' && !completionTaskIds.has(task.taskId)
  )).length;

  return {
    range: input.range,
    selectedDate: input.selectedDate,
    kpis: {
      completedToday: todayCompletions.length,
      completedThisWeek,
      currentStreak: currentStreak(new Set(byDate.keys()), today),
    },
    days,
    projectSummaries,
    outputs: selectedCompletions.map(({ task, event }) => ({
      taskId: task.taskId,
      title: task.title,
      projectName: projectName(task, projectsById),
      completedAt: event.at,
      artifactRef: task.artifactRefs.at(-1) ?? null,
    })),
    coverage: { historicalCompletionDateUnavailable },
  };
}
