import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  executionBindingReceiptId,
  type CreateExecutionBindingReceiptInput,
  type ExecutionBindingReceipt,
} from '../../../src/domain/execution-binding.js';
import {
  ExecutionBindingConflictError,
  ExecutionBindingRepositoryError,
  FileExecutionBindingRepository,
} from '../../../src/storage/file-execution-binding-repository.js';

const roots: string[] = [];

function input(
  overrides: Partial<CreateExecutionBindingReceiptInput> = {},
): CreateExecutionBindingReceiptInput {
  return {
    taskId: 'task-20260901-binding01',
    taskContextVersion: '2026-09-01T05:00:00.000Z',
    taskContentSha256: 'e'.repeat(64),
    projectContextSha256: 'f'.repeat(64),
    vaultIdentity: `vault_${'d'.repeat(64)}`,
    dispatchAttemptId: 'dispatch_0123456789abcdef01234567',
    manifestId: 'cm_0123456789abcdef01234567',
    manifestSha256: 'a'.repeat(64),
    workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
    projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
    issueIdentifier: 'TEP-999',
    assigneeType: 'agent',
    agent: {
      agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      model: 'gpt-5.6-sol',
      maxConcurrentTasks: 10,
      runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
      status: 'idle',
    },
    run: {
      runId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
      agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
      status: 'in_progress',
      runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
    },
    createdAt: '2026-09-01T05:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileExecutionBindingRepository', () => {
  it('recovers the create-only receipt for an identical execution identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-execution-binding-'));
    roots.push(root);
    const repository = new FileExecutionBindingRepository(root);

    const created = await repository.createOrGet(input());
    const recovered = await repository.createOrGet(input({
      createdAt: '2026-09-01T05:01:00.000Z',
    }));

    expect(created.created).toBe(true);
    expect(recovered).toEqual({ receipt: created.receipt, created: false });
    await expect(repository.get(created.receipt.receiptId)).resolves.toEqual(created.receipt);
    await expect(repository.getByAttempt(
      created.receipt.taskId,
      created.receipt.dispatchAttemptId,
    )).resolves.toEqual(created.receipt);
  });

  it('fails closed when the same dispatch attempt points at another Work or Run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-execution-binding-'));
    roots.push(root);
    const repository = new FileExecutionBindingRepository(root);
    await repository.createOrGet(input());

    await expect(repository.createOrGet(input({
      issueId: '11111111-2222-4333-8444-555555555555',
      run: {
        ...input().run,
        runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    }))).rejects.toBeInstanceOf(ExecutionBindingConflictError);
  });

  it('rejects unknown top-level and nested fields from persisted evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-execution-binding-'));
    roots.push(root);
    const repository = new FileExecutionBindingRepository(root);
    await repository.createOrGet(input());
    const [filename] = await readdir(join(root, 'execution-bindings'));
    if (filename === undefined) throw new Error('Synthetic receipt was not persisted');
    const path = join(root, 'execution-bindings', filename);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const agent = persisted.agent as Record<string, unknown>;
    agent.untrusted = true;
    const tampered = { ...persisted, extra: 'ignored' } as unknown as ExecutionBindingReceipt;
    tampered.receiptId = executionBindingReceiptId(tampered);
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    await expect(repository.get(tampered.receiptId))
      .rejects.toBeInstanceOf(ExecutionBindingRepositoryError);
  });
});
