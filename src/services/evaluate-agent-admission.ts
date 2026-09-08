import type {
  AdmissionInput,
  AdmissionVerdict,
  PermissionMode,
} from '../domain/agent-admission.js';
import { evaluateAgentAdmission } from '../domain/agent-admission.js';
import type { Task } from '../domain/task.js';
import type { ServiceContext } from './service-context.js';

export type AgentAdmissionInputOverrides = Partial<
  Omit<AdmissionInput, 'task' | 'evaluatedAt'>
> & { evaluatedAt?: string };

function legacyPermissionMode(task: Task): PermissionMode | null {
  if (task.permissionProfile === 'read_only_research') return 'readonly';
  if (task.permissionProfile === 'repo_delivery') return 'external_write';
  return null;
}

export async function buildAgentAdmissionInput(
  ctx: ServiceContext,
  task: Task,
  overrides: AgentAdmissionInputOverrides = {},
): Promise<AdmissionInput> {
  const project = task.projectId === null
    ? null
    : await ctx.projects.get(task.projectId).catch(() => null);
  const refs = task.contextRefs?.filter((ref) => ref.trim() !== '') ?? [];
  const sourceKnown = task.sourceKey.trim() !== '';
  const defaults: AdmissionInput = {
    task,
    project: {
      exists: project !== null,
      projectId: project?.projectId ?? null,
    },
    source: {
      status: sourceKnown ? 'unavailable' : 'missing',
      sourceKey: sourceKnown ? task.sourceKey : null,
    },
    contextPack: {
      contextPackId: null,
      complete: false,
      refs,
    },
    expectedArtifact: null,
    priorityAndTimeKnown: false,
    capability: null,
    permission: {
      mode: legacyPermissionMode(task),
      externalWrites: [],
      authorization: null,
    },
    capacity: { available: null },
    duplicate: {
      possible: task.possibleDuplicateIds.length > 0,
      taskIds: [...task.possibleDuplicateIds],
    },
    evaluatedAt: overrides.evaluatedAt ?? ctx.clock().toISOString(),
  };
  return {
    ...defaults,
    ...overrides,
    task,
    evaluatedAt: overrides.evaluatedAt ?? defaults.evaluatedAt,
  };
}

export async function evaluateAgentAdmissionForTask(
  ctx: ServiceContext,
  task: Task,
  overrides: AgentAdmissionInputOverrides = {},
): Promise<AdmissionVerdict> {
  return evaluateAgentAdmission(await buildAgentAdmissionInput(ctx, task, overrides));
}

// Stable service-facing alias for callers that already use the domain noun.
export const evaluateTaskAdmission = evaluateAgentAdmissionForTask;
