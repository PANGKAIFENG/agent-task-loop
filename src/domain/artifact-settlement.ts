import { createHash } from 'node:crypto';

import {
  isValidArtifactIdentity,
  type ArtifactIdentity,
} from './artifact-identity.js';

export const LOGICAL_DESTINATIONS = [
  'task_only',
  'project_knowledge',
  'personal_knowledge',
  'engineering_repo',
  'capability_governance',
] as const;

export type LogicalDestination = (typeof LOGICAL_DESTINATIONS)[number];

export interface ArtifactSettlementPlan {
  schemaVersion: 1;
  planId: string;
  artifact: ArtifactIdentity;
  decisionId: string;
  logicalDestination: LogicalDestination | 'undecided';
  targetRef: string | null;
  state: 'pending_decision' | 'pending_authorization' | 'ready';
  requiredPermission: string | null;
  createdAt: string;
}

export interface CreateArtifactSettlementPlanInput {
  artifact: ArtifactIdentity;
  decisionId: string;
  requestedDestination: LogicalDestination | null;
  targetRef: string | null;
  authorizedDestinations: LogicalDestination[];
  createdAt: string;
}

export interface SettlementWriteResult {
  status: 'completed' | 'failed' | 'unknown';
  writes: Array<{
    targetRef: string;
    version: string | null;
    sha256: string | null;
    externalId: string | null;
    readback: 'verified' | 'failed' | 'not_available';
    backlink: {
      artifactRef: string;
      artifactSha256: string;
      decisionId: string;
    } | null;
  }>;
}

export interface ArtifactSettlementReceipt {
  schemaVersion: 1;
  receiptId: string;
  planId: string;
  status: 'completed' | 'failed' | 'unknown';
  completedAt: string;
  writes: SettlementWriteResult['writes'];
}

export interface ArtifactSettlementAuthorizationEvidence {
  schemaVersion: 1;
  authorizationId: string;
  planId: string;
  artifactRef: string;
  artifactSha256: string;
  decisionId: string;
  logicalDestination: LogicalDestination;
  vaultRoot: string;
  targetRef: string;
  requiredPermission: string;
  authorizedAt: string;
  readBackReceipt: string;
}

export class ArtifactSettlementInputError extends Error {
  readonly code = 'artifact_settlement_invalid_input';

  constructor() {
    super('Artifact settlement input is invalid');
    this.name = 'ArtifactSettlementInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const sorted = [...expected].sort();
  const actual = Object.keys(value).sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function hasExactArtifactIdentity(value: unknown): value is ArtifactIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['taskId', 'ref', 'version', 'sha256'])
    && typeof value.taskId === 'string'
    && typeof value.ref === 'string'
    && typeof value.version === 'number'
    && typeof value.sha256 === 'string'
    && isValidArtifactIdentity(value as unknown as ArtifactIdentity);
}

function isValidSettlementBacklink(value: unknown): value is NonNullable<
SettlementWriteResult['writes'][number]['backlink']
> {
  return isRecord(value)
    && hasExactKeys(value, ['artifactRef', 'artifactSha256', 'decisionId'])
    && typeof value.artifactRef === 'string'
    && value.artifactRef.trim() !== ''
    && typeof value.artifactSha256 === 'string'
    && /^[0-9a-f]{64}$/u.test(value.artifactSha256)
    && typeof value.decisionId === 'string'
    && value.decisionId.trim() !== '';
}

function isValidSettlementWrite(value: unknown): value is SettlementWriteResult['writes'][number] {
  if (!isRecord(value) || !hasExactKeys(value, [
    'targetRef',
    'version',
    'sha256',
    'externalId',
    'readback',
    'backlink',
  ])) return false;
  return typeof value.targetRef === 'string'
    && value.targetRef.trim() !== ''
    && (typeof value.version === 'string' || value.version === null)
    && (value.sha256 === null || (
      typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256)
    ))
    && (typeof value.externalId === 'string' || value.externalId === null)
    && ['verified', 'failed', 'not_available'].includes(String(value.readback))
    && (value.backlink === null || isValidSettlementBacklink(value.backlink));
}

function unsignedPlan(plan: Omit<ArtifactSettlementPlan, 'planId'>) {
  return {
    schemaVersion: 1 as const,
    artifact: plan.artifact,
    decisionId: plan.decisionId,
    logicalDestination: plan.logicalDestination,
    targetRef: plan.targetRef,
    state: plan.state,
    requiredPermission: plan.requiredPermission,
    createdAt: plan.createdAt,
  };
}

function planIdFor(plan: Omit<ArtifactSettlementPlan, 'planId'>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(unsignedPlan(plan)))
    .digest('hex');
  return `sp_${digest.slice(0, 24)}`;
}

export function isValidArtifactSettlementPlan(
  value: unknown,
): value is ArtifactSettlementPlan {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'planId',
    'artifact',
    'decisionId',
    'logicalDestination',
    'targetRef',
    'state',
    'requiredPermission',
    'createdAt',
  ]) || !hasExactArtifactIdentity(value.artifact)) return false;
  const plan = value as unknown as ArtifactSettlementPlan;
  if (
    plan.schemaVersion !== 1
    || typeof plan.planId !== 'string'
    || typeof plan.decisionId !== 'string'
    || plan.decisionId.trim() === ''
    || !(typeof plan.targetRef === 'string' || plan.targetRef === null)
    || !(typeof plan.requiredPermission === 'string' || plan.requiredPermission === null)
    || typeof plan.createdAt !== 'string'
    || !Number.isFinite(Date.parse(plan.createdAt))
  ) return false;
  if (plan.logicalDestination === 'undecided') {
    if (
      plan.targetRef !== null
      || plan.state !== 'pending_decision'
      || plan.requiredPermission !== null
    ) return false;
  } else {
    if (
      !LOGICAL_DESTINATIONS.includes(plan.logicalDestination)
      || plan.targetRef === null
      || plan.targetRef.trim() === ''
      || !['pending_authorization', 'ready'].includes(plan.state)
      || plan.requiredPermission !== `settle:${plan.logicalDestination}`
    ) return false;
  }
  return plan.planId === planIdFor(plan);
}

export function isValidArtifactSettlementAuthorization(
  value: unknown,
  plan: ArtifactSettlementPlan,
): value is ArtifactSettlementAuthorizationEvidence {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'authorizationId',
    'planId',
    'artifactRef',
    'artifactSha256',
    'decisionId',
    'logicalDestination',
    'vaultRoot',
    'targetRef',
    'requiredPermission',
    'authorizedAt',
    'readBackReceipt',
  ])) return false;
  const authorization = value as unknown as ArtifactSettlementAuthorizationEvidence;
  return isValidArtifactSettlementPlan(plan)
    && plan.state === 'ready'
    && plan.logicalDestination !== 'undecided'
    && plan.targetRef !== null
    && plan.requiredPermission !== null
    && authorization.schemaVersion === 1
    && typeof authorization.authorizationId === 'string'
    && authorization.authorizationId.trim() !== ''
    && typeof authorization.planId === 'string'
    && authorization.planId === plan.planId
    && typeof authorization.artifactRef === 'string'
    && authorization.artifactRef === plan.artifact.ref
    && typeof authorization.artifactSha256 === 'string'
    && authorization.artifactSha256 === plan.artifact.sha256
    && typeof authorization.decisionId === 'string'
    && authorization.decisionId === plan.decisionId
    && authorization.logicalDestination === plan.logicalDestination
    && typeof authorization.vaultRoot === 'string'
    && authorization.vaultRoot.trim() !== ''
    && typeof authorization.targetRef === 'string'
    && authorization.targetRef === plan.targetRef
    && typeof authorization.requiredPermission === 'string'
    && authorization.requiredPermission === plan.requiredPermission
    && typeof authorization.authorizedAt === 'string'
    && Number.isFinite(Date.parse(authorization.authorizedAt))
    && typeof authorization.readBackReceipt === 'string'
    && authorization.readBackReceipt.trim() !== '';
}

export function createArtifactSettlementPlan(
  input: CreateArtifactSettlementPlanInput,
): ArtifactSettlementPlan {
  if (
    !isValidArtifactIdentity(input.artifact)
    || input.decisionId.trim() === ''
    || !Number.isFinite(Date.parse(input.createdAt))
    || (
      input.requestedDestination !== null
      && (input.targetRef === null || input.targetRef.trim() === '')
    )
  ) throw new ArtifactSettlementInputError();

  const logicalDestination: ArtifactSettlementPlan['logicalDestination'] = (
    input.requestedDestination ?? 'undecided'
  );
  const state = input.requestedDestination === null
    ? 'pending_decision' as const
    : input.authorizedDestinations.includes(input.requestedDestination)
      ? 'ready' as const
      : 'pending_authorization' as const;
  const unsigned = unsignedPlan({
    schemaVersion: 1 as const,
    artifact: input.artifact,
    decisionId: input.decisionId,
    logicalDestination,
    targetRef: input.targetRef,
    state,
    requiredPermission: input.requestedDestination === null
      ? null
      : `settle:${input.requestedDestination}`,
    createdAt: input.createdAt,
  });
  return { ...unsigned, planId: planIdFor(unsigned) };
}

export function createArtifactSettlementReceipt(
  plan: ArtifactSettlementPlan,
  result: SettlementWriteResult,
  completedAt: string,
): ArtifactSettlementReceipt {
  if (
    !isValidArtifactSettlementPlan(plan)
    || plan.state !== 'ready'
    || !isRecord(result)
    || !hasExactKeys(result, ['status', 'writes'])
    || !['completed', 'failed', 'unknown'].includes(String(result.status))
    || !Array.isArray(result.writes)
    || !result.writes.every(isValidSettlementWrite)
    || !Number.isFinite(Date.parse(completedAt))
  ) {
    throw new ArtifactSettlementInputError();
  }
  const writes = result.writes.map((write) => ({ ...write }));
  const expectedBacklink = {
    artifactRef: plan.artifact.ref,
    artifactSha256: plan.artifact.sha256,
    decisionId: plan.decisionId,
  };
  const verified = writes.length > 0 && writes.every((write) => (
    write.targetRef === plan.targetRef
    && write.readback === 'verified'
    && write.backlink !== null
    && write.backlink.artifactRef === expectedBacklink.artifactRef
    && write.backlink.artifactSha256 === expectedBacklink.artifactSha256
    && write.backlink.decisionId === expectedBacklink.decisionId
    && (
      (write.sha256 !== null && /^[0-9a-f]{64}$/u.test(write.sha256))
      || (write.externalId !== null && write.externalId.trim() !== '')
    )
  ));
  const status = result.status === 'unknown'
    ? 'unknown' as const
    : result.status === 'completed' && verified
      ? 'completed' as const
      : 'failed' as const;
  const unsigned = {
    schemaVersion: 1 as const,
    planId: plan.planId,
    status,
    completedAt,
    writes,
  };
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return { ...unsigned, receiptId: `sr_${digest.slice(0, 24)}` };
}

export function isValidArtifactSettlementReceipt(
  value: unknown,
  plan: ArtifactSettlementPlan,
): value is ArtifactSettlementReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'receiptId',
    'planId',
    'status',
    'completedAt',
    'writes',
  ]) || !Array.isArray(value.writes) || !value.writes.every(isValidSettlementWrite)) {
    return false;
  }
  const receipt = value as unknown as ArtifactSettlementReceipt;
  if (
    !isValidArtifactSettlementPlan(plan)
    || plan.state !== 'ready'
    || receipt.schemaVersion !== 1
    || typeof receipt.receiptId !== 'string'
    || typeof receipt.planId !== 'string'
    || receipt.planId !== plan.planId
    || !['completed', 'failed', 'unknown'].includes(receipt.status)
    || typeof receipt.completedAt !== 'string'
    || !Number.isFinite(Date.parse(receipt.completedAt))
  ) return false;
  try {
    const rebuilt = createArtifactSettlementReceipt(plan, {
      status: receipt.status,
      writes: receipt.writes,
    }, receipt.completedAt);
    return rebuilt.receiptId === receipt.receiptId
      && rebuilt.status === receipt.status
      && JSON.stringify(rebuilt.writes) === JSON.stringify(receipt.writes);
  } catch {
    return false;
  }
}
