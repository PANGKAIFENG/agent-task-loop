import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  createExecutionBindingReceipt,
  executionBindingIdentityMatches,
  isValidExecutionBindingReceipt,
  type CreateExecutionBindingReceiptInput,
  type ExecutionBindingReceipt,
} from '../domain/execution-binding.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';

export class ExecutionBindingConflictError extends Error {
  readonly code = 'execution_binding_conflict';

  constructor() {
    super('Execution binding attempt conflicts with persisted evidence');
    this.name = 'ExecutionBindingConflictError';
  }
}

export class ExecutionBindingRepositoryError extends Error {
  readonly code = 'execution_binding_repository_invalid';

  constructor() {
    super('Persisted execution binding is missing, malformed, or ambiguous');
    this.name = 'ExecutionBindingRepositoryError';
  }
}

function boundary(runtimeRoot: string): StorageReadBoundary {
  const directory = join(runtimeRoot, 'execution-bindings');
  return {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
}

function storageKey(taskId: string, dispatchAttemptId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ taskId, dispatchAttemptId }))
    .digest('hex');
  return `eb_${digest.slice(0, 24)}`;
}

function parse(raw: string): ExecutionBindingReceipt {
  try {
    const receipt = JSON.parse(raw) as ExecutionBindingReceipt;
    if (!isValidExecutionBindingReceipt(receipt)) {
      throw new ExecutionBindingRepositoryError();
    }
    return receipt;
  } catch (error) {
    if (error instanceof ExecutionBindingRepositoryError) throw error;
    throw new ExecutionBindingRepositoryError();
  }
}

export class FileExecutionBindingRepository {
  constructor(private readonly runtimeRoot: string) {}

  async createOrGet(
    input: CreateExecutionBindingReceiptInput,
  ): Promise<{ receipt: ExecutionBindingReceipt; created: boolean }> {
    const receipt = createExecutionBindingReceipt(input);
    const storage = boundary(this.runtimeRoot);
    const path = join(
      storage.subtree,
      `${storageKey(input.taskId, input.dispatchAttemptId)}.json`,
    );
    const content = `${JSON.stringify(receipt, null, 2)}\n`;
    const created = await atomicCreateTextFile(path, content, storage);
    if (created) return { receipt, created: true };
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new ExecutionBindingRepositoryError();
    const existing = parse(raw);
    if (!executionBindingIdentityMatches(existing, receipt)) {
      throw new ExecutionBindingConflictError();
    }
    return { receipt: existing, created: false };
  }

  async get(receiptId: string): Promise<ExecutionBindingReceipt | null> {
    if (!/^ebr_[0-9a-f]{24}$/u.test(receiptId)) {
      throw new ExecutionBindingRepositoryError();
    }
    const storage = boundary(this.runtimeRoot);
    const files = await listSafeRegularFiles(storage, '*.json');
    const matches: ExecutionBindingReceipt[] = [];
    for (const path of files) {
      const raw = await readSafeTextFile(path, storage);
      if (raw === null) throw new ExecutionBindingRepositoryError();
      const receipt = parse(raw);
      if (receipt.receiptId === receiptId) matches.push(receipt);
    }
    if (matches.length > 1) throw new ExecutionBindingRepositoryError();
    return matches[0] ?? null;
  }

  async getByAttempt(
    taskId: string,
    dispatchAttemptId: string,
  ): Promise<ExecutionBindingReceipt | null> {
    const storage = boundary(this.runtimeRoot);
    const path = join(
      storage.subtree,
      `${storageKey(taskId, dispatchAttemptId)}.json`,
    );
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) return null;
    const receipt = parse(raw);
    if (
      receipt.taskId !== taskId
      || receipt.dispatchAttemptId !== dispatchAttemptId
    ) {
      throw new ExecutionBindingRepositoryError();
    }
    return receipt;
  }
}
