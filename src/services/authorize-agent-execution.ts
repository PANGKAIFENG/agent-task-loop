import {
  evaluateAgentAdmissionForTask,
  type AgentAdmissionInputOverrides,
} from './evaluate-agent-admission.js';
import { isExternalExecutionTask, readinessErrors, type Task } from '../domain/task.js';
import type { AdmissionVerdict } from '../domain/agent-admission.js';
import { assertTransition } from '../domain/transitions.js';
import { TaskSavedIndexStaleError } from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export class AgentAuthorizationInvalidStateError extends Error {
  readonly code = 'task_agent_authorization_invalid_state';

  constructor() {
    super('Task must be Ready to authorize Agent execution');
    this.name = 'AgentAuthorizationInvalidStateError';
  }
}

export class AgentAuthorizationNotReadyError extends Error {
  readonly code = 'task_agent_authorization_not_ready';
  readonly errors: string[];
  readonly verdict: AdmissionVerdict | null;

  constructor(errors: string[], verdict: AdmissionVerdict | null = null) {
    super('Task execution context is incomplete');
    this.name = 'AgentAuthorizationNotReadyError';
    this.errors = errors;
    this.verdict = verdict;
  }
}

export class AgentAuthorizationStaleVerdictError extends Error {
  readonly code = 'task_agent_authorization_stale_verdict';
  readonly expectedInputFingerprint: string;
  readonly currentInputFingerprint: string;

  constructor(expectedInputFingerprint: string, currentInputFingerprint: string) {
    super('The Agent admission verdict is stale');
    this.name = 'AgentAuthorizationStaleVerdictError';
    this.expectedInputFingerprint = expectedInputFingerprint;
    this.currentInputFingerprint = currentInputFingerprint;
  }
}

export class AgentAuthorizationAuditFailedError extends Error {
  readonly code = 'task_agent_authorization_audit_failed';

  constructor() {
    super('Agent execution authorization audit failed');
    this.name = 'AgentAuthorizationAuditFailedError';
  }
}

export class AgentAuthorizationRecoveryError extends Error {
  readonly code = 'task_agent_authorization_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Agent execution authorization recovery required');
    this.name = 'AgentAuthorizationRecoveryError';
  }
}

export interface AuthorizeAgentExecutionOptions {
  admission?: AgentAdmissionInputOverrides;
  expectedInputFingerprint?: string;
}

export interface AuthorizeResearchExecutionStateOptions {
  requireMultica?: boolean;
}

async function commitAgentAuthorization(
  ctx: ServiceContext,
  task: Task,
  admissionInputFingerprint?: string,
): Promise<Task> {
  assertTransition('ready', 'agent_executable');
  const timestamp = ctx.clock().toISOString();
  const authorized: Task = {
    ...task,
    status: 'agent_executable',
    autoExecutable: true,
    updatedAt: timestamp,
  };

  let saved: Task;
  let staleIndexError: TaskSavedIndexStaleError | null = null;
  try {
    saved = await ctx.tasks.save(authorized);
  } catch (error) {
    if (!(error instanceof TaskSavedIndexStaleError)) throw error;
    saved = authorized;
    staleIndexError = error;
  }
  try {
    await ctx.audit.append({
      event: 'task.agent_authorized',
      at: timestamp,
      taskId: task.taskId,
      ...(admissionInputFingerprint === undefined ? {} : { admissionInputFingerprint }),
      details: {
        fromStatus: 'ready',
        toStatus: 'agent_executable',
      },
    });
  } catch {
    try {
      await ctx.tasks.save(task);
    } catch (error) {
      if (error instanceof TaskSavedIndexStaleError) {
        throw new AgentAuthorizationAuditFailedError();
      }
      throw new AgentAuthorizationRecoveryError();
    }
    throw new AgentAuthorizationAuditFailedError();
  }
  if (staleIndexError !== null) throw staleIndexError;
  return saved;
}

export async function authorizeLegacyResearchExecution(
  ctx: ServiceContext,
  taskId: string,
): Promise<Task> {
  return authorizeResearchExecutionState(ctx, taskId);
}

export async function authorizeResearchExecutionState(
  ctx: ServiceContext,
  taskId: string,
  options: AuthorizeResearchExecutionStateOptions = {},
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'ready') {
      throw new AgentAuthorizationInvalidStateError();
    }
    const errors = [
      ...(options.requireMultica === true && !isExternalExecutionTask(task)
        ? ['executionTarget must be multica']
        : []),
      ...(task.reviewState === 'confirmed' ? [] : ['reviewState must be confirmed']),
      ...readinessErrors(task),
    ];
    if (errors.length > 0) {
      throw new AgentAuthorizationNotReadyError(errors);
    }
    return commitAgentAuthorization(ctx, task);
  });
}

export async function authorizeAgentExecution(
  ctx: ServiceContext,
  taskId: string,
  options: AuthorizeAgentExecutionOptions = {},
): Promise<Task> {
  return ctx.tasks.withTaskLock(taskId, async () => {
    const task = await ctx.tasks.get(taskId);
    if (task.status !== 'ready') {
      throw new AgentAuthorizationInvalidStateError();
    }
    const verdict = await evaluateAgentAdmissionForTask(ctx, task, {
      ...options.admission,
      evaluatedAt: ctx.clock().toISOString(),
    });
    if (
      options.expectedInputFingerprint !== undefined
      && options.expectedInputFingerprint !== verdict.input_fingerprint
    ) {
      throw new AgentAuthorizationStaleVerdictError(
        options.expectedInputFingerprint,
        verdict.input_fingerprint,
      );
    }
    const legacyErrors = [
      ...(task.reviewState === 'confirmed' ? [] : ['reviewState must be confirmed']),
      ...readinessErrors(task),
    ];
    if (legacyErrors.length > 0) {
      throw new AgentAuthorizationNotReadyError(legacyErrors, verdict);
    }
    if (verdict.verdict !== 'admittable') {
      const reasons = verdict.reasons.map(({ code, message }) => `${code}: ${message}`);
      throw new AgentAuthorizationNotReadyError(reasons, verdict);
    }
    return commitAgentAuthorization(ctx, task, verdict.input_fingerprint);
  });
}
