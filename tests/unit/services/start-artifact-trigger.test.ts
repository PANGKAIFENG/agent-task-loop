import { describe, expect, it, vi } from 'vitest';

import {
  ArtifactTriggerConflictError,
  ArtifactTriggerRecoveryRequiredError,
  startArtifactTrigger,
  type ArtifactTriggerReceipt,
  type ArtifactTriggerRepository,
} from '../../../src/services/start-artifact-trigger.js';

class MemoryTriggerRepository implements ArtifactTriggerRepository {
  records = new Map<string, ArtifactTriggerReceipt>();

  async withLock<T>(_key: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async get(idempotencyKey: string): Promise<ArtifactTriggerReceipt | null> {
    return this.records.get(idempotencyKey) ?? null;
  }

  async create(receipt: ArtifactTriggerReceipt): Promise<void> {
    this.records.set(receipt.idempotencyKey, receipt);
  }

  async save(receipt: ArtifactTriggerReceipt): Promise<void> {
    this.records.set(receipt.idempotencyKey, receipt);
  }
}

const input = {
  idempotencyKey: 'artifact-trigger-synthetic-96-v1',
  executionTarget: 'local' as const,
  taskId: 'task-synthetic-96',
  sourceRunId: 'run-synthetic-96-a',
  decisionId: 'decision-synthetic-96-a',
  artifactRef: 'Artifacts/task-synthetic-96/attempt-001.md',
  artifactVersion: 1,
  artifactSha256: 'a'.repeat(64),
};

describe('startArtifactTrigger', () => {
  it('returns the same receipt on replay and starts only one continuation Run', async () => {
    const repository = new MemoryTriggerRepository();
    const execute = vi.fn(async () => ({
      status: 'started' as const,
      runId: 'run-synthetic-96-b',
    }));

    const first = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute,
    }, input);
    const replay = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:01:00.000Z'),
      execute,
    }, input);

    expect(first.started).toBe(true);
    expect(replay.started).toBe(false);
    expect(replay.receipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      state: 'started',
      continuationRunId: 'run-synthetic-96-b',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records an execution with a blank continuation Run ID as unknown', async () => {
    const repository = new MemoryTriggerRepository();

    const result = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'started', runId: '   ' }),
    }, input);

    expect(result).toMatchObject({
      started: false,
      receipt: {
        state: 'unknown',
        continuationRunId: null,
      },
    });
    await expect(repository.get(input.idempotencyKey)).resolves.toMatchObject({
      state: 'unknown',
      continuationRunId: null,
    });
  });

  it('keeps an unknown result recoverable and queries it before any retry', async () => {
    const repository = new MemoryTriggerRepository();
    const execute = vi.fn(async () => ({ status: 'unknown' as const }));

    const first = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute,
    }, input);
    const unchanged = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:01:00.000Z'),
      execute,
    }, input);
    const recovered = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:02:00.000Z'),
      execute,
      recoverUnknown: async () => ({
        status: 'started',
        runId: 'run-synthetic-96-b',
      }),
    }, input);

    expect(first.receipt.state).toBe('unknown');
    expect(unchanged.receipt.state).toBe('unknown');
    expect(recovered.receipt).toMatchObject({
      state: 'started',
      continuationRunId: 'run-synthetic-96-b',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('requires recovery when a durable starting receipt is replayed after a crash', async () => {
    const repository = new MemoryTriggerRepository();
    const execute = vi.fn();
    const primed = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    await repository.save({
      ...primed.receipt,
      state: 'starting',
      continuationRunId: null,
      updatedAt: '2026-08-31T11:00:00.000Z',
    });

    await expect(startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:01:00.000Z'),
      execute,
    }, input)).rejects.toBeInstanceOf(ArtifactTriggerRecoveryRequiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('records an inconclusive recovery of starting as unknown', async () => {
    const repository = new MemoryTriggerRepository();
    const primed = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    await repository.save({
      ...primed.receipt,
      state: 'starting',
      updatedAt: '2026-08-31T11:00:00.000Z',
    });

    const recovered = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:01:00.000Z'),
      execute: vi.fn(),
      recoverUnknown: async () => ({ status: 'unknown' }),
    }, input);

    expect(recovered.receipt.state).toBe('unknown');
    await expect(repository.get(input.idempotencyKey)).resolves.toMatchObject({
      state: 'unknown',
    });
  });

  it('records a recovery with a blank continuation Run ID as unknown', async () => {
    const repository = new MemoryTriggerRepository();
    const primed = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' }),
    }, input);
    await repository.save({
      ...primed.receipt,
      state: 'starting',
      updatedAt: '2026-08-31T11:00:00.000Z',
    });

    const recovered = await startArtifactTrigger({
      repository,
      clock: () => new Date('2026-08-31T11:01:00.000Z'),
      execute: vi.fn(),
      recoverUnknown: async () => ({ status: 'started', runId: '\t' }),
    }, input);

    expect(recovered).toMatchObject({
      started: false,
      receipt: {
        state: 'unknown',
        continuationRunId: null,
      },
    });
    await expect(repository.get(input.idempotencyKey)).resolves.toMatchObject({
      state: 'unknown',
      continuationRunId: null,
    });
  });

  it('rejects a conflicting replay that reuses the key for another Artifact', async () => {
    const repository = new MemoryTriggerRepository();
    const deps = {
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' as const }),
    };
    await startArtifactTrigger(deps, input);

    await expect(startArtifactTrigger(deps, {
      ...input,
      artifactSha256: 'b'.repeat(64),
    })).rejects.toBeInstanceOf(ArtifactTriggerConflictError);
  });

  it('rejects a replay whose persisted Receipt fields were tampered', async () => {
    const repository = new MemoryTriggerRepository();
    const deps = {
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' as const }),
    };
    const first = await startArtifactTrigger(deps, input);
    await repository.save({
      ...first.receipt,
      taskId: 'task-tampered',
    });

    await expect(startArtifactTrigger(deps, input))
      .rejects.toBeInstanceOf(ArtifactTriggerConflictError);
  });

  it('rejects a replay whose persisted started Receipt has no continuation Run ID', async () => {
    const repository = new MemoryTriggerRepository();
    const deps = {
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'started' as const, runId: 'run-synthetic-96-b' }),
    };
    const first = await startArtifactTrigger(deps, input);
    await repository.save({
      ...first.receipt,
      continuationRunId: '   ',
    });

    await expect(startArtifactTrigger(deps, input))
      .rejects.toBeInstanceOf(ArtifactTriggerConflictError);
  });

  it('rejects a replay whose persisted Receipt has an impossible timestamp order', async () => {
    const repository = new MemoryTriggerRepository();
    const deps = {
      repository,
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute: async () => ({ status: 'unknown' as const }),
    };
    const first = await startArtifactTrigger(deps, input);
    await repository.save({
      ...first.receipt,
      updatedAt: '2026-08-31T10:59:00.000Z',
    });

    await expect(startArtifactTrigger(deps, input))
      .rejects.toBeInstanceOf(ArtifactTriggerConflictError);
  });

  it('persists the actual Multica Run returned by the execution boundary', async () => {
    const execute = vi.fn(async () => ({
      status: 'started' as const,
      runId: 'run-synthetic-96-remote',
    }));

    const result = await startArtifactTrigger({
      repository: new MemoryTriggerRepository(),
      clock: () => new Date('2026-08-31T11:00:00.000Z'),
      execute,
    }, {
      ...input,
      executionTarget: 'multica',
    });

    expect(result).toMatchObject({
      started: true,
      receipt: {
        executionTarget: 'multica',
        state: 'started',
        continuationRunId: 'run-synthetic-96-remote',
      },
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
