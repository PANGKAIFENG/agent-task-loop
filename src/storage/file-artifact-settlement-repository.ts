import { dirname, join } from 'node:path';

import {
  isValidArtifactSettlementAuthorization,
  isValidArtifactSettlementPlan,
  isValidArtifactSettlementReceipt,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
  type ArtifactSettlementReceipt,
} from '../domain/artifact-settlement.js';
import type { ArtifactSettlementExecutionRepository } from '../services/execute-artifact-settlement.js';
import {
  acquireSafeFileLock,
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  reclaimExpiredSafeFileLock,
  type StorageReadBoundary,
} from './file-io.js';

const LOCK_LEASE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;
const PLAN_ID_PATTERN = /^sp_[0-9a-f]{24}$/u;

export class ArtifactSettlementRepositoryError extends Error {
  readonly code = 'artifact_settlement_repository_invalid';

  constructor() {
    super('Persisted Artifact settlement evidence is missing, malformed, or ambiguous');
    this.name = 'ArtifactSettlementRepositoryError';
  }
}

export class ArtifactSettlementRepositoryConflictError extends Error {
  readonly code = 'artifact_settlement_repository_conflict';

  constructor() {
    super('Artifact settlement evidence conflicts with an immutable record');
    this.name = 'ArtifactSettlementRepositoryConflictError';
  }
}

export class ArtifactSettlementRepositoryLockTimeoutError extends Error {
  readonly code = 'artifact_settlement_repository_lock_timeout';

  constructor() {
    super('Artifact settlement repository lock timed out');
    this.name = 'ArtifactSettlementRepositoryLockTimeoutError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundary(runtimeRoot: string, directoryName: string): StorageReadBoundary {
  return {
    vaultRoot: dirname(runtimeRoot),
    tasksRoot: runtimeRoot,
    subtree: join(runtimeRoot, directoryName),
  };
}

function content(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parsePlan(raw: string): ArtifactSettlementPlan {
  try {
    const plan = JSON.parse(raw) as ArtifactSettlementPlan;
    if (!isValidArtifactSettlementPlan(plan)) throw new ArtifactSettlementRepositoryError();
    return plan;
  } catch (error) {
    if (error instanceof ArtifactSettlementRepositoryError) throw error;
    throw new ArtifactSettlementRepositoryError();
  }
}

function parseAuthorization(
  raw: string,
  plan: ArtifactSettlementPlan,
): ArtifactSettlementAuthorizationEvidence {
  try {
    const authorization = JSON.parse(raw) as ArtifactSettlementAuthorizationEvidence;
    if (!isValidArtifactSettlementAuthorization(authorization, plan)) {
      throw new ArtifactSettlementRepositoryError();
    }
    return authorization;
  } catch (error) {
    if (error instanceof ArtifactSettlementRepositoryError) throw error;
    throw new ArtifactSettlementRepositoryError();
  }
}

function parseReceipt(
  raw: string,
  plan: ArtifactSettlementPlan,
): ArtifactSettlementReceipt {
  try {
    const receipt = JSON.parse(raw) as ArtifactSettlementReceipt;
    if (!isValidArtifactSettlementReceipt(receipt, plan)) {
      throw new ArtifactSettlementRepositoryError();
    }
    return receipt;
  } catch (error) {
    if (error instanceof ArtifactSettlementRepositoryError) throw error;
    throw new ArtifactSettlementRepositoryError();
  }
}

export class FileArtifactSettlementRepository
implements ArtifactSettlementExecutionRepository {
  constructor(private readonly runtimeRoot: string) {}

  async withLock<T>(planId: string, operation: () => Promise<T>): Promise<T> {
    this.assertPlanId(planId);
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-locks');
    const lockPath = join(storage.subtree, `${planId}.lock`);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const now = new Date();
      let lock = await acquireSafeFileLock(lockPath, storage, {
        acquiredAt: now,
        leaseMs: LOCK_LEASE_MS,
      });
      if (lock === null && await reclaimExpiredSafeFileLock(lockPath, storage, now)) {
        lock = await acquireSafeFileLock(lockPath, storage, {
          acquiredAt: now,
          leaseMs: LOCK_LEASE_MS,
        });
      }
      if (lock !== null) {
        try {
          return await operation();
        } finally {
          await lock.release();
        }
      }
      if (attempt + 1 < LOCK_ATTEMPTS) await delay(LOCK_RETRY_MS);
    }
    throw new ArtifactSettlementRepositoryLockTimeoutError();
  }

  async createPlan(plan: ArtifactSettlementPlan): Promise<void> {
    if (!isValidArtifactSettlementPlan(plan)) {
      throw new ArtifactSettlementRepositoryConflictError();
    }
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-plans');
    await this.createExact(join(storage.subtree, `${plan.planId}.json`), content(plan), storage);
  }

  async createAuthorization(
    authorization: ArtifactSettlementAuthorizationEvidence,
  ): Promise<void> {
    const plan = await this.getPlan(authorization.planId);
    if (
      plan === null
      || !isValidArtifactSettlementAuthorization(authorization, plan)
    ) {
      throw new ArtifactSettlementRepositoryConflictError();
    }
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-authorizations');
    await this.createExact(
      join(storage.subtree, `${authorization.planId}.json`),
      content(authorization),
      storage,
    );
  }

  async getPlan(planId: string): Promise<ArtifactSettlementPlan | null> {
    this.assertPlanId(planId);
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-plans');
    const raw = await readSafeTextFile(join(storage.subtree, `${planId}.json`), storage);
    if (raw === null) return null;
    const plan = parsePlan(raw);
    if (plan.planId !== planId) throw new ArtifactSettlementRepositoryError();
    return plan;
  }

  async getAuthorization(
    planId: string,
  ): Promise<ArtifactSettlementAuthorizationEvidence | null> {
    const plan = await this.getPlan(planId);
    if (plan === null) return null;
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-authorizations');
    const raw = await readSafeTextFile(join(storage.subtree, `${planId}.json`), storage);
    return raw === null ? null : parseAuthorization(raw, plan);
  }

  async createReceipt(receipt: ArtifactSettlementReceipt): Promise<void> {
    const plan = await this.getPlan(receipt.planId);
    if (plan === null || !isValidArtifactSettlementReceipt(receipt, plan)) {
      throw new ArtifactSettlementRepositoryConflictError();
    }
    const existing = await this.getReceipt(receipt.planId);
    if (existing !== null) {
      if (existing.receiptId === receipt.receiptId) return;
      if (existing.status !== 'unknown' || receipt.status === 'unknown') {
        throw new ArtifactSettlementRepositoryConflictError();
      }
      if (Date.parse(receipt.completedAt) < Date.parse(existing.completedAt)) {
        throw new ArtifactSettlementRepositoryConflictError();
      }
    }
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-receipts');
    const path = join(storage.subtree, `${receipt.planId}--${receipt.receiptId}.json`);
    await this.createExact(path, content(receipt), storage);
  }

  async getReceipt(planId: string): Promise<ArtifactSettlementReceipt | null> {
    const plan = await this.getPlan(planId);
    if (plan === null) return null;
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-receipts');
    const receipts: ArtifactSettlementReceipt[] = [];
    for (const path of await listSafeRegularFiles(storage, `${planId}--*.json`)) {
      const raw = await readSafeTextFile(path, storage);
      if (raw === null) throw new ArtifactSettlementRepositoryError();
      const receipt = parseReceipt(raw, plan);
      if (receipt.planId !== planId) throw new ArtifactSettlementRepositoryError();
      receipts.push(receipt);
    }
    const terminal = receipts.filter(({ status }) => status !== 'unknown');
    const unknown = receipts.filter(({ status }) => status === 'unknown');
    if (terminal.length > 1 || unknown.length > 1) {
      throw new ArtifactSettlementRepositoryError();
    }
    return terminal[0] ?? unknown[0] ?? null;
  }

  async findPlanByDecisionArtifact(
    decisionId: string,
    artifactRef: string,
  ): Promise<ArtifactSettlementPlan | null> {
    const storage = boundary(this.runtimeRoot, 'artifact-settlement-plans');
    const matches: ArtifactSettlementPlan[] = [];
    for (const path of await listSafeRegularFiles(storage, '*.json')) {
      const raw = await readSafeTextFile(path, storage);
      if (raw === null) throw new ArtifactSettlementRepositoryError();
      const plan = parsePlan(raw);
      if (plan.decisionId === decisionId && plan.artifact.ref === artifactRef) {
        matches.push(plan);
      }
    }
    if (matches.length > 1) throw new ArtifactSettlementRepositoryError();
    return matches[0] ?? null;
  }

  private async createExact(
    path: string,
    expectedContent: string,
    storage: StorageReadBoundary,
  ): Promise<void> {
    if (await atomicCreateTextFile(path, expectedContent, storage)) return;
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new ArtifactSettlementRepositoryError();
    if (raw !== expectedContent) throw new ArtifactSettlementRepositoryConflictError();
  }

  private assertPlanId(planId: string): void {
    if (!PLAN_ID_PATTERN.test(planId)) throw new ArtifactSettlementRepositoryError();
  }
}
