import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  createRemoteArtifactReceipt,
  isValidRemoteArtifactReceipt,
  remoteArtifactIdentity,
  remoteArtifactIdentityMatches,
  type CreateRemoteArtifactReceiptInput,
  type RemoteArtifactReceipt,
} from '../domain/remote-artifact.js';
import { FileExecutionBindingRepository } from './file-execution-binding-repository.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';

export class RemoteArtifactConflictError extends Error {
  readonly code = 'remote_artifact_conflict';

  constructor() {
    super('Remote Artifact conflicts with persisted evidence');
    this.name = 'RemoteArtifactConflictError';
  }
}

export class RemoteArtifactRepositoryError extends Error {
  readonly code = 'remote_artifact_repository_invalid';

  constructor() {
    super('Persisted Remote Artifact is missing, malformed, or ambiguous');
    this.name = 'RemoteArtifactRepositoryError';
  }
}

function boundary(runtimeRoot: string): StorageReadBoundary {
  const directory = join(runtimeRoot, 'remote-artifacts');
  return {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
}

function storageKey(taskId: string, executionBindingReceiptId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ taskId, executionBindingReceiptId }))
    .digest('hex');
  return `ra_${digest.slice(0, 24)}`;
}

function parse(raw: string): RemoteArtifactReceipt {
  try {
    const receipt = JSON.parse(raw) as RemoteArtifactReceipt;
    if (!isValidRemoteArtifactReceipt(receipt)) throw new RemoteArtifactRepositoryError();
    return receipt;
  } catch (error) {
    if (error instanceof RemoteArtifactRepositoryError) throw error;
    throw new RemoteArtifactRepositoryError();
  }
}

export class FileRemoteArtifactRepository {
  constructor(private readonly runtimeRoot: string) {}

  async createOrGet(
    input: CreateRemoteArtifactReceiptInput,
  ): Promise<{ receipt: RemoteArtifactReceipt; created: boolean }> {
    const receipt = createRemoteArtifactReceipt(input);
    const storage = boundary(this.runtimeRoot);
    const path = join(
      storage.subtree,
      `${storageKey(input.taskId, input.executionBindingReceiptId)}.json`,
    );
    const created = await atomicCreateTextFile(
      path,
      `${JSON.stringify(receipt, null, 2)}\n`,
      storage,
    );
    if (created) return { receipt, created: true };
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new RemoteArtifactRepositoryError();
    const existing = parse(raw);
    if (!remoteArtifactIdentityMatches(existing, receipt)) {
      throw new RemoteArtifactConflictError();
    }
    return { receipt: existing, created: false };
  }

  async get(receiptId: string): Promise<RemoteArtifactReceipt | null> {
    if (!/^rar_[0-9a-f]{24}$/u.test(receiptId)) throw new RemoteArtifactRepositoryError();
    const storage = boundary(this.runtimeRoot);
    const files = await listSafeRegularFiles(storage, '*.json');
    const matches: RemoteArtifactReceipt[] = [];
    for (const path of files) {
      const raw = await readSafeTextFile(path, storage);
      if (raw === null) throw new RemoteArtifactRepositoryError();
      const receipt = parse(raw);
      if (receipt.receiptId === receiptId) matches.push(receipt);
    }
    if (matches.length > 1) throw new RemoteArtifactRepositoryError();
    return matches[0] ?? null;
  }

  async readProductionEvidence(ref: string): Promise<{
    identity: ReturnType<typeof remoteArtifactIdentity>;
    runId: string;
    executionBindingReceiptId: string;
    manifestId: string;
    manifestSha256: string;
    issueId: string;
  }> {
    const match = /^remote-artifact:\/\/(rar_[0-9a-f]{24})$/u.exec(ref);
    if (match?.[1] === undefined) throw new RemoteArtifactRepositoryError();
    const receipt = await this.get(match[1]);
    if (receipt === null) throw new RemoteArtifactRepositoryError();
    const binding = await new FileExecutionBindingRepository(this.runtimeRoot)
      .get(receipt.executionBindingReceiptId);
    if (
      binding === null
      || binding.receiptId !== receipt.executionBindingReceiptId
      || binding.taskId !== receipt.taskId
      || binding.workspaceId !== receipt.workspaceId
      || binding.projectId !== receipt.projectId
      || binding.issueId !== receipt.issueId
      || binding.issueIdentifier !== receipt.issueIdentifier
      || binding.run.runId !== receipt.run.runId
      || binding.run.agentId !== receipt.run.agentId
      || binding.run.runtimeId !== receipt.run.runtimeId
      || binding.agent.agentId !== receipt.run.agentId
      || binding.agent.runtimeId !== receipt.run.runtimeId
    ) throw new RemoteArtifactRepositoryError();
    return {
      identity: remoteArtifactIdentity(receipt),
      runId: receipt.run.runId,
      executionBindingReceiptId: binding.receiptId,
      manifestId: binding.manifestId,
      manifestSha256: binding.manifestSha256,
      issueId: binding.issueId,
    };
  }
}
