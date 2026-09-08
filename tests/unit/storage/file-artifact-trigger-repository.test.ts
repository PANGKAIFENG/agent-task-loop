import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactTriggerConflictError,
  startArtifactTrigger,
  type StartArtifactTriggerInput,
} from '../../../src/services/start-artifact-trigger.js';
import {
  ArtifactTriggerRepositoryError,
  FileArtifactTriggerRepository,
} from '../../../src/storage/file-artifact-trigger-repository.js';

const roots: string[] = [];

const input: StartArtifactTriggerInput = {
  idempotencyKey: 'artifact-trigger-synthetic-96-v1',
  executionTarget: 'local',
  taskId: 'task-synthetic-96',
  sourceRunId: 'run-synthetic-96-a',
  decisionId: 'decision-synthetic-96-a',
  artifactRef: 'Artifacts/task-synthetic-96/attempt-001.md',
  artifactVersion: 1,
  artifactSha256: 'a'.repeat(64),
};

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-artifact-trigger-'));
  roots.push(root);
  return join(root, '.atl-runtime');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileArtifactTriggerRepository', () => {
  it('recovers a durable starting receipt through a new repository instance', async () => {
    const seedRoot = await runtimeRoot();
    const execute = vi.fn(async () => ({ status: 'unknown' as const }));
    const first = await startArtifactTrigger({
      repository: new FileArtifactTriggerRepository(seedRoot),
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      execute,
    }, input);
    const root = await runtimeRoot();
    await new FileArtifactTriggerRepository(root).create({
      ...first.receipt,
      state: 'starting',
      updatedAt: first.receipt.createdAt,
    });

    const recovered = await startArtifactTrigger({
      repository: new FileArtifactTriggerRepository(root),
      clock: () => new Date('2026-09-01T07:01:00.000Z'),
      execute,
      recoverUnknown: async () => ({
        status: 'started',
        runId: 'run-synthetic-96-b',
      }),
    }, input);

    expect(recovered).toMatchObject({
      started: false,
      receipt: {
        state: 'started',
        continuationRunId: 'run-synthetic-96-b',
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serializes separate repository instances so only one continuation starts', async () => {
    const root = await runtimeRoot();
    const execute = vi.fn(async () => ({
      status: 'started' as const,
      runId: 'run-synthetic-96-b',
    }));
    const dependencies = (repository: FileArtifactTriggerRepository) => ({
      repository,
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      execute,
    });

    const [left, right] = await Promise.all([
      startArtifactTrigger(dependencies(new FileArtifactTriggerRepository(root)), input),
      startArtifactTrigger(dependencies(new FileArtifactTriggerRepository(root)), input),
    ]);

    expect([left.started, right.started].sort()).toEqual([false, true]);
    expect(left.receipt).toEqual(right.receipt);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the persisted receipt is malformed or conflicts', async () => {
    const root = await runtimeRoot();
    const repository = new FileArtifactTriggerRepository(root);
    await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    const [filename] = await readdir(join(root, 'artifact-triggers'));
    if (filename === undefined) throw new Error('Synthetic Trigger receipt was not persisted');
    const path = join(root, 'artifact-triggers', filename);
    await writeFile(path, '{"state":"started"}\n', 'utf8');

    await expect(repository.get(input.idempotencyKey))
      .rejects.toBeInstanceOf(ArtifactTriggerRepositoryError);
    await expect(startArtifactTrigger({
      repository,
      clock: () => new Date('2026-09-01T07:01:00.000Z'),
      execute: vi.fn(),
    }, input)).rejects.toBeInstanceOf(ArtifactTriggerRepositoryError);

    const otherRoot = await runtimeRoot();
    const otherRepository = new FileArtifactTriggerRepository(otherRoot);
    const created = await startArtifactTrigger({
      repository: otherRepository,
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    await expect(otherRepository.save({
      ...created.receipt,
      artifactSha256: 'b'.repeat(64),
    })).rejects.toBeInstanceOf(ArtifactTriggerConflictError);
  });

  it('rejects unknown persisted fields', async () => {
    const root = await runtimeRoot();
    const repository = new FileArtifactTriggerRepository(root);
    const created = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-09-01T07:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    const [filename] = await readdir(join(root, 'artifact-triggers'));
    if (filename === undefined) throw new Error('Synthetic Trigger receipt was not persisted');
    const path = join(root, 'artifact-triggers', filename);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...persisted, extra: true }, null, 2)}\n`, 'utf8');

    await expect(repository.get(created.receipt.idempotencyKey))
      .rejects.toBeInstanceOf(ArtifactTriggerRepositoryError);
  });
});
