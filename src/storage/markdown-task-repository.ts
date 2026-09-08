import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  decisionContextSchema,
  pendingDecisionSchema,
  taskStatusSchema,
  taskSchema,
  type DecisionContext,
  type PendingDecision,
  type Priority,
  type Task,
  type TaskBrief,
  type TaskStatus,
} from '../domain/task.js';
import {
  candidateUnderstandingRevisionSchema,
  type CandidateUnderstandingRevision,
} from '../domain/candidate-understanding.js';
import {
  executionLinkSchema,
  type ExecutionLink,
} from '../domain/execution-link.js';
import {
  actionRequestSchema,
  type ActionRequest,
} from '../domain/action-request.js';
import type { TaskRepository } from './contracts.js';
import {
  acquireSafeFileLock,
  atomicWriteTextFile,
  listSafeRegularFiles,
  moveSafeRegularFile,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import { rebuildTaskIndex } from './task-index.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  isTaskMarkdownPath,
  lifecycleDirectory,
  taskStorageRoot,
  type VaultWriteAuthorization,
  vaultRoot,
} from './task-paths.js';

interface TaskRecord {
  path: string;
  data: Record<string, unknown>;
  body: string;
  raw: string;
  snapshot: string;
}

interface TaskEntry {
  record: TaskRecord;
  task: Task;
}

export class TaskNotFoundError extends Error {
  readonly code = 'task_not_found';

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class InvalidTaskDataError extends Error {
  readonly code = 'invalid_task_data';
  readonly field: string | undefined;

  constructor(field?: string) {
    super(field === undefined ? 'Invalid task data' : `Invalid task data: ${field}`);
    this.name = 'InvalidTaskDataError';
    this.field = field;
  }
}

export class TaskConflictError extends Error {
  readonly code = 'task_conflict';

  constructor() {
    super('Task storage conflict');
    this.name = 'TaskConflictError';
  }
}

export class TaskMoveRecoveryError extends Error {
  readonly code = 'task_move_recovery_error';
  readonly recovered: boolean;

  constructor(recovered: boolean) {
    super('Task lifecycle move write failed');
    this.name = 'TaskMoveRecoveryError';
    this.recovered = recovered;
  }
}

export class TaskIntegrityError extends Error {
  readonly code = 'task_integrity_error';

  constructor() {
    super('Task storage integrity error');
    this.name = 'TaskIntegrityError';
  }
}

export class TaskSavedIndexStaleError extends Error {
  readonly code = 'task_saved_index_stale';

  constructor(options?: ErrorOptions) {
    super('Task saved but task index is stale', options);
    this.name = 'TaskSavedIndexStaleError';
  }
}

export class TaskSourceClaimTimeoutError extends Error {
  readonly code = 'task_source_claim_timeout';

  constructor() {
    super('Task source claim timed out');
    this.name = 'TaskSourceClaimTimeoutError';
  }
}

export class TaskLockTimeoutError extends Error {
  readonly code = 'task_lock_timeout';

  constructor() {
    super('Task lock timed out');
    this.name = 'TaskLockTimeoutError';
  }
}

const SOURCE_CLAIM_ATTEMPTS = 100;
const SOURCE_CLAIM_RETRY_MS = 10;
const SOURCE_CLAIM_LEASE_MS = 30_000;
const TASK_LOCK_ATTEMPTS = 3_100;
const TASK_LOCK_RETRY_MS = 10;
const TASK_LOCK_LEASE_MS = 30_000;

export interface MarkdownTaskRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
  sourceClaim?: {
    attempts?: number;
    retryMs?: number;
    leaseMs?: number;
    clock?: () => Date;
  };
  taskLock?: {
    attempts?: number;
    retryMs?: number;
    leaseMs?: number;
    clock?: () => Date;
  };
}

interface SourceClaimOptions {
  attempts: number;
  retryMs: number;
  leaseMs: number;
  clock: () => Date;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : [];
}

function legacyEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = data[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new InvalidTaskDataError(field);
}

function legacyNullableEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | null {
  const value = data[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  throw new InvalidTaskDataError(field);
}

function taskStatus(data: Record<string, unknown>): TaskStatus {
  const value = data.status;
  if (value === undefined || value === null) {
    return 'inbox';
  }
  const result = taskStatusSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidTaskDataError('status');
  }
  return result.data;
}

function priority(data: Record<string, unknown>): Priority {
  return legacyEnum(data, 'priority', [
    'urgent',
    'high',
    'normal',
    'low',
  ], 'normal');
}

function legacyBoolean(
  data: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = data[field];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  throw new InvalidTaskDataError(field);
}

function deriveLegacySourceKey(data: Record<string, unknown>): string {
  const digest = createHash('sha256')
    .update([
      stringValue(data.origin),
      stringValue(data.source_date),
      stringValue(data.source_note),
      stringValue(data.source_quote),
    ].join('|'))
    .digest('hex');
  return `legacy:${digest}`;
}

function mapClaim(value: unknown): Task['claim'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError();
  }
  const claim = value as Record<string, unknown>;
  return {
    runId: stringValue(claim.run_id ?? claim.runId),
    agent: stringValue(claim.agent),
    claimedAt: stringValue(claim.claimed_at ?? claim.claimedAt),
    leaseExpiresAt: stringValue(claim.lease_expires_at ?? claim.leaseExpiresAt),
  };
}

function mapTaskBrief(value: unknown): TaskBrief | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('task_brief');
  }
  const brief = value as Record<string, unknown>;
  const hasSnakeVersion = brief.schema_version !== undefined;
  const hasCamelVersion = brief.schemaVersion !== undefined;
  if (
    (!hasSnakeVersion && !hasCamelVersion)
    || (hasSnakeVersion && brief.schema_version !== 1)
    || (hasCamelVersion && brief.schemaVersion !== 1)
  ) {
    throw new InvalidTaskDataError('task_brief');
  }
  const mapped: TaskBrief = {
    schemaVersion: 1,
    objective: stringValue(brief.objective),
    nextAction: stringValue(brief.next_action ?? brief.nextAction),
    completionCriteria: stringValue(
      brief.completion_criteria ?? brief.completionCriteria,
    ),
    updatedAt: stringValue(brief.updated_at ?? brief.updatedAt),
  };
  return mapped;
}

function mapCandidateUnderstanding(value: unknown): CandidateUnderstandingRevision | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('candidate_understanding');
  }
  const candidate = value as Record<string, unknown>;
  const aliasedValue = (
    record: Record<string, unknown>,
    snakeCase: string,
    camelCase: string,
  ): unknown => Object.prototype.hasOwnProperty.call(record, snakeCase)
    ? record[snakeCase]
    : record[camelCase];
  const suggestions = Array.isArray(candidate.suggestions)
    ? candidate.suggestions.map((raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new InvalidTaskDataError('candidate_understanding');
        }
        const item = raw as Record<string, unknown>;
        return {
          field: item.field,
          suggestedValue: item.suggested_value ?? item.suggestedValue,
          attribution: item.attribution,
          sourceRefIds: item.source_ref_ids ?? item.sourceRefIds,
          reason: item.reason,
          generationId: item.generation_id ?? item.generationId,
        };
      })
    : [];
  const rawSourceRefs = candidate.source_refs ?? candidate.sourceRefs;
  const sourceRefs = Array.isArray(rawSourceRefs)
    ? rawSourceRefs.map((raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new InvalidTaskDataError('candidate_understanding');
        }
        const item = raw as Record<string, unknown>;
        const evidence = aliasedValue(item, 'last_verified_evidence', 'lastVerifiedEvidence');
        let lastVerifiedEvidence: unknown = null;
        if (typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)) {
          const entry = evidence as Record<string, unknown>;
          lastVerifiedEvidence = {
            resolvedNote: aliasedValue(entry, 'resolved_note', 'resolvedNote'),
            checkedCharacters: aliasedValue(entry, 'checked_characters', 'checkedCharacters'),
            quoteMatched: aliasedValue(entry, 'quote_matched', 'quoteMatched'),
            truncated: entry.truncated,
          };
        }
        return {
          sourceRefId: item.source_ref_id ?? item.sourceRefId,
          sourceType: item.source_type ?? item.sourceType,
          sourceKey: item.source_key ?? item.sourceKey,
          sourceNote: aliasedValue(item, 'source_note', 'sourceNote'),
          anchor: item.anchor,
          quote: item.quote,
          capturedAt: item.captured_at ?? item.capturedAt,
          lastVerifiedAt: aliasedValue(item, 'last_verified_at', 'lastVerifiedAt'),
          status: item.status,
          failureReason: aliasedValue(item, 'failure_reason', 'failureReason'),
          parentContext: aliasedValue(item, 'parent_context', 'parentContext'),
          lastVerifiedEvidence,
        };
      })
    : [];
  const gaps = Array.isArray(candidate.gaps)
    ? candidate.gaps.map((raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new InvalidTaskDataError('candidate_understanding');
        }
        const item = raw as Record<string, unknown>;
        return {
          gapId: item.gap_id ?? item.gapId,
          field: item.field,
          severity: item.severity,
          reasonCode: item.reason_code ?? item.reasonCode,
          question: item.question,
          impact: item.impact,
          sourceRefIds: item.source_ref_ids ?? item.sourceRefIds,
        };
      })
    : [];
  const result = candidateUnderstandingRevisionSchema.safeParse({
    schemaVersion: candidate.schema_version ?? candidate.schemaVersion,
    generationId: candidate.generation_id ?? candidate.generationId,
    taskType: candidate.task_type ?? candidate.taskType,
    suggestions,
    sourceRefs,
    gaps,
    revision: candidate.revision,
    confirmed: candidate.confirmed,
    updatedAt: candidate.updated_at ?? candidate.updatedAt,
  });
  if (!result.success) throw new InvalidTaskDataError('candidate_understanding');
  return result.data;
}

function mapPendingDecision(value: unknown): PendingDecision | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('pending_decision');
  }
  const decision = value as Record<string, unknown>;
  const options = Array.isArray(decision.options)
    ? decision.options.map((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new InvalidTaskDataError('pending_decision');
      }
      const option = value as Record<string, unknown>;
      return {
        id: stringValue(option.id),
        label: stringValue(option.label),
      };
    })
    : [];
  const result = pendingDecisionSchema.safeParse({
    schemaVersion: decision.schema_version ?? decision.schemaVersion,
    requestId: decision.request_id ?? decision.requestId,
    question: decision.question,
    options,
    requestedAt: decision.requested_at ?? decision.requestedAt,
    requestedByRunId: decision.requested_by_run_id ?? decision.requestedByRunId,
  });
  if (!result.success) throw new InvalidTaskDataError('pending_decision');
  return result.data;
}

// PAW-GOAL-003 T1: execution_link frontmatter follows the TECH §2 snake_case
// contract; an unparseable link fails closed instead of silently dropping the
// dispatch ledger state.
function mapExecutionLink(value: unknown): ExecutionLink | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('execution_link');
  }
  const link = value as Record<string, unknown>;
  const result = executionLinkSchema.safeParse({
    schemaVersion: link.schema_version ?? link.schemaVersion,
    provider: link.provider,
    idempotencyKey: link.idempotency_key ?? link.idempotencyKey,
    workspaceId: link.workspace_id ?? link.workspaceId,
    projectId: link.project_id ?? link.projectId,
    issueId: link.issue_id ?? link.issueId ?? null,
    issueIdentifier: link.issue_identifier ?? link.issueIdentifier ?? null,
    ...(link.activation_assignee_id === undefined && link.activationAssigneeId === undefined
      ? {}
      : { activationAssigneeId: link.activation_assignee_id ?? link.activationAssigneeId ?? null }),
    ...(link.activation_run_id === undefined && link.activationRunId === undefined
      ? {}
      : { activationRunId: link.activation_run_id ?? link.activationRunId ?? null }),
    ...(link.context_manifest_id === undefined && link.contextManifestId === undefined
      ? {}
      : { contextManifestId: link.context_manifest_id ?? link.contextManifestId ?? null }),
    ...(link.context_manifest_sha256 === undefined && link.contextManifestSha256 === undefined
      ? {}
      : { contextManifestSha256: link.context_manifest_sha256 ?? link.contextManifestSha256 ?? null }),
    ...(link.execution_binding_receipt_id === undefined && link.executionBindingReceiptId === undefined
      ? {}
      : { executionBindingReceiptId: link.execution_binding_receipt_id ?? link.executionBindingReceiptId ?? null }),
    ...(link.remote_artifact_receipt_ids === undefined && link.remoteArtifactReceiptIds === undefined
      ? {}
      : { remoteArtifactReceiptIds: stringArray(link.remote_artifact_receipt_ids ?? link.remoteArtifactReceiptIds) }),
    ...(link.activation_agent_model === undefined && link.activationAgentModel === undefined
      ? {}
      : { activationAgentModel: link.activation_agent_model ?? link.activationAgentModel ?? null }),
    ...(link.activation_agent_max_concurrent_tasks === undefined && link.activationAgentMaxConcurrentTasks === undefined
      ? {}
      : { activationAgentMaxConcurrentTasks: link.activation_agent_max_concurrent_tasks ?? link.activationAgentMaxConcurrentTasks ?? null }),
    ...(link.activation_agent_runtime_id === undefined && link.activationAgentRuntimeId === undefined
      ? {}
      : { activationAgentRuntimeId: link.activation_agent_runtime_id ?? link.activationAgentRuntimeId ?? null }),
    ...(link.activation_run_status === undefined && link.activationRunStatus === undefined
      ? {}
      : { activationRunStatus: link.activation_run_status ?? link.activationRunStatus ?? null }),
    ...(link.activation_run_runtime_id === undefined && link.activationRunRuntimeId === undefined
      ? {}
      : { activationRunRuntimeId: link.activation_run_runtime_id ?? link.activationRunRuntimeId ?? null }),
    dispatchState: link.dispatch_state ?? link.dispatchState,
    remoteState: link.remote_state ?? link.remoteState ?? null,
    lastCommentId: link.last_comment_id ?? link.lastCommentId ?? null,
    lastEventId: link.last_event_id ?? link.lastEventId ?? null,
    summary: link.summary ?? null,
    artifactRefs: stringArray(link.artifact_refs ?? link.artifactRefs),
    lastAttemptAt: link.last_attempt_at ?? link.lastAttemptAt ?? null,
    lastSyncedAt: link.last_synced_at ?? link.lastSyncedAt ?? null,
  });
  if (!result.success) throw new InvalidTaskDataError('execution_link');
  return result.data;
}

function executionLinkFrontmatter(
  link: Task['executionLink'],
): Record<string, unknown> | null {
  if (link === null || link === undefined) return null;
  return {
    schema_version: link.schemaVersion,
    provider: link.provider,
    idempotency_key: link.idempotencyKey,
    workspace_id: link.workspaceId,
    project_id: link.projectId,
    issue_id: link.issueId,
    issue_identifier: link.issueIdentifier,
    ...(link.activationAssigneeId === undefined
      ? {}
      : { activation_assignee_id: link.activationAssigneeId }),
    ...(link.activationRunId === undefined
      ? {}
      : { activation_run_id: link.activationRunId }),
    ...(link.contextManifestId === undefined
      ? {}
      : { context_manifest_id: link.contextManifestId }),
    ...(link.contextManifestSha256 === undefined
      ? {}
      : { context_manifest_sha256: link.contextManifestSha256 }),
    ...(link.executionBindingReceiptId === undefined
      ? {}
      : { execution_binding_receipt_id: link.executionBindingReceiptId }),
    ...(link.remoteArtifactReceiptIds === undefined
      ? {}
      : { remote_artifact_receipt_ids: link.remoteArtifactReceiptIds }),
    ...(link.activationAgentModel === undefined
      ? {}
      : { activation_agent_model: link.activationAgentModel }),
    ...(link.activationAgentMaxConcurrentTasks === undefined
      ? {}
      : { activation_agent_max_concurrent_tasks: link.activationAgentMaxConcurrentTasks }),
    ...(link.activationAgentRuntimeId === undefined
      ? {}
      : { activation_agent_runtime_id: link.activationAgentRuntimeId }),
    ...(link.activationRunStatus === undefined
      ? {}
      : { activation_run_status: link.activationRunStatus }),
    ...(link.activationRunRuntimeId === undefined
      ? {}
      : { activation_run_runtime_id: link.activationRunRuntimeId }),
    dispatch_state: link.dispatchState,
    remote_state: link.remoteState,
    last_comment_id: link.lastCommentId,
    last_event_id: link.lastEventId,
    summary: link.summary,
    artifact_refs: link.artifactRefs,
    last_attempt_at: link.lastAttemptAt,
    last_synced_at: link.lastSyncedAt,
  };
}

// PAW-GOAL-003 T2: action_request frontmatter follows the TECH §2 snake_case
// contract; an unparseable request fails closed instead of silently dropping
// the pending human decision.
function mapActionRequest(value: unknown): ActionRequest | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('action_request');
  }
  const request = value as Record<string, unknown>;
  const result = actionRequestSchema.safeParse({
    schemaVersion: request.schema_version ?? request.schemaVersion,
    actionId: request.action_id ?? request.actionId,
    eventId: request.event_id ?? request.eventId,
    type: request.type,
    status: request.status,
    title: request.title,
    summary: request.summary,
    allowedActions: stringArray(request.allowed_actions ?? request.allowedActions),
    multicaIssue: request.multica_issue ?? request.multicaIssue,
    githubPr: request.github_pr ?? request.githubPr ?? null,
    headSha: request.head_sha ?? request.headSha ?? null,
    notificationId: request.notification_id ?? request.notificationId ?? null,
    handledStreamEventId: request.handled_stream_event_id ?? request.handledStreamEventId ?? null,
    handledTerminalStep: request.handled_terminal_step ?? request.handledTerminalStep ?? null,
  });
  if (!result.success) throw new InvalidTaskDataError('action_request');
  return result.data;
}

function actionRequestFrontmatter(
  request: Task['actionRequest'],
): Record<string, unknown> | null {
  if (request === null || request === undefined) return null;
  return {
    schema_version: request.schemaVersion,
    action_id: request.actionId,
    event_id: request.eventId,
    type: request.type,
    status: request.status,
    title: request.title,
    summary: request.summary,
    allowed_actions: request.allowedActions,
    multica_issue: request.multicaIssue,
    github_pr: request.githubPr,
    head_sha: request.headSha,
    notification_id: request.notificationId,
    handled_stream_event_id: request.handledStreamEventId,
    handled_terminal_step: request.handledTerminalStep,
  };
}

// TEP-50 fix 1: the retained handled history round-trips under
// `handled_action_requests`; an unparseable or null entry fails closed exactly
// like the current request.
function mapHandledActionRequests(value: unknown): ActionRequest[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new InvalidTaskDataError('handled_action_requests');
  }
  return value.flatMap((entry) => {
    const request = mapActionRequest(entry);
    if (request === null) {
      throw new InvalidTaskDataError('handled_action_requests');
    }
    return [request];
  });
}

function mapDecisionContext(value: unknown): DecisionContext | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDataError('last_decision');
  }
  const decision = value as Record<string, unknown>;
  const responseText = decision.response_text ?? decision.responseText;
  const senderUserId = decision.sender_user_id ?? decision.senderUserId;
  const conversationId = decision.conversation_id ?? decision.conversationId;
  const continuationRunId = 'continuation_run_id' in decision
    ? decision.continuation_run_id
    : decision.continuationRunId;
  const continuationOfRunId = 'continuation_of_run_id' in decision
    ? decision.continuation_of_run_id
    : decision.continuationOfRunId;
  const continuationStartedAt = 'continuation_started_at' in decision
    ? decision.continuation_started_at
    : decision.continuationStartedAt;
  const result = decisionContextSchema.safeParse({
    schemaVersion: decision.schema_version ?? decision.schemaVersion,
    requestId: decision.request_id ?? decision.requestId,
    selectedOptionId: decision.selected_option_id ?? decision.selectedOptionId,
    selectedOptionLabel: decision.selected_option_label ?? decision.selectedOptionLabel,
    responseText: responseText === undefined ? null : responseText,
    responseEventId: decision.response_event_id ?? decision.responseEventId,
    ...(senderUserId === undefined ? {} : { senderUserId }),
    ...(conversationId === undefined ? {} : { conversationId }),
    respondedAt: decision.responded_at ?? decision.respondedAt,
    ...(continuationRunId === undefined ? {} : { continuationRunId }),
    ...(continuationOfRunId === undefined ? {} : { continuationOfRunId }),
    ...(continuationStartedAt === undefined ? {} : { continuationStartedAt }),
  });
  if (!result.success) throw new InvalidTaskDataError('last_decision');
  return result.data;
}

export function taskFromDocument(
  record: Pick<TaskRecord, 'path' | 'data' | 'body'>,
): Task {
  const data = record.data;
  const taskBrief = mapTaskBrief(data.task_brief);
  const candidateUnderstanding = mapCandidateUnderstanding(data.candidate_understanding);
  const pendingDecision = mapPendingDecision(data.pending_decision);
  const lastDecision = mapDecisionContext(data.last_decision);
  const reviewState = legacyEnum(data, 'review_state', [
    'candidate',
    'ready_for_confirm',
    'confirmed',
  ], 'candidate');
  const taskType = legacyNullableEnum(data, 'task_type', ['research', 'development']);
  const permissionProfile = legacyNullableEnum(
    data,
    'permission_profile',
    ['read_only_research', 'repo_delivery'],
  );
  const executionTarget = legacyNullableEnum(data, 'execution_target', ['multica']);
  const executionLink = mapExecutionLink(data.execution_link);
  const actionRequest = mapActionRequest(data.action_request);
  const handledActionRequests = mapHandledActionRequests(data.handled_action_requests);
  const task: Task = {
    schemaVersion: 1,
    taskId: stringValue(data.task_id, basename(record.path, '.md')),
    title: stringValue(data.title),
    body: record.body,
    status: taskStatus(data),
    reviewState,
    projectId: nullableString(data.project_id),
    taskType,
    objective: nullableString(data.objective),
    acceptanceCriteria: stringArray(data.acceptance_criteria),
    autoExecutable: legacyBoolean(data, 'auto_executable', false),
    permissionProfile,
    ...(executionTarget === null ? {} : { executionTarget }),
    ...(Array.isArray(data.context_refs) ? { contextRefs: stringArray(data.context_refs) } : {}),
    ...(executionLink === null ? {} : { executionLink }),
    ...(actionRequest === null ? {} : { actionRequest }),
    ...(handledActionRequests.length === 0 ? {} : { handledActionRequests }),
    origin: stringValue(data.origin, 'legacy'),
    sourceDate: nullableString(data.source_date),
    sourceNote: nullableString(data.source_note),
    sourceQuote: nullableString(data.source_quote),
    sourceKey: stringValue(data.source_key) || deriveLegacySourceKey(data),
    possibleDuplicateIds: stringArray(data.possible_duplicate_ids),
    priority: priority(data),
    attempts: typeof data.attempts === 'number'
      && Number.isInteger(data.attempts)
      && data.attempts >= 0
      ? data.attempts
      : 0,
    claim: mapClaim(data.claim),
    artifactRefs: stringArray(data.artifact_refs),
    reviewFeedback: nullableString(data.review_feedback),
    readyAt: nullableString(data.ready_at),
    ...(pendingDecision === null ? {} : { pendingDecision }),
    ...(lastDecision === null ? {} : { lastDecision }),
    ...(taskBrief === null ? {} : { taskBrief }),
    ...(candidateUnderstanding === null ? {} : { candidateUnderstanding }),
    createdAt: stringValue(data.created_at, '1970-01-01T00:00:00.000Z'),
    updatedAt: stringValue(data.updated_at, '1970-01-01T00:00:00.000Z'),
  };

  const result = taskSchema.safeParse(task);
  if (!result.success) {
    throw new InvalidTaskDataError();
  }
  return result.data;
}

function canonicalTaskSnapshot(task: Task): string {
  const canonical: Partial<Task> = { ...task };
  delete canonical.body;
  return JSON.stringify(canonical);
}

function claimFrontmatter(claim: Task['claim']): Record<string, string> | null {
  return claim === null ? null : {
    run_id: claim.runId,
    agent: claim.agent,
    claimed_at: claim.claimedAt,
    lease_expires_at: claim.leaseExpiresAt,
  };
}

function taskBriefFrontmatter(brief: Task['taskBrief']): Record<string, unknown> | null {
  return brief === null || brief === undefined ? null : {
    schema_version: brief.schemaVersion,
    objective: brief.objective,
    next_action: brief.nextAction,
    completion_criteria: brief.completionCriteria,
    updated_at: brief.updatedAt,
  };
}

function candidateUnderstandingFrontmatter(
  candidate: Task['candidateUnderstanding'],
): Record<string, unknown> | null {
  if (candidate === null || candidate === undefined) return null;
  return {
    schema_version: candidate.schemaVersion,
    generation_id: candidate.generationId,
    task_type: candidate.taskType,
    revision: candidate.revision,
    confirmed: candidate.confirmed,
    updated_at: candidate.updatedAt,
    suggestions: candidate.suggestions.map((item) => ({
      field: item.field,
      suggested_value: item.suggestedValue,
      attribution: item.attribution,
      source_ref_ids: item.sourceRefIds,
      reason: item.reason,
      generation_id: item.generationId,
    })),
    source_refs: candidate.sourceRefs.map((item) => ({
      source_ref_id: item.sourceRefId,
      source_type: item.sourceType,
      source_key: item.sourceKey,
      source_note: item.sourceNote,
      anchor: item.anchor,
      quote: item.quote,
      captured_at: item.capturedAt,
      last_verified_at: item.lastVerifiedAt,
      status: item.status,
      failure_reason: item.failureReason,
      parent_context: item.parentContext,
      last_verified_evidence: item.lastVerifiedEvidence === null
        ? null
        : {
            resolved_note: item.lastVerifiedEvidence.resolvedNote,
            checked_characters: item.lastVerifiedEvidence.checkedCharacters,
            quote_matched: item.lastVerifiedEvidence.quoteMatched,
            truncated: item.lastVerifiedEvidence.truncated,
          },
    })),
    gaps: candidate.gaps.map((item) => ({
      gap_id: item.gapId,
      field: item.field,
      severity: item.severity,
      reason_code: item.reasonCode,
      question: item.question,
      impact: item.impact,
      source_ref_ids: item.sourceRefIds,
    })),
  };
}

function pendingDecisionFrontmatter(
  decision: Task['pendingDecision'],
): Record<string, unknown> | null {
  return decision === null || decision === undefined ? null : {
    schema_version: decision.schemaVersion,
    request_id: decision.requestId,
    question: decision.question,
    options: decision.options,
    requested_at: decision.requestedAt,
    requested_by_run_id: decision.requestedByRunId,
  };
}

function decisionContextFrontmatter(
  decision: Task['lastDecision'],
): Record<string, unknown> | null {
  return decision === null || decision === undefined ? null : {
    schema_version: decision.schemaVersion,
    request_id: decision.requestId,
    selected_option_id: decision.selectedOptionId,
    selected_option_label: decision.selectedOptionLabel,
    response_text: decision.responseText,
    response_event_id: decision.responseEventId,
    ...(decision.senderUserId === undefined
      ? {}
      : { sender_user_id: decision.senderUserId }),
    ...(decision.conversationId === undefined
      ? {}
      : { conversation_id: decision.conversationId }),
    responded_at: decision.respondedAt,
    ...(decision.continuationRunId === undefined
      ? {}
      : { continuation_run_id: decision.continuationRunId }),
    ...(decision.continuationOfRunId === undefined
      ? {}
      : { continuation_of_run_id: decision.continuationOfRunId }),
    ...(decision.continuationStartedAt === undefined
      ? {}
      : { continuation_started_at: decision.continuationStartedAt }),
  };
}

function mergeTaskData(
  original: Record<string, unknown>,
  task: Task,
): Record<string, unknown> {
  const taskBrief = taskBriefFrontmatter(task.taskBrief);
  const candidateUnderstanding = candidateUnderstandingFrontmatter(
    task.candidateUnderstanding,
  );
  const pendingDecision = pendingDecisionFrontmatter(task.pendingDecision);
  const lastDecision = decisionContextFrontmatter(task.lastDecision);
  const executionLink = executionLinkFrontmatter(task.executionLink);
  const actionRequest = actionRequestFrontmatter(task.actionRequest);
  const handledActionRequests = (task.handledActionRequests ?? [])
    .map((request) => actionRequestFrontmatter(request));
  const base = { ...original };
  if (task.taskBrief === null) {
    delete base.task_brief;
  }
  if (task.candidateUnderstanding === null) {
    delete base.candidate_understanding;
  }
  if (task.pendingDecision === null) {
    delete base.pending_decision;
  }
  if (task.lastDecision === null) {
    delete base.last_decision;
  }
  if (executionLink === null) {
    delete base.execution_link;
  }
  if (actionRequest === null) {
    delete base.action_request;
  }
  if (handledActionRequests.length === 0) {
    delete base.handled_action_requests;
  }
  return {
    ...base,
    type: 'task',
    schema_version: task.schemaVersion,
    task_id: task.taskId,
    title: task.title,
    status: task.status,
    review_state: task.reviewState,
    project_id: task.projectId,
    task_type: task.taskType,
    objective: task.objective,
    acceptance_criteria: task.acceptanceCriteria,
    auto_executable: task.autoExecutable,
    permission_profile: task.permissionProfile,
    execution_target: task.executionTarget ?? null,
    ...(task.contextRefs === undefined ? {} : { context_refs: task.contextRefs }),
    execution_link: executionLink,
    ...(actionRequest === null ? {} : { action_request: actionRequest }),
    ...(handledActionRequests.length === 0
      ? {}
      : { handled_action_requests: handledActionRequests }),
    origin: task.origin,
    source_date: task.sourceDate,
    source_note: task.sourceNote,
    source_quote: task.sourceQuote,
    source_key: task.sourceKey,
    possible_duplicate_ids: task.possibleDuplicateIds,
    priority: task.priority,
    attempts: task.attempts,
    claim: claimFrontmatter(task.claim),
    artifact_refs: task.artifactRefs,
    review_feedback: task.reviewFeedback,
    ready_at: task.readyAt,
    ...(pendingDecision === null ? {} : { pending_decision: pendingDecision }),
    ...(lastDecision === null ? {} : { last_decision: lastDecision }),
    ...(taskBrief === null ? {} : { task_brief: taskBrief }),
    ...(candidateUnderstanding === null
      ? {}
      : { candidate_understanding: candidateUnderstanding }),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function hasSafeTaskPaths(task: Task): boolean {
  return isSafePathSegment(task.taskId)
    && (task.projectId === null || isSafePathSegment(task.projectId))
    && (task.sourceDate === null || /^\d{4}-\d{2}-\d{2}$/.test(task.sourceDate))
    && /^\d{4}/.test(task.updatedAt);
}

export class MarkdownTaskRepository implements TaskRepository {
  readonly root: string;
  readonly tasksRoot: string;
  readonly records = new Map<string, TaskRecord>();
  private readonly sourceClaim: SourceClaimOptions;
  private readonly taskLock: SourceClaimOptions;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;
  private readonly heldTaskLocks = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(root?: string, options: MarkdownTaskRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.writeAuthorization = options.writeAuthorization;
    this.sourceClaim = {
      attempts: positiveInteger(
        options.sourceClaim?.attempts,
        SOURCE_CLAIM_ATTEMPTS,
      ),
      retryMs: nonNegativeInteger(
        options.sourceClaim?.retryMs,
        SOURCE_CLAIM_RETRY_MS,
      ),
      leaseMs: positiveInteger(
        options.sourceClaim?.leaseMs,
        SOURCE_CLAIM_LEASE_MS,
      ),
      clock: options.sourceClaim?.clock ?? (() => new Date()),
    };
    this.taskLock = {
      attempts: positiveInteger(
        options.taskLock?.attempts,
        TASK_LOCK_ATTEMPTS,
      ),
      retryMs: nonNegativeInteger(
        options.taskLock?.retryMs,
        TASK_LOCK_RETRY_MS,
      ),
      leaseMs: positiveInteger(
        options.taskLock?.leaseMs,
        TASK_LOCK_LEASE_MS,
      ),
      clock: options.taskLock?.clock ?? (() => new Date()),
    };
  }

  async withTaskLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    if (!isSafePathSegment(taskId)) {
      throw new InvalidTaskDataError();
    }
    const inheritedLocks = this.heldTaskLocks.getStore();
    if (inheritedLocks?.has(taskId) === true) {
      return operation();
    }
    const lockRoot = join(this.tasksRoot, '.atl', 'task-locks');
    const lockKey = createHash('sha256').update(taskId).digest('hex');
    const lockPath = join(lockRoot, `${lockKey}.lock`);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < this.taskLock.attempts; attempt += 1) {
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: this.taskLock.clock(),
        leaseMs: this.taskLock.leaseMs,
      });
      if (lock === null) {
        const reclaimed = await reclaimExpiredSafeFileLock(
          lockPath,
          boundary,
          this.taskLock.clock(),
        );
        if (reclaimed) {
          lock = await acquireSafeFileLock(lockPath, boundary, {
            acquiredAt: this.taskLock.clock(),
            leaseMs: this.taskLock.leaseMs,
          });
        }
        if (lock === null) {
          if (attempt + 1 < this.taskLock.attempts) {
            await delay(this.taskLock.retryMs);
          }
          continue;
        }
      }
      try {
        return await this.heldTaskLocks.run(
          new Set([...(inheritedLocks ?? []), taskId]),
          operation,
        );
      } finally {
        await lock.release();
      }
    }
    throw new TaskLockTimeoutError();
  }

  async list(): Promise<Task[]> {
    const entries = await this.scanEntries();
    const records = new Map(entries.map(({ record, task }) => [task.taskId, record]));
    this.records.clear();
    for (const [taskId, record] of records) {
      this.records.set(taskId, record);
    }
    return entries.map(({ task }) => task);
  }

  async get(taskId: string): Promise<Task> {
    const tasks = await this.list();
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  async findBySourceKey(sourceKey: string): Promise<Task | null> {
    return (await this.list()).find((task) => task.sourceKey === sourceKey) ?? null;
  }

  async createIfSourceKeyAbsent(task: Task): Promise<{
    task: Task;
    created: boolean;
  }> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const result = taskSchema.safeParse(task);
    if (!result.success || !hasSafeTaskPaths(result.data)) {
      throw new InvalidTaskDataError();
    }
    const validTask = result.data;
    const lockRoot = join(this.tasksRoot, '.atl', 'source-key-locks');
    const lockKey = createHash('sha256').update(validTask.sourceKey).digest('hex');
    const lockPath = join(lockRoot, `${lockKey}.lock`);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: lockRoot,
    };

    for (let attempt = 0; attempt < this.sourceClaim.attempts; attempt += 1) {
      let lock = await acquireSafeFileLock(lockPath, boundary, {
        acquiredAt: this.sourceClaim.clock(),
        leaseMs: this.sourceClaim.leaseMs,
      });
      if (lock === null) {
        const reclaimed = await reclaimExpiredSafeFileLock(
          lockPath,
          boundary,
          this.sourceClaim.clock(),
        );
        if (reclaimed) {
          lock = await acquireSafeFileLock(lockPath, boundary, {
            acquiredAt: this.sourceClaim.clock(),
            leaseMs: this.sourceClaim.leaseMs,
          });
        }
        if (lock === null) {
          if (attempt + 1 < this.sourceClaim.attempts) {
            await delay(this.sourceClaim.retryMs);
          }
          continue;
        }
      }
      try {
        const existing = await this.findBySourceKey(validTask.sourceKey);
        if (existing !== null) {
          return { task: existing, created: false };
        }
        return { task: await this.save(validTask), created: true };
      } finally {
        await lock.release();
      }
    }

    const existing = await this.findBySourceKey(validTask.sourceKey);
    if (existing !== null) {
      return { task: existing, created: false };
    }
    throw new TaskSourceClaimTimeoutError();
  }

  async save(task: Task): Promise<Task> {
    return this.withTaskLock(task.taskId, () => this.saveTask(task, true));
  }

  async saveBody(task: Task): Promise<Task> {
    return this.withTaskLock(task.taskId, () => this.saveTask(task, false));
  }

  private async saveTask(task: Task, preserveExistingBody: boolean): Promise<Task> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const result = taskSchema.safeParse(task);
    if (!result.success) {
      throw new InvalidTaskDataError();
    }
    const validTask = result.data;
    if (!hasSafeTaskPaths(validTask)) {
      throw new InvalidTaskDataError();
    }
    const cached = this.records.get(validTask.taskId);
    const entries = await this.scanEntries();
    const current = entries.find((entry) => entry.task.taskId === validTask.taskId);
    if (cached !== undefined) {
      if (current === undefined || current.record.snapshot !== cached.snapshot) {
        throw new TaskConflictError();
      }
    }

    const existing = current?.record;
    // Normal metadata saves preserve manual body edits. Explicit body saves are
    // reserved for services that re-read the task while holding its lock.
    const body = preserveExistingBody
      ? existing?.body ?? validTask.body
      : validTask.body;
    const persistedTask = { ...validTask, body };
    const data = mergeTaskData(existing?.data ?? {}, persistedTask);
    const targetDirectory = lifecycleDirectory(this.tasksRoot, persistedTask);
    const targetPath = join(targetDirectory, `${persistedTask.taskId}.md`);
    const serialized = serializeTaskDocument(data, body);
    if (existing !== undefined && existing.path !== targetPath) {
      try {
        await this.moveTaskFile(existing.path, targetPath, existing.raw);
      } catch {
        throw new TaskConflictError();
      }
      try {
        await this.writeTaskFile(targetPath, serialized);
      } catch {
        let recovered = false;
        try {
          await this.moveTaskFile(targetPath, existing.path, existing.raw);
          recovered = true;
        } catch {
          // Leave the single surviving copy in place for a later rescan/recovery.
        }
        throw new TaskMoveRecoveryError(recovered);
      }
    } else {
      try {
        await this.writeTaskFile(targetPath, serialized);
      } catch (error) {
        if (existing !== undefined) {
          throw new TaskConflictError();
        }
        throw error;
      }
    }
    this.records.set(persistedTask.taskId, {
      path: targetPath,
      data,
      body,
      raw: serialized,
      snapshot: canonicalTaskSnapshot(persistedTask),
    });

    try {
      await rebuildTaskIndex(this.root, undefined, this.writeAuthorization);
    } catch (error) {
      throw new TaskSavedIndexStaleError({ cause: error });
    }
    return persistedTask;
  }

  protected async writeTaskFile(path: string, content: string): Promise<void> {
    await atomicWriteTextFile(path, content);
  }

  protected async moveTaskFile(
    sourcePath: string,
    targetPath: string,
    expectedContent: string,
  ): Promise<void> {
    await moveSafeRegularFile(sourcePath, targetPath, expectedContent, {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
    });
  }

  private async scanEntries(): Promise<TaskEntry[]> {
    const candidates = (await Promise.all(
      ['Inbox', 'Active', 'Archive'].map(async (directory) => {
        const subtree = join(this.tasksRoot, directory);
        const boundary = {
          vaultRoot: this.root,
          tasksRoot: this.tasksRoot,
          subtree,
        };
        const paths = await listSafeRegularFiles(boundary, '**/*.md');
        return paths.map((path) => ({ path, boundary }));
      }),
    )).flat();
    const entries: TaskEntry[] = [];
    const taskIds = new Set<string>();
    for (const { path, boundary } of candidates) {
      const entry = await this.readEntry(path, boundary);
      if (entry === null) {
        continue;
      }
      if (taskIds.has(entry.task.taskId)) {
        throw new TaskIntegrityError();
      }
      taskIds.add(entry.task.taskId);
      entries.push(entry);
    }
    return entries;
  }

  private async readEntry(
    path: string,
    boundary: StorageReadBoundary,
  ): Promise<TaskEntry | null> {
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      return null;
    }
    let document;
    try {
      document = parseTaskDocument(raw);
    } catch (error) {
      if (!isTaskMarkdownPath(path)) {
        return null;
      }
      throw error;
    }
    if (!isTaskMarkdownPath(path) && document.data.type !== 'task') {
      return null;
    }
    const task = taskFromDocument({ path, ...document });
    return {
      task,
      record: {
        path,
        ...document,
        raw,
        snapshot: canonicalTaskSnapshot(task),
      },
    };
  }
}
