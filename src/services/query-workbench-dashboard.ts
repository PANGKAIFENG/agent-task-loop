import type { Project } from '../domain/project.js';
import { priorityRank, type Task } from '../domain/task.js';
import { calendarDateInTimeZone, currentIsoWeekPeriod, type IsoWeekPeriod } from '../domain/week-period.js';
import type { AuditEvent } from '../storage/contracts.js';
import {
  projectTaskCompletions,
  type TaskCompletion,
} from './query-contribution.js';
import { computeTaskStatistics, type TaskIntegrityIssues } from './task-statistics.js';
import type { ServiceContext } from './service-context.js';

export const DASHBOARD_VIEW_IDS = [
  'requires_user',
  'agent_attention',
  'intake',
  'important_not_urgent',
  'weekly_insights',
] as const;

export type DashboardViewId = (typeof DASHBOARD_VIEW_IDS)[number];
export type DashboardFactKind = 'fact' | 'inference' | 'missing' | 'human_confirmation';
export type DashboardDataState = 'empty' | 'complete' | 'partial' | 'stale' | 'integrity';

export interface DashboardFact {
  kind: DashboardFactKind;
  label: string;
}

export interface DashboardTimeliness {
  observedAt: string | null;
  state: 'current' | 'stale' | 'unknown';
  label: string;
}

export interface DashboardCard {
  cardId: string;
  taskId: string;
  title: string;
  reason: DashboardFact;
  source: DashboardFact;
  goalImpact: DashboardFact;
  timeliness: DashboardTimeliness;
  status: { code: string; label: string };
  ruleRef: string;
  traceRef: string | null;
  action: { label: string; href: string };
}

export interface DashboardView {
  id: DashboardViewId;
  label: string;
  description: string;
  cards: DashboardCard[];
}

export interface WorkbenchDashboard {
  observedAt: string;
  dataState: DashboardDataState;
  stateReasons: string[];
  summary: {
    weeklyResults: number;
    candidateTasks: number;
    agentQueue: { raw: number; admitted: number; quarantined: number };
    needsUser: number;
    activeTasks: number;
  };
  integrity: TaskIntegrityIssues & { expiredClaimTaskIds: string[] };
  views: DashboardView[];
}

export interface BuildWorkbenchDashboardInput {
  tasks: Task[];
  projects: Project[];
  auditEvents: AuditEvent[];
  now: Date;
}

const VIEW_COPY: Record<DashboardViewId, Pick<DashboardView, 'label' | 'description'>> = {
  requires_user: {
    label: '需要我决策',
    description: '验收、选择与明确的人工作用点',
  },
  agent_attention: {
    label: 'AI 阻塞与异常',
    description: '阻塞、隔离、过期租约与数据异常',
  },
  intake: {
    label: '等待摄入与梳理',
    description: '尚未确认或关系仍待补齐的候选',
  },
  important_not_urgent: {
    label: '重要不紧急',
    description: '可以稳定推进、当前无需紧急介入的工作',
  },
  weekly_insights: {
    label: '本周结果与近期洞察',
    description: '最近形成的结果、变化与复盘信号',
  },
};

const STATUS_LABELS: Record<string, string> = {
  inbox: '候选',
  ready: '待推进',
  agent_executable: 'Agent 可执行',
  in_progress: '进行中',
  waiting_for_decision: '等待决策',
  review: '待验收',
  done: '已完成',
  blocked: '已阻塞',
  cancelled: '已取消',
};

const QUARANTINE_LABELS: Record<string, string> = {
  possible_duplicate: '疑似重复',
  unconfirmed: '尚未确认',
  not_ready: '执行上下文不完整',
  decision_continuation_pending: '决策续跑待开始',
  orphan_task: '未关联项目',
  unknown_project: '项目未登记',
  unexpected_claim: '存在冲突 claim',
  invalid_claim_lease: 'claim 租约损坏',
};

const STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const DASHBOARD_TIME_ZONE = 'Asia/Shanghai';

function taskTimestamp(task: Task): number | null {
  const value = Date.parse(task.updatedAt);
  return Number.isFinite(value) ? value : null;
}

function isDateInPeriod(date: string | null, period: IsoWeekPeriod): boolean {
  return date !== null && date >= period.startDate && date <= period.endDate;
}

function completionEvidence(
  tasks: readonly Task[],
  auditEvents: readonly AuditEvent[],
  currentWeek: IsoWeekPeriod,
): {
  currentWeek: TaskCompletion[];
  missingTaskIds: Set<string>;
} {
  const doneTaskIds = new Set(
    tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  const completions = projectTaskCompletions({
    tasks,
    auditEvents,
    timeZone: DASHBOARD_TIME_ZONE,
  });
  const evidencedTaskIds = new Set(completions.map(({ task }) => task.taskId));
  const missingTaskIds = new Set(
    [...doneTaskIds].filter((taskId) => !evidencedTaskIds.has(taskId)),
  );
  return {
    currentWeek: completions.filter(({ date }) => isDateInPeriod(date, currentWeek)),
    missingTaskIds,
  };
}

function timeliness(task: Task, now: Date): DashboardTimeliness {
  const timestamp = taskTimestamp(task);
  if (timestamp === null) {
    return { observedAt: null, state: 'unknown', label: '更新时间缺失' };
  }
  const state = now.getTime() - timestamp > STALE_AFTER_MS ? 'stale' : 'current';
  return {
    observedAt: task.updatedAt,
    state,
    label: state === 'stale' ? '数据已超过 24 小时' : '24 小时内更新',
  };
}

function traceRef(task: Task): string | null {
  if (task.actionRequest?.eventId !== undefined) {
    return `event:${task.actionRequest.eventId}`;
  }
  if (task.pendingDecision?.requestId !== undefined) {
    return `decision:${task.pendingDecision.requestId}`;
  }
  if (task.lastDecision?.requestId !== undefined) {
    return `decision:${task.lastDecision.requestId}`;
  }
  return null;
}

function factAction(task: Task): DashboardCard['action'] {
  if (task.status === 'review') {
    return { label: '查看验收事实', href: '/review' };
  }
  if (task.status === 'inbox' || task.reviewState === 'candidate') {
    return { label: '查看候选事实', href: '/inbox' };
  }
  if (task.projectId !== null && task.projectId.trim() !== '') {
    return {
      label: '查看项目事实',
      href: `/projects/${encodeURIComponent(task.projectId)}`,
    };
  }
  return { label: '查看项目事实', href: '/projects' };
}

function sourceFact(task: Task): DashboardFact {
  const origin = task.origin.trim();
  if (origin === '') {
    return { kind: 'missing', label: '来源未标记' };
  }
  return {
    kind: 'fact',
    label: task.sourceDate === null ? origin : `${origin} · ${task.sourceDate}`,
  };
}

function goalFact(task: Task, projectsById: ReadonlyMap<string, Project>): DashboardFact {
  if (task.projectId === null || task.projectId.trim() === '') {
    return { kind: 'missing', label: '目标 / 项目关系缺失' };
  }
  const project = projectsById.get(task.projectId);
  return project === undefined
    ? { kind: 'missing', label: `未登记项目：${task.projectId}` }
    : { kind: 'fact', label: project.name };
}

function status(task: Task): DashboardCard['status'] {
  return { code: task.status, label: STATUS_LABELS[task.status] ?? `未知状态：${task.status}` };
}

interface CardRule {
  view: DashboardViewId;
  reason: DashboardFact;
  ruleRef: string;
}

function taskRule(
  task: Task,
  admittedIds: ReadonlySet<string>,
  quarantineReasons: ReadonlyMap<string, readonly string[]>,
  integrityTaskIds: ReadonlySet<string>,
  expiredClaimIds: ReadonlySet<string>,
  currentWeek: IsoWeekPeriod,
): CardRule | null {
  if (task.actionRequest?.status === 'pending') {
    if (task.actionRequest.type === 'needs_decision' || task.actionRequest.type === 'release_candidate_ready') {
      return {
        view: 'requires_user',
        reason: { kind: 'human_confirmation', label: task.actionRequest.type === 'release_candidate_ready' ? '候选结果等待验收' : '执行已暂停，等待明确决策' },
        ruleRef: 'dashboard.requires-user.action-request@v001',
      };
    }
    if (task.actionRequest.type === 'blocked' || task.actionRequest.type === 'failed') {
      return {
        view: 'agent_attention',
        reason: { kind: 'fact', label: task.actionRequest.type === 'failed' ? 'Agent 执行失败' : 'Agent 报告阻塞' },
        ruleRef: 'dashboard.agent-attention.action-request@v001',
      };
    }
  }
  if (task.status === 'waiting_for_decision') {
    return {
      view: 'requires_user',
      reason: { kind: 'human_confirmation', label: 'Agent 已暂停，等待明确决策' },
      ruleRef: 'dashboard.requires-user.waiting-decision@v001',
    };
  }
  if (task.status === 'review') {
    return {
      view: 'requires_user',
      reason: { kind: 'human_confirmation', label: '已有 Artifact 进入验收' },
      ruleRef: 'dashboard.requires-user.review@v001',
    };
  }
  if (admittedIds.has(task.taskId) && task.priority === 'urgent') {
    return {
      view: 'agent_attention',
      reason: { kind: 'fact', label: 'Agent 队列存在紧急任务，需要优先处理' },
      ruleRef: 'dashboard.agent-attention.urgent-agent-queue@v001',
    };
  }
  const quarantined = quarantineReasons.get(task.taskId);
  if (quarantined !== undefined) {
    return {
      view: 'agent_attention',
      reason: {
        kind: 'fact',
        label: `共享准入统计已隔离：${quarantined.map((reason) => QUARANTINE_LABELS[reason] ?? reason).join('、')}`,
      },
      ruleRef: 'dashboard.agent-attention.shared-quarantine@v001',
    };
  }
  if (expiredClaimIds.has(task.taskId)) {
    return {
      view: 'agent_attention',
      reason: { kind: 'fact', label: '执行租约已过期，需要恢复检查' },
      ruleRef: 'dashboard.agent-attention.expired-claim@v001',
    };
  }
  if (integrityTaskIds.has(task.taskId)) {
    return {
      view: 'agent_attention',
      reason: { kind: 'fact', label: '共享统计报告数据完整性异常' },
      ruleRef: 'dashboard.agent-attention.integrity@v001',
    };
  }
  if (task.status === 'blocked') {
    return {
      view: 'agent_attention',
      reason: { kind: 'fact', label: '任务处于阻塞状态' },
      ruleRef: 'dashboard.agent-attention.blocked@v001',
    };
  }
  if (task.status === 'inbox' || task.reviewState === 'candidate') {
    return {
      view: 'intake',
      reason: { kind: 'inference', label: '候选尚未完成人工确认与关系梳理' },
      ruleRef: 'dashboard.intake.candidate@v001',
    };
  }
  if (
    admittedIds.has(task.taskId)
    || ((task.status === 'ready' || task.status === 'in_progress') && task.priority !== 'urgent')
  ) {
    return {
      view: 'important_not_urgent',
      reason: admittedIds.has(task.taskId)
        ? { kind: 'fact', label: '共享统计已准入 Agent 队列，当前无紧急人工动作' }
        : { kind: 'inference', label: '工作可继续推进，当前没有阻塞或人工决策信号' },
      ruleRef: admittedIds.has(task.taskId)
        ? 'dashboard.important.shared-agent-queue@v001'
        : 'dashboard.important.active-work@v001',
    };
  }
  const updatedAt = taskTimestamp(task);
  if (
    task.status === 'cancelled'
    && updatedAt !== null
    && isDateInPeriod(calendarDateInTimeZone(new Date(updatedAt), DASHBOARD_TIME_ZONE), currentWeek)
  ) return {
    view: 'weekly_insights',
    reason: { kind: 'fact', label: '本周出现取消状态变化，进入复盘视野' },
    ruleRef: 'dashboard.weekly.recent-outcome@v001',
  };
  return null;
}

function compareCards(left: DashboardCard, right: DashboardCard, tasksById: ReadonlyMap<string, Task>): number {
  const leftTask = tasksById.get(left.taskId);
  const rightTask = tasksById.get(right.taskId);
  if (leftTask === undefined || rightTask === undefined) {
    return left.taskId.localeCompare(right.taskId);
  }
  return priorityRank[leftTask.priority] - priorityRank[rightTask.priority]
    || (taskTimestamp(rightTask) ?? 0) - (taskTimestamp(leftTask) ?? 0)
    || left.taskId.localeCompare(right.taskId);
}

export function buildWorkbenchDashboard(input: BuildWorkbenchDashboardInput): WorkbenchDashboard {
  const projectsById = new Map(input.projects.map((project) => [project.projectId, project]));
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const statistics = computeTaskStatistics(input.tasks, {
    now: input.now,
    knownProjectIds: new Set(projectsById.keys()),
  });
  const admittedIds = new Set(statistics.agentQueue.admittedTaskIds);
  const quarantineReasons = new Map(
    statistics.agentQueue.quarantinedTasks.map(({ taskId, reasons }) => [taskId, reasons]),
  );
  const integrityTaskIds = new Set([
    ...statistics.integrityIssues.unknownStatusTaskIds,
    ...statistics.integrityIssues.invalidClaimLeaseTaskIds,
  ]);
  const expiredClaimIds = new Set(statistics.expiredClaimTaskIds);
  const currentWeek = currentIsoWeekPeriod(input.now, DASHBOARD_TIME_ZONE);
  const completions = completionEvidence(input.tasks, input.auditEvents, currentWeek);
  const viewCards = new Map<DashboardViewId, DashboardCard[]>(
    DASHBOARD_VIEW_IDS.map((view) => [view, []]),
  );

  for (const task of input.tasks) {
    const rule = taskRule(
      task,
      admittedIds,
      quarantineReasons,
      integrityTaskIds,
      expiredClaimIds,
      currentWeek,
    );
    if (rule === null) continue;
    viewCards.get(rule.view)?.push({
      cardId: `${rule.view}:${task.taskId}`,
      taskId: task.taskId,
      title: task.title,
      reason: rule.reason,
      source: sourceFact(task),
      goalImpact: goalFact(task, projectsById),
      timeliness: timeliness(task, input.now),
      status: status(task),
      ruleRef: rule.ruleRef,
      traceRef: traceRef(task),
      action: factAction(task),
    });
  }

  for (const completion of completions.currentWeek) {
    const { task, date } = completion;
    viewCards.get('weekly_insights')?.push({
      cardId: `weekly_insights:${task.taskId}:${date}`,
      taskId: task.taskId,
      title: task.title,
      reason: {
        kind: 'fact',
        label: task.artifactRefs.length > 0
          ? `${date} 完成并关联 ${task.artifactRefs.length} 个 Artifact`
          : `${date} 形成完成结果`,
      },
      source: sourceFact(task),
      goalImpact: goalFact(task, projectsById),
      timeliness: timeliness(task, input.now),
      status: status(task),
      ruleRef: 'dashboard.weekly.recent-outcome@v001',
      traceRef: traceRef(task),
      action: factAction(task),
    });
  }

  const views = DASHBOARD_VIEW_IDS.map((id): DashboardView => ({
    id,
    ...VIEW_COPY[id],
    cards: (viewCards.get(id) ?? []).sort((left, right) => compareCards(left, right, tasksById)),
  }));
  const cards = views.flatMap(({ cards: candidateCards }) => candidateCards);
  const stateReasons: string[] = [];
  const hasIntegrityIssues = integrityTaskIds.size > 0 || expiredClaimIds.size > 0;
  if (hasIntegrityIssues) stateReasons.push('共享统计报告完整性或租约异常');
  if (completions.missingTaskIds.size > 0) {
    stateReasons.push(`${completions.missingTaskIds.size} 个已完成任务缺少可审计完成日期，未计入本周结果`);
  }
  if (cards.some(({ timeliness: cardTimeliness }) => cardTimeliness.state === 'stale')) {
    stateReasons.push('至少一项驾驶舱事实超过 24 小时未更新');
  }
  if (cards.some(({ source, goalImpact, traceRef: cardTrace }) => (
    source.kind === 'missing' || goalImpact.kind === 'missing' || cardTrace === null
  ))) {
    stateReasons.push('部分卡片缺少来源、目标关系或 Trace 引用');
  }
  const dataState: DashboardDataState = hasIntegrityIssues
    ? 'integrity'
    : cards.length === 0
      ? completions.missingTaskIds.size > 0 ? 'partial' : 'empty'
      : completions.missingTaskIds.size > 0
        ? 'partial'
        : stateReasons.some((reason) => reason.includes('超过 24 小时'))
        ? 'stale'
        : stateReasons.length > 0
          ? 'partial'
          : 'complete';
  return {
    observedAt: input.now.toISOString(),
    dataState,
    stateReasons,
    summary: {
      weeklyResults: completions.currentWeek.length,
      candidateTasks: input.tasks.filter((task) => (
        task.status === 'inbox' && task.reviewState === 'candidate'
      )).length,
      agentQueue: {
        raw: statistics.statusCounts.agentExecutable,
        admitted: statistics.agentQueue.admittedCount,
        quarantined: statistics.agentQueue.quarantinedCount,
      },
      needsUser: viewCards.get('requires_user')?.length ?? 0,
      activeTasks: statistics.statusCounts.inProgress,
    },
    integrity: {
      ...statistics.integrityIssues,
      expiredClaimTaskIds: statistics.expiredClaimTaskIds,
    },
    views,
  };
}

export async function queryWorkbenchDashboard(ctx: ServiceContext): Promise<WorkbenchDashboard> {
  const now = ctx.clock();
  const [tasks, projects, auditEvents] = await Promise.all([
    ctx.tasks.list(),
    ctx.projects.list(),
    ctx.audit.listBetween({
      fromInclusive: new Date(0).toISOString(),
      toExclusive: new Date(now.getTime() + 1).toISOString(),
    }),
  ]);
  return buildWorkbenchDashboard({ tasks, projects, auditEvents, now });
}
