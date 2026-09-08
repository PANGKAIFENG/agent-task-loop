import { createHash } from 'node:crypto';

import type { Task } from './task.js';

export const ADMISSION_RULE_VERSION = 'agent-admission-v1';

export const EXTERNAL_WRITE_ACTIONS = [
  'dingtalk_message',
  'dingtalk_todo',
  'dingtalk_calendar',
  'yunxiao_workitem',
  'vault_write',
  'external_repo_commit',
  'external_publish',
] as const;

export type ExternalWriteAction = (typeof EXTERNAL_WRITE_ACTIONS)[number];
export type PermissionMode = 'readonly' | 'draft' | 'external_write';
export type AdmissionVerdictCode =
  | 'rejected'
  | 'needs_completion'
  | 'needs_authorization'
  | 'admittable';

export type AdmissionReasonCode =
  | 'task_status_not_admittable'
  | 'task_not_confirmed'
  | 'project_missing_or_unknown'
  | 'source_missing'
  | 'source_unavailable'
  | 'source_conflict'
  | 'objective_missing'
  | 'acceptance_missing'
  | 'artifact_missing'
  | 'context_pack_incomplete'
  | 'priority_or_time_unknown'
  | 'permission_mode_unknown'
  | 'task_permission_mismatch'
  | 'capability_permission_mismatch'
  | 'external_write_list_required'
  | 'external_write_not_allowed_for_mode'
  | 'external_write_action_unknown'
  | 'external_write_target_required'
  | 'read_back_contract_required'
  | 'external_write_confirmation_required'
  | 'capability_not_applicable'
  | 'eval_gate_missing'
  | 'possible_duplicate'
  | 'agent_capacity_unavailable'
  | 'verdict_stale';

export interface ExternalWriteSpec {
  action: ExternalWriteAction | string;
  target: string;
  readBackExpectation: string;
}

export interface AgentTaskAuthorization {
  taskId: string;
  taskRevision: string;
  admissionInputFingerprint: string;
  exactActions: ExternalWriteSpec[];
  actor: string;
  authorizedAt: string;
  expiresOrInvalidatesOn: string;
  readBackReceipt: string | null;
}

export interface AdmissionPermissionInput {
  mode: PermissionMode | null;
  externalWrites: ExternalWriteSpec[];
  authorization: AgentTaskAuthorization | null;
}

export interface CapabilityPermissionBoundary {
  mode: PermissionMode;
  externalWrites: ExternalWriteAction[];
}

export interface AdmissionInput {
  task: Task;
  project: {
    exists: boolean;
    projectId: string | null;
  };
  source: {
    status: 'available' | 'moved' | 'changed' | 'unavailable' | 'missing';
    sourceKey: string | null;
  };
  contextPack: {
    contextPackId: string | null;
    complete: boolean;
    refs: string[];
  };
  expectedArtifact: string | null;
  priorityAndTimeKnown: boolean;
  capability: {
    capabilityId: string;
    taskTypes: string[];
    projectRefs: string[];
    applicable: boolean;
    profileComplete: boolean;
    permissions: CapabilityPermissionBoundary;
    eval: {
      gate: string;
      passed: boolean;
    } | null;
  } | null;
  permission: AdmissionPermissionInput;
  capacity: {
    available: boolean | null;
    reason?: string | null | undefined;
  };
  duplicate: {
    possible: boolean | null;
    taskIds?: string[] | undefined;
  };
  evaluatedAt: string;
}

export interface AdmissionReason {
  code: AdmissionReasonCode;
  field_or_gate: string;
  message: string;
  recoverable: boolean;
  next_action: string;
}

export interface PermissionGate {
  mode: PermissionMode | null;
  external_writes: ExternalWriteSpec[];
  requires_authorization: boolean;
  authorized: boolean;
}

export interface AdmissionVerdict {
  verdict: AdmissionVerdictCode;
  evaluated_at: string;
  rule_version: string;
  input_fingerprint: string;
  reasons: AdmissionReason[];
  permission_gate: PermissionGate;
}

const BLOCKING_REASONS = new Set<AdmissionReasonCode>([
  'task_status_not_admittable',
  'source_unavailable',
  'source_conflict',
  'task_permission_mismatch',
  'capability_permission_mismatch',
  'external_write_list_required',
  'external_write_not_allowed_for_mode',
  'external_write_action_unknown',
  'external_write_target_required',
  'read_back_contract_required',
  'possible_duplicate',
  'agent_capacity_unavailable',
  'verdict_stale',
]);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'readonly' || value === 'draft' || value === 'external_write';
}

function reason(
  code: AdmissionReasonCode,
  fieldOrGate: string,
  message: string,
  recoverable: boolean,
  nextAction: string,
): AdmissionReason {
  return {
    code,
    field_or_gate: fieldOrGate,
    message,
    recoverable,
    next_action: nextAction,
  };
}

function normalizeExternalWrites(
  writes: readonly ExternalWriteSpec[] | null | undefined,
): ExternalWriteSpec[] {
  if (!Array.isArray(writes)) return [];
  return [...writes]
    .map((write) => ({
      action: typeof write?.action === 'string' ? write.action : '',
      target: typeof write?.target === 'string' ? write.target : '',
      readBackExpectation: typeof write?.readBackExpectation === 'string'
        ? write.readBackExpectation
        : '',
    }))
    .sort((left, right) => [left.action, left.target, left.readBackExpectation]
      .join('\u0000')
      .localeCompare([right.action, right.target, right.readBackExpectation]
        .join('\u0000')));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalize(entry)]));
}

function fingerprintInput(input: AdmissionInput): unknown {
  return {
    ruleVersion: ADMISSION_RULE_VERSION,
    task: input.task,
    project: input.project,
    source: input.source,
    contextPack: input.contextPack,
    expectedArtifact: input.expectedArtifact,
    priorityAndTimeKnown: input.priorityAndTimeKnown,
    capability: input.capability,
    permission: {
      mode: input.permission.mode,
      externalWrites: normalizeExternalWrites(input.permission.externalWrites),
      // The authorization binds to this fingerprint. Including it would make
      // a valid authorization change the fingerprint it is meant to attest.
      authorization: null,
    },
    capacity: input.capacity,
    duplicate: input.duplicate,
  };
}

function inputFingerprint(input: AdmissionInput): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(fingerprintInput(input))))
    .digest('hex');
}

function exactWritesEqual(
  left: readonly ExternalWriteSpec[] | null | undefined,
  right: readonly ExternalWriteSpec[] | null | undefined,
): boolean {
  return JSON.stringify(normalizeExternalWrites(left))
    === JSON.stringify(normalizeExternalWrites(right));
}

function taskPermissionAllows(
  task: Task,
  mode: PermissionMode,
  writes: readonly ExternalWriteSpec[],
): boolean {
  if (task.permissionProfile === 'read_only_research') {
    return mode === 'readonly' && writes.length === 0;
  }
  if (task.permissionProfile === 'repo_delivery') {
    return mode === 'external_write'
      && writes.length > 0
      && writes.every(({ action }) => action === 'external_repo_commit');
  }
  return false;
}

function capabilityPermissionAllows(
  capability: AdmissionInput['capability'],
  mode: PermissionMode,
  writes: readonly ExternalWriteSpec[],
): boolean {
  if (capability === null || capability === undefined) return false;
  const boundary = capability.permissions;
  if (
    boundary === null
    || boundary === undefined
    || !isPermissionMode(boundary.mode)
    || !Array.isArray(boundary.externalWrites)
  ) {
    return false;
  }
  const allowedActions = boundary.externalWrites;
  if (
    allowedActions.some((action) => !EXTERNAL_WRITE_ACTIONS.includes(action))
    || new Set(allowedActions).size !== allowedActions.length
    || boundary.mode !== mode
  ) {
    return false;
  }
  if (boundary.mode !== 'external_write') {
    return allowedActions.length === 0 && writes.length === 0;
  }
  return allowedActions.length > 0
    && writes.length > 0
    && writes.every(({ action }) => allowedActions.includes(action as ExternalWriteAction));
}

function authorizationIsCurrent(
  input: AdmissionInput,
  fingerprint: string,
): boolean {
  const authorization = input.permission.authorization;
  if (authorization === null || authorization === undefined) return false;
  if (
    authorization.taskId !== input.task.taskId
    || authorization.taskRevision !== input.task.updatedAt
    || authorization.admissionInputFingerprint !== fingerprint
    || !exactWritesEqual(authorization.exactActions, input.permission.externalWrites)
    || !nonBlank(authorization.actor)
    || !nonBlank(authorization.authorizedAt)
    || !nonBlank(authorization.expiresOrInvalidatesOn)
  ) {
    return false;
  }
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const taskRevisionAt = Date.parse(input.task.updatedAt);
  const expiry = Date.parse(authorization.expiresOrInvalidatesOn);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (
    !Number.isFinite(authorizedAt)
    || !Number.isFinite(taskRevisionAt)
    || !Number.isFinite(expiry)
    || !Number.isFinite(evaluatedAt)
    || authorizedAt < taskRevisionAt
    || authorizedAt > evaluatedAt
    || expiry <= evaluatedAt
  ) {
    return false;
  }
  if (!nonBlank(authorization.readBackReceipt)) {
    return false;
  }
  return true;
}

function addPermissionReasons(
  input: AdmissionInput,
  fingerprint: string,
  reasons: AdmissionReason[],
): void {
  const permission = input.permission;
  const mode = permission.mode;
  if (!isPermissionMode(mode)) {
    reasons.push(reason(
      'permission_mode_unknown',
      'permission.mode',
      'Permission mode is required before admission.',
      true,
      'Choose readonly, draft, or external_write.',
    ));
    return;
  }

  const writes = Array.isArray(permission.externalWrites)
    ? normalizeExternalWrites(permission.externalWrites)
    : null;
  if (writes === null) {
    reasons.push(reason(
      'external_write_list_required',
      'permission.external_writes',
      'The external write list must be an explicit list.',
      true,
      'Declare every external action and its exact target.',
    ));
    return;
  }
  if (mode !== 'external_write' && writes.length > 0) {
    reasons.push(reason(
      'external_write_not_allowed_for_mode',
      'permission.external_writes',
      `${mode} mode cannot include external write actions.`,
      true,
      'Remove the external write actions or choose external_write.',
    ));
    return;
  }
  if (mode === 'external_write' && writes.length === 0) {
    reasons.push(reason(
      'external_write_list_required',
      'permission.external_writes',
      'external_write requires a non-empty exact action list.',
      true,
      'Declare every external action and its exact target.',
    ));
    return;
  }

  for (const [index, write] of writes.entries()) {
    if (!EXTERNAL_WRITE_ACTIONS.includes(write.action as ExternalWriteAction)) {
      reasons.push(reason(
        'external_write_action_unknown',
        `permission.external_writes[${index}].action`,
        'The external write action is not in the controlled action vocabulary.',
        true,
        'Choose a controlled external write action.',
      ));
    }
    if (!nonBlank(write.target)) {
      reasons.push(reason(
        'external_write_target_required',
        `permission.external_writes[${index}].target`,
        'Every external write must bind an exact target.',
        true,
        'Provide the exact target for this action.',
      ));
    }
    if (!nonBlank(write.readBackExpectation)) {
      reasons.push(reason(
        'read_back_contract_required',
        `permission.external_writes[${index}].readBackExpectation`,
        'Every external write must declare how its result will be read back.',
        true,
        'Add a bounded read-back expectation.',
      ));
    }
  }

  const writeContractInvalid = reasons.some(({ code }) => [
    'external_write_action_unknown',
    'external_write_target_required',
    'read_back_contract_required',
  ].includes(code));
  if (writeContractInvalid) return;

  const taskPermissionMatches = taskPermissionAllows(input.task, mode, writes);
  if (!taskPermissionMatches) {
    reasons.push(reason(
      'task_permission_mismatch',
      'task.permissionProfile',
      'The requested permission exceeds or conflicts with the Task permission profile.',
      true,
      'Use the Task permission profile or route the Task through its dedicated authorization path.',
    ));
  }
  const capabilityPermissionMatches = capabilityPermissionAllows(
    input.capability,
    mode,
    writes,
  );
  if (!capabilityPermissionMatches) {
    reasons.push(reason(
      'capability_permission_mismatch',
      'capability.permissions',
      'The requested permission is outside the Capability mode or action allowlist.',
      true,
      'Choose a Capability whose permission boundary contains the exact requested actions.',
    ));
  }

  if (mode === 'external_write') {
    if (permission.authorization === null || permission.authorization === undefined) {
      if (taskPermissionMatches && capabilityPermissionMatches) {
        reasons.push(reason(
          'external_write_confirmation_required',
          'permission.authorization',
          'External writes require a current, independent task authorization.',
          true,
          'Review the exact actions, targets, and read-back contract, then authorize this task.',
        ));
      }
    } else if (!authorizationIsCurrent(input, fingerprint)) {
      reasons.push(reason(
        'verdict_stale',
        'permission.authorization',
        'The authorization no longer matches the current admission inputs.',
        true,
        'Recompute admission and authorize the current task revision.',
      ));
    }
  }
}

export function evaluateAgentAdmission(input: AdmissionInput): AdmissionVerdict {
  const fingerprint = inputFingerprint(input);
  const reasons: AdmissionReason[] = [];
  const task = input.task;

  if (task.status !== 'ready') {
    reasons.push(reason(
      'task_status_not_admittable',
      'task.status',
      'Only a Ready task can enter the Agent queue.',
      true,
      'Move the task to Ready and evaluate admission again.',
    ));
  }
  if (task.reviewState !== 'confirmed') {
    reasons.push(reason(
      'task_not_confirmed',
      'task.reviewState',
      'The task brief must be confirmed before Agent admission.',
      true,
      'Confirm the task brief first.',
    ));
  }
  if (
    input.project.exists !== true
    || input.project.projectId !== task.projectId
    || !nonBlank(task.projectId)
  ) {
    reasons.push(reason(
      'project_missing_or_unknown',
      'task.projectId',
      'A registered project relation is required.',
      true,
      'Select or repair the task project relation.',
    ));
  }
  if (
    !nonBlank(task.sourceKey)
    || !nonBlank(input.source.sourceKey)
    || input.source.status === 'missing'
  ) {
    reasons.push(reason(
      'source_missing',
      'task.sourceKey',
      'A stable source reference is required.',
      true,
      'Add or restore the source reference.',
    ));
  } else if (input.source.sourceKey !== task.sourceKey) {
    reasons.push(reason(
      'source_conflict',
      'source.sourceKey',
      'The source reference does not match the task source.',
      true,
      'Rebind the task to its exact source reference and re-evaluate admission.',
    ));
  } else if (
    input.source.status === 'unavailable'
    || !['available', 'moved', 'changed', 'unavailable', 'missing'].includes(input.source.status)
  ) {
    reasons.push(reason(
      'source_unavailable',
      'source.status',
      'The task source is currently unavailable.',
      true,
      'Restore the source or keep the task outside the Agent queue.',
    ));
  } else if (input.source.status === 'moved' || input.source.status === 'changed') {
    reasons.push(reason(
      'source_conflict',
      'source.status',
      'The task source changed location or content and needs review.',
      true,
      'Review the source conflict and re-evaluate admission.',
    ));
  }
  if (!nonBlank(task.objective)) {
    reasons.push(reason(
      'objective_missing',
      'task.objective',
      'A concrete task objective is required.',
      true,
      'Add the objective to the confirmed task brief.',
    ));
  }
  if (!Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.some(nonBlank)) {
    reasons.push(reason(
      'acceptance_missing',
      'task.acceptanceCriteria',
      'At least one acceptance criterion is required.',
      true,
      'Add a checkable acceptance criterion.',
    ));
  }
  if (!nonBlank(input.expectedArtifact)) {
    reasons.push(reason(
      'artifact_missing',
      'expectedArtifact',
      'The expected Artifact contract is required.',
      true,
      'Declare the Artifact or output contract.',
    ));
  }
  const contextRefs = Array.isArray(input.contextPack.refs) ? input.contextPack.refs : [];
  if (
    !nonBlank(input.contextPack.contextPackId)
    || input.contextPack.complete !== true
    || contextRefs.length === 0
    || contextRefs.some((ref) => !nonBlank(ref))
  ) {
    reasons.push(reason(
      'context_pack_incomplete',
      'contextPack',
      'The bounded Context Pack is incomplete.',
      true,
      'Complete the required Context Pack items.',
    ));
  }
  if (input.priorityAndTimeKnown !== true) {
    reasons.push(reason(
      'priority_or_time_unknown',
      'task.priority',
      'Priority or time commitment is not explained.',
      true,
      'Set a priority and explain the time or capacity commitment.',
    ));
  }
  const taskTypes = Array.isArray(input.capability?.taskTypes)
    ? input.capability.taskTypes
    : [];
  const projectRefs = Array.isArray(input.capability?.projectRefs)
    ? input.capability.projectRefs
    : [];
  if (
    input.capability === null
    || input.capability.applicable !== true
    || !nonBlank(input.capability.capabilityId)
    || input.capability.profileComplete !== true
    || !taskTypes.includes(task.taskType ?? '')
    || !projectRefs.includes(task.projectId ?? '')
  ) {
    reasons.push(reason(
      'capability_not_applicable',
      'capability',
      'No complete capability profile applies to this task and project.',
      true,
      'Choose an applicable capability with bounded Agent, Skill, Tool, and IO limits.',
    ));
  }
  if (
    input.capability?.eval === null
    || !nonBlank(input.capability?.eval?.gate)
    || input.capability?.eval?.passed !== true
  ) {
    reasons.push(reason(
      'eval_gate_missing',
      'capability.eval',
      'The capability Eval gate has not passed.',
      true,
      'Provide a passing Eval gate before admission.',
    ));
  }

  addPermissionReasons(input, fingerprint, reasons);

  if (input.duplicate?.possible !== false) {
    reasons.push(reason(
      'possible_duplicate',
      'duplicate',
      'A possible duplicate task must be resolved before admission.',
      true,
      'Review the related task IDs and resolve the duplicate conflict.',
    ));
  }
  if (input.capacity?.available !== true) {
    reasons.push(reason(
      'agent_capacity_unavailable',
      'capacity',
      input.capacity.reason?.trim() || 'Agent capacity is unavailable.',
      true,
      'Wait for capacity or adjust the queue before retrying.',
    ));
  }

  const hasBlockingReason = reasons.some(({ code }) => BLOCKING_REASONS.has(code));
  const needsAuthorization = reasons.some(
    ({ code }) => code === 'external_write_confirmation_required',
  );
  const verdict: AdmissionVerdictCode = hasBlockingReason
    ? 'rejected'
    : needsAuthorization
      ? 'needs_authorization'
      : reasons.length > 0
        ? 'needs_completion'
        : 'admittable';
  const mode = isPermissionMode(input.permission.mode) ? input.permission.mode : null;
  const permissionContractInvalid = reasons.some(({ code }) => [
    'permission_mode_unknown',
    'task_permission_mismatch',
    'capability_permission_mismatch',
    'external_write_list_required',
    'external_write_not_allowed_for_mode',
    'external_write_action_unknown',
    'external_write_target_required',
    'read_back_contract_required',
  ].includes(code));
  return {
    verdict,
    evaluated_at: input.evaluatedAt,
    rule_version: ADMISSION_RULE_VERSION,
    input_fingerprint: fingerprint,
    reasons,
    permission_gate: {
      mode,
      external_writes: normalizeExternalWrites(input.permission.externalWrites),
      requires_authorization: mode === 'external_write',
      authorized: verdict === 'admittable'
        && mode === 'external_write'
        && !permissionContractInvalid
        && authorizationIsCurrent(input, fingerprint),
    },
  };
}

export function isAdmissionStale(
  verdict: AdmissionVerdict,
  currentInput: AdmissionInput,
): boolean {
  if (
    verdict.rule_version !== ADMISSION_RULE_VERSION
    || verdict.input_fingerprint !== inputFingerprint(currentInput)
  ) {
    return true;
  }
  const current = evaluateAgentAdmission(currentInput);
  return JSON.stringify({
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    permission_gate: verdict.permission_gate,
  }) !== JSON.stringify({
    verdict: current.verdict,
    reasons: current.reasons,
    permission_gate: current.permission_gate,
  });
}

export function admissionInputFingerprint(input: AdmissionInput): string {
  return inputFingerprint(input);
}
