import { contextRefErrors, type Task } from '../domain/task.js';
import { developmentAuthorizationGaps } from '../services/authorize-development-task.js';

// PAW-GOAL-003-V0.5 D1 (PRD 4.2): the Task Contract preview and the dispatch
// button gating are driven by the service admission (one rule set). This
// module only translates the service gap strings into specific, actionable
// messages — it never decides admission itself.

export interface ContractGap {
  source: string;
  message: string;
}

export const REPO_DELIVERY_GAP = 'repo_delivery_acknowledged';

const ALLOWLIST_ERROR_PREFIX = 'contextRefs entry is outside the allowlist: ';
const TRAVERSAL_ERROR_PREFIX = 'contextRefs entry must not contain traversal segments: ';

const GAP_MESSAGES: Record<string, string> = {
  'reviewState must be confirmed': '任务尚未完成确认，请先确认任务',
  'status must be agent_executable': '任务状态不满足投递前置条件，请刷新看板',
  'taskType must be development': '任务类型必须是开发任务（development）',
  'projectId is required': '请选择或新建项目',
  'objective is required': '请填写任务目标',
  'acceptanceCriteria requires at least one item': '至少填写一条验收标准',
  'permissionProfile must be repo_delivery': '权限声明必须是 repo_delivery',
  'executionTarget must be multica': '执行目标必须是 Multica',
  'contextRefs requires at least one item': '至少添加一条执行工作区内的仓库相对路径引用',
  'contextRefs must not contain empty entries': '上下文引用不能包含空条目，请删除空行',
  'contextRefs entries must be at most 300 characters': '单条上下文引用不能超过 300 字符',
  'contextRefs entries must not contain control characters': '上下文引用不能包含控制字符',
};

function localizeRefError(error: string): string {
  if (error.startsWith(ALLOWLIST_ERROR_PREFIX)) {
    return `引用 ${error.slice(ALLOWLIST_ERROR_PREFIX.length)} 是绝对路径，超出了执行工作区范围，请改为仓库相对路径或移除`;
  }
  if (error.startsWith(TRAVERSAL_ERROR_PREFIX)) {
    return `引用 ${error.slice(TRAVERSAL_ERROR_PREFIX.length)} 含有路径穿越段（..），请改为仓库相对路径`;
  }
  return error;
}

export function contextRefGapMessages(refs: readonly string[]): string[] {
  return contextRefErrors(refs, []).map(localizeRefError);
}

// Unknown service gaps fall back to a labeled raw source string so a future
// admission rule can never be silently hidden from the user.
function localizeGap(source: string): string {
  const known = GAP_MESSAGES[source];
  if (known !== undefined) return known;
  const localized = localizeRefError(source);
  return localized === source ? `服务端校验未通过：${source}` : localized;
}

// D2: admission errors returned by the service (including symlink findings
// that only the dispatch gate can detect) reuse the same localization.
export function localizeGaps(sources: readonly string[]): ContractGap[] {
  return sources.map((source) => ({ source, message: localizeGap(source) }));
}

export function contractGaps(
  task: Task,
  repoDeliveryAcknowledged: boolean,
): ContractGap[] {
  const gaps = developmentAuthorizationGaps(task)
    .map((source) => ({ source, message: localizeGap(source) }));
  if (!repoDeliveryAcknowledged) {
    return [
      ...gaps,
      {
        source: REPO_DELIVERY_GAP,
        message: '权限声明未确认：请勾选 repo_delivery 授权说明',
      },
    ];
  }
  return gaps;
}

export function isContractDispatchable(
  task: Task,
  repoDeliveryAcknowledged: boolean,
): boolean {
  return contractGaps(task, repoDeliveryAcknowledged).length === 0;
}
