import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  remoteArtifactReceiptId,
  runOutputSource,
  type CreateRemoteArtifactReceiptInput,
  type RemoteArtifactReceipt,
} from '../../../src/domain/remote-artifact.js';
import {
  FileRemoteArtifactRepository,
  RemoteArtifactConflictError,
  RemoteArtifactRepositoryError,
} from '../../../src/storage/file-remote-artifact-repository.js';

const roots: string[] = [];

function input(
  output = 'Synthetic stable output.',
  overrides: Partial<CreateRemoteArtifactReceiptInput> = {},
): CreateRemoteArtifactReceiptInput {
  return {
    taskId: 'task-20260901-artifact01',
    executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
    workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
    projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
    issueIdentifier: 'TEP-999',
    run: {
      runId: '01a057ce-1767-7c10-a6c8-8c966cc66ea7',
      agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
      runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
      status: 'completed',
      createdAt: '2026-09-01T05:00:00.000Z',
      startedAt: '2026-09-01T05:00:00.000Z',
      completedAt: '2026-09-01T06:00:00.000Z',
    },
    sources: [runOutputSource('01a057ce-1767-7c10-a6c8-8c966cc66ea7', output)],
    createdAt: '2026-09-01T06:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileRemoteArtifactRepository', () => {
  it('recovers identical evidence without rewriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-remote-artifact-'));
    roots.push(root);
    const repository = new FileRemoteArtifactRepository(root);
    const created = await repository.createOrGet(input());
    const recovered = await repository.createOrGet(input('Synthetic stable output.', {
      createdAt: '2026-09-01T06:05:00.000Z',
    }));

    expect(recovered).toEqual({ receipt: created.receipt, created: false });
    await expect(repository.get(created.receipt.receiptId)).resolves.toEqual(created.receipt);
  });

  it('rejects changed content under the same bound Run source identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-remote-artifact-'));
    roots.push(root);
    const repository = new FileRemoteArtifactRepository(root);
    await repository.createOrGet(input());

    await expect(repository.createOrGet(input('Mutated output.')))
      .rejects.toBeInstanceOf(RemoteArtifactConflictError);
  });

  it('rejects unknown top-level and source fields from persisted evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-remote-artifact-'));
    roots.push(root);
    const repository = new FileRemoteArtifactRepository(root);
    await repository.createOrGet(input());
    const [filename] = await readdir(join(root, 'remote-artifacts'));
    if (filename === undefined) throw new Error('Synthetic receipt was not persisted');
    const path = join(root, 'remote-artifacts', filename);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const sources = persisted.sources as Array<Record<string, unknown>>;
    sources[0]!.untrusted = true;
    const tampered = { ...persisted, extra: 'ignored' } as unknown as RemoteArtifactReceipt;
    tampered.receiptId = remoteArtifactReceiptId(tampered);
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');

    await expect(repository.get(tampered.receiptId))
      .rejects.toBeInstanceOf(RemoteArtifactRepositoryError);
  });
});
