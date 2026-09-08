import { createHash } from 'node:crypto';

export type ArtifactTriggerState = 'starting' | 'started' | 'unknown';

export interface ArtifactTriggerReceipt {
  receiptId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  executionTarget: 'local' | 'multica';
  taskId: string;
  sourceRunId: string;
  decisionId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
  state: ArtifactTriggerState;
  continuationRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactTriggerRepository {
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
  get(idempotencyKey: string): Promise<ArtifactTriggerReceipt | null>;
  create(receipt: ArtifactTriggerReceipt): Promise<void>;
  save(receipt: ArtifactTriggerReceipt): Promise<void>;
}

export interface StartArtifactTriggerInput {
  idempotencyKey: string;
  executionTarget: 'local' | 'multica';
  taskId: string;
  sourceRunId: string;
  decisionId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
}

export type ArtifactTriggerExecutionResult =
  | { status: 'started'; runId: string }
  | { status: 'unknown' };

export type ArtifactTriggerRecoveryResult = ArtifactTriggerExecutionResult
  | { status: 'not_found' };

export interface StartArtifactTriggerDependencies {
  repository: ArtifactTriggerRepository;
  clock: () => Date;
  execute: () => Promise<ArtifactTriggerExecutionResult>;
  recoverUnknown?: (
    receipt: ArtifactTriggerReceipt,
  ) => Promise<ArtifactTriggerRecoveryResult>;
}

export interface StartArtifactTriggerResult {
  receipt: ArtifactTriggerReceipt;
  started: boolean;
}

export class ArtifactTriggerInvalidInputError extends Error {
  readonly code = 'artifact_trigger_invalid_input';

  constructor() {
    super('Artifact Trigger input is invalid');
    this.name = 'ArtifactTriggerInvalidInputError';
  }
}

export class ArtifactTriggerConflictError extends Error {
  readonly code = 'artifact_trigger_conflict';

  constructor() {
    super('Artifact Trigger idempotency key conflicts with another input');
    this.name = 'ArtifactTriggerConflictError';
  }
}

export class ArtifactTriggerRecoveryRequiredError extends Error {
  readonly code = 'artifact_trigger_recovery_required';
  readonly recoveryRequired = true;

  constructor() {
    super('Artifact Trigger result is unknown and must be recovered');
    this.name = 'ArtifactTriggerRecoveryRequiredError';
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

function fingerprint(input: StartArtifactTriggerInput): string {
  return createHash('sha256').update(JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    executionTarget: input.executionTarget,
    taskId: input.taskId,
    sourceRunId: input.sourceRunId,
    decisionId: input.decisionId,
    artifactRef: input.artifactRef,
    artifactVersion: input.artifactVersion,
    artifactSha256: input.artifactSha256,
  })).digest('hex');
}

export function isValidArtifactTriggerReceipt(
  value: unknown,
): value is ArtifactTriggerReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    'receiptId',
    'idempotencyKey',
    'inputFingerprint',
    'executionTarget',
    'taskId',
    'sourceRunId',
    'decisionId',
    'artifactRef',
    'artifactVersion',
    'artifactSha256',
    'state',
    'continuationRunId',
    'createdAt',
    'updatedAt',
  ])) return false;
  const receipt = value as unknown as ArtifactTriggerReceipt;
  const input: StartArtifactTriggerInput = {
    idempotencyKey: receipt.idempotencyKey,
    executionTarget: receipt.executionTarget,
    taskId: receipt.taskId,
    sourceRunId: receipt.sourceRunId,
    decisionId: receipt.decisionId,
    artifactRef: receipt.artifactRef,
    artifactVersion: receipt.artifactVersion,
    artifactSha256: receipt.artifactSha256,
  };
  const createdAt = Date.parse(receipt.createdAt);
  const updatedAt = Date.parse(receipt.updatedAt);
  try {
    validate(input, new Date(receipt.createdAt));
  } catch {
    return false;
  }
  return receipt.receiptId === `tr_${receipt.inputFingerprint.slice(0, 24)}`
    && receipt.inputFingerprint === fingerprint(input)
    && ['starting', 'started', 'unknown'].includes(receipt.state)
    && Number.isFinite(createdAt)
    && Number.isFinite(updatedAt)
    && updatedAt >= createdAt
    && (
      (receipt.state === 'started'
        && receipt.continuationRunId !== null
        && receipt.continuationRunId.trim() !== '')
      || (receipt.state !== 'started' && receipt.continuationRunId === null)
    );
}

function validate(input: StartArtifactTriggerInput, now: Date): void {
  if (
    !Number.isFinite(now.getTime())
    || !['local', 'multica'].includes(input.executionTarget)
    || input.idempotencyKey.trim() === ''
    || input.taskId.trim() === ''
    || input.sourceRunId.trim() === ''
    || input.decisionId.trim() === ''
    || input.artifactRef.trim() === ''
    || !Number.isSafeInteger(input.artifactVersion)
    || input.artifactVersion <= 0
    || !/^[0-9a-f]{64}$/u.test(input.artifactSha256)
  ) throw new ArtifactTriggerInvalidInputError();
}

async function executeAndRecord(
  deps: StartArtifactTriggerDependencies,
  receipt: ArtifactTriggerReceipt,
): Promise<StartArtifactTriggerResult> {
  try {
    const result = await deps.execute();
    const timestamp = deps.clock().toISOString();
    const started = result.status === 'started' && result.runId.trim() !== '';
    const updated: ArtifactTriggerReceipt = started
      ? {
          ...receipt,
          state: 'started',
          continuationRunId: result.status === 'started' ? result.runId : null,
          updatedAt: timestamp,
        }
      : { ...receipt, state: 'unknown', updatedAt: timestamp };
    await deps.repository.save(updated);
    return { receipt: updated, started };
  } catch {
    const unknown = {
      ...receipt,
      state: 'unknown' as const,
      updatedAt: deps.clock().toISOString(),
    };
    await deps.repository.save(unknown);
    throw new ArtifactTriggerRecoveryRequiredError();
  }
}

export async function startArtifactTrigger(
  deps: StartArtifactTriggerDependencies,
  input: StartArtifactTriggerInput,
): Promise<StartArtifactTriggerResult> {
  const now = deps.clock();
  validate(input, now);
  const inputFingerprint = fingerprint(input);
  return deps.repository.withLock(input.idempotencyKey, async () => {
    const existing = await deps.repository.get(input.idempotencyKey);
    if (existing !== null) {
      if (
        !isValidArtifactTriggerReceipt(existing)
        || existing.inputFingerprint !== inputFingerprint
      ) {
        throw new ArtifactTriggerConflictError();
      }
      if (existing.state === 'started') {
        return { receipt: existing, started: false };
      }
      if (deps.recoverUnknown === undefined) {
        if (existing.state === 'starting') {
          throw new ArtifactTriggerRecoveryRequiredError();
        }
        return { receipt: existing, started: false };
      }
      const recovered = await deps.recoverUnknown(existing);
      if (recovered.status === 'started' && recovered.runId.trim() !== '') {
        const receipt = {
          ...existing,
          state: 'started' as const,
          continuationRunId: recovered.runId,
          updatedAt: deps.clock().toISOString(),
        };
        await deps.repository.save(receipt);
        return { receipt, started: false };
      }
      if (
        recovered.status === 'unknown'
        || (recovered.status === 'started' && recovered.runId.trim() === '')
      ) {
        if (existing.state === 'unknown') {
          return { receipt: existing, started: false };
        }
        const receipt = {
          ...existing,
          state: 'unknown' as const,
          updatedAt: deps.clock().toISOString(),
        };
        await deps.repository.save(receipt);
        return { receipt, started: false };
      }
      return executeAndRecord(deps, existing);
    }

    const timestamp = now.toISOString();
    const receipt: ArtifactTriggerReceipt = {
      receiptId: `tr_${inputFingerprint.slice(0, 24)}`,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint,
      executionTarget: input.executionTarget,
      taskId: input.taskId,
      sourceRunId: input.sourceRunId,
      decisionId: input.decisionId,
      artifactRef: input.artifactRef,
      artifactVersion: input.artifactVersion,
      artifactSha256: input.artifactSha256,
      state: 'starting',
      continuationRunId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await deps.repository.create(receipt);
    return executeAndRecord(deps, receipt);
  });
}
