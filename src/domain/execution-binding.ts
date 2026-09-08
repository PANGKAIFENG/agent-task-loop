import { createHash } from 'node:crypto';

import type { MulticaVerifiedAgentSnapshot } from '../connectors/multica-cli-connector.js';

export interface ExecutionBindingReceipt {
  schemaVersion: 1;
  receiptId: string;
  taskId: string;
  taskContextVersion: string;
  taskContentSha256: string;
  projectContextSha256: string;
  vaultIdentity: string;
  dispatchAttemptId: string;
  manifestId: string;
  manifestSha256: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  issueIdentifier: string;
  assigneeType: 'agent';
  agent: MulticaVerifiedAgentSnapshot;
  run: {
    runId: string;
    agentId: string;
    status: string;
    runtimeId: string;
  };
  createdAt: string;
}

export type CreateExecutionBindingReceiptInput = Omit<
  ExecutionBindingReceipt,
  'schemaVersion' | 'receiptId'
>;

export class ExecutionBindingEvidenceError extends Error {
  readonly code = 'execution_binding_evidence_invalid';

  constructor() {
    super('Execution binding evidence is missing or invalid');
    this.name = 'ExecutionBindingEvidenceError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function unsigned(receipt: Omit<ExecutionBindingReceipt, 'receiptId'>) {
  return {
    schemaVersion: 1 as const,
    taskId: receipt.taskId,
    taskContextVersion: receipt.taskContextVersion,
    taskContentSha256: receipt.taskContentSha256,
    projectContextSha256: receipt.projectContextSha256,
    vaultIdentity: receipt.vaultIdentity,
    dispatchAttemptId: receipt.dispatchAttemptId,
    manifestId: receipt.manifestId,
    manifestSha256: receipt.manifestSha256,
    workspaceId: receipt.workspaceId,
    projectId: receipt.projectId,
    issueId: receipt.issueId,
    issueIdentifier: receipt.issueIdentifier,
    assigneeType: receipt.assigneeType,
    agent: receipt.agent,
    run: receipt.run,
    createdAt: receipt.createdAt,
  };
}

export function executionBindingReceiptId(
  receipt: Omit<ExecutionBindingReceipt, 'receiptId'>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(unsigned(receipt)))
    .digest('hex');
  return `ebr_${digest.slice(0, 24)}`;
}

export function createExecutionBindingReceipt(
  input: CreateExecutionBindingReceiptInput,
): ExecutionBindingReceipt {
  const receipt = { schemaVersion: 1 as const, ...input };
  const candidate = {
    ...receipt,
    receiptId: executionBindingReceiptId(receipt),
  };
  if (!isValidExecutionBindingReceipt(candidate)) {
    throw new ExecutionBindingEvidenceError();
  }
  return candidate;
}

export function isValidExecutionBindingReceipt(
  value: unknown,
): value is ExecutionBindingReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'receiptId',
    'taskId',
    'taskContextVersion',
    'taskContentSha256',
    'projectContextSha256',
    'vaultIdentity',
    'dispatchAttemptId',
    'manifestId',
    'manifestSha256',
    'workspaceId',
    'projectId',
    'issueId',
    'issueIdentifier',
    'assigneeType',
    'agent',
    'run',
    'createdAt',
  ]) || !isRecord(value.agent) || !hasExactKeys(value.agent, [
    'agentId',
    'workspaceId',
    'model',
    'maxConcurrentTasks',
    'runtimeId',
    'status',
  ]) || !isRecord(value.run) || !hasExactKeys(value.run, [
    'runId',
    'agentId',
    'status',
    'runtimeId',
  ])) return false;
  const receipt = value as unknown as ExecutionBindingReceipt;
  return receipt.schemaVersion === 1
    && typeof receipt.receiptId === 'string'
    && receipt.receiptId === executionBindingReceiptId(receipt)
    && typeof receipt.taskId === 'string'
    && receipt.taskId.trim() !== ''
    && typeof receipt.taskContextVersion === 'string'
    && Number.isFinite(Date.parse(receipt.taskContextVersion))
    && typeof receipt.taskContentSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.taskContentSha256)
    && typeof receipt.projectContextSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.projectContextSha256)
    && typeof receipt.vaultIdentity === 'string'
    && /^vault_[0-9a-f]{64}$/u.test(receipt.vaultIdentity)
    && typeof receipt.dispatchAttemptId === 'string'
    && receipt.dispatchAttemptId.trim() !== ''
    && typeof receipt.manifestId === 'string'
    && /^cm_[0-9a-f]{24}$/u.test(receipt.manifestId)
    && typeof receipt.manifestSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.manifestSha256)
    && typeof receipt.workspaceId === 'string'
    && receipt.workspaceId.trim() !== ''
    && typeof receipt.projectId === 'string'
    && receipt.projectId.trim() !== ''
    && typeof receipt.issueId === 'string'
    && receipt.issueId.trim() !== ''
    && typeof receipt.issueIdentifier === 'string'
    && receipt.issueIdentifier.trim() !== ''
    && receipt.assigneeType === 'agent'
    && typeof receipt.agent.agentId === 'string'
    && receipt.agent.agentId.trim() !== ''
    && typeof receipt.agent.workspaceId === 'string'
    && receipt.agent.workspaceId === receipt.workspaceId
    && typeof receipt.agent.model === 'string'
    && receipt.agent.model.trim() !== ''
    && typeof receipt.agent.maxConcurrentTasks === 'number'
    && Number.isSafeInteger(receipt.agent.maxConcurrentTasks)
    && receipt.agent.maxConcurrentTasks > 0
    && typeof receipt.agent.runtimeId === 'string'
    && receipt.agent.runtimeId.trim() !== ''
    && typeof receipt.agent.status === 'string'
    && receipt.agent.status.trim() !== ''
    && typeof receipt.run.runId === 'string'
    && receipt.run.runId.trim() !== ''
    && typeof receipt.run.agentId === 'string'
    && receipt.run.agentId === receipt.agent.agentId
    && typeof receipt.run.status === 'string'
    && receipt.run.status.trim() !== ''
    && typeof receipt.run.runtimeId === 'string'
    && receipt.run.runtimeId === receipt.agent.runtimeId
    && typeof receipt.createdAt === 'string'
    && Number.isFinite(Date.parse(receipt.createdAt));
}

export function executionBindingIdentityMatches(
  left: ExecutionBindingReceipt,
  right: ExecutionBindingReceipt,
): boolean {
  return left.taskId === right.taskId
    && left.taskContextVersion === right.taskContextVersion
    && left.taskContentSha256 === right.taskContentSha256
    && left.projectContextSha256 === right.projectContextSha256
    && left.vaultIdentity === right.vaultIdentity
    && left.dispatchAttemptId === right.dispatchAttemptId
    && left.manifestId === right.manifestId
    && left.manifestSha256 === right.manifestSha256
    && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId
    && left.issueId === right.issueId
    && left.issueIdentifier === right.issueIdentifier
    && left.assigneeType === right.assigneeType
    && JSON.stringify(left.agent) === JSON.stringify(right.agent)
    && JSON.stringify(left.run) === JSON.stringify(right.run);
}
