import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifactSettlementPlan,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
} from '../../../src/domain/artifact-settlement.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';
import {
  ArtifactSettlementRepositoryError,
  FileArtifactSettlementRepository,
} from '../../../src/storage/file-artifact-settlement-repository.js';

const roots: string[] = [];

function plan(): ArtifactSettlementPlan {
  return createArtifactSettlementPlan({
    artifact: {
      taskId: 'task-synthetic-96',
      ref: 'Artifacts/task-synthetic-96/attempt-001.md',
      version: 1,
      sha256: 'a'.repeat(64),
    },
    decisionId: 'decision-synthetic-96-a',
    requestedDestination: 'project_knowledge',
    targetRef: 'vault-file:///Projects/Synthetic/decision.md',
    authorizedDestinations: ['project_knowledge'],
    createdAt: '2026-09-01T08:00:00.000Z',
  });
}

function authorization(
  settlementPlan: ArtifactSettlementPlan,
  vaultRoot: string,
): ArtifactSettlementAuthorizationEvidence {
  return {
    schemaVersion: 1,
    authorizationId: `authorization-${settlementPlan.planId}`,
    planId: settlementPlan.planId,
    artifactRef: settlementPlan.artifact.ref,
    artifactSha256: settlementPlan.artifact.sha256,
    decisionId: settlementPlan.decisionId,
    logicalDestination: 'project_knowledge',
    vaultRoot,
    targetRef: settlementPlan.targetRef!,
    requiredPermission: settlementPlan.requiredPermission!,
    authorizedAt: '2026-09-01T08:00:30.000Z',
    readBackReceipt: `synthetic-readback://${settlementPlan.planId}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-artifact-settlement-'));
  roots.push(root);
  const runtimeRoot = join(root, '.atl-runtime');
  const repository = new FileArtifactSettlementRepository(runtimeRoot);
  const settlementPlan = plan();
  const settlementAuthorization = authorization(settlementPlan, root);
  await repository.createPlan(settlementPlan);
  await repository.createAuthorization(settlementAuthorization);
  return { root, runtimeRoot, repository, settlementPlan };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileArtifactSettlementRepository', () => {
  it('persists the receipt and does not write again when another process replays', async () => {
    const { runtimeRoot, repository, settlementPlan } = await fixture();
    const writer = vi.fn(async () => ({
      status: 'completed' as const,
      writes: [{
        targetRef: settlementPlan.targetRef!,
        version: null,
        sha256: 'b'.repeat(64),
        externalId: null,
        readback: 'verified' as const,
        backlink: {
          artifactRef: settlementPlan.artifact.ref,
          artifactSha256: settlementPlan.artifact.sha256,
          decisionId: settlementPlan.decisionId,
        },
      }],
    }));

    const first = await executeArtifactSettlement(settlementPlan.planId, {
      repository,
      writer,
      clock: () => new Date('2026-09-01T08:01:00.000Z'),
    });
    const replay = await executeArtifactSettlement(settlementPlan.planId, {
      repository: new FileArtifactSettlementRepository(runtimeRoot),
      writer,
      clock: () => new Date('2026-09-01T08:02:00.000Z'),
    });

    expect(first).toMatchObject({ executed: true, receipt: { status: 'completed' } });
    expect(replay).toEqual({
      plan: settlementPlan,
      executed: false,
      receipt: first.receipt,
    });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('recovers an unknown write through readback without invoking the writer again', async () => {
    const { runtimeRoot, repository, settlementPlan } = await fixture();
    const writer = vi.fn(async () => ({ status: 'unknown' as const, writes: [] }));
    const first = await executeArtifactSettlement(settlementPlan.planId, {
      repository,
      writer,
      clock: () => new Date('2026-09-01T08:01:00.000Z'),
    });
    const recoverUnknown = vi.fn(async () => ({
      status: 'completed' as const,
      writes: [{
        targetRef: settlementPlan.targetRef!,
        version: null,
        sha256: 'b'.repeat(64),
        externalId: null,
        readback: 'verified' as const,
        backlink: {
          artifactRef: settlementPlan.artifact.ref,
          artifactSha256: settlementPlan.artifact.sha256,
          decisionId: settlementPlan.decisionId,
        },
      }],
    }));
    const recovered = await executeArtifactSettlement(settlementPlan.planId, {
      repository: new FileArtifactSettlementRepository(runtimeRoot),
      writer,
      recoverUnknown,
      clock: () => new Date('2026-09-01T08:02:00.000Z'),
    });

    expect(first.receipt?.status).toBe('unknown');
    expect(recovered).toMatchObject({
      executed: false,
      receipt: { status: 'completed' },
    });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(recoverUnknown).toHaveBeenCalledTimes(1);
  });

  it('fails closed when persisted settlement evidence is malformed', async () => {
    const { runtimeRoot, repository, settlementPlan } = await fixture();
    await writeFile(
      join(runtimeRoot, 'artifact-settlement-plans', `${settlementPlan.planId}.json`),
      '{"schemaVersion":1}\n',
      'utf8',
    );

    await expect(repository.getPlan(settlementPlan.planId))
      .rejects.toBeInstanceOf(ArtifactSettlementRepositoryError);
  });

  it('rejects unknown fields in plans, authorizations, receipts, writes, and backlinks', async () => {
    const mutations = [
      ['artifact-settlement-plans', 'plan', (value: Record<string, unknown>) => {
        (value.artifact as Record<string, unknown>).extra = true;
      }],
      ['artifact-settlement-authorizations', 'authorization', (value: Record<string, unknown>) => {
        value.extra = true;
      }],
      ['artifact-settlement-receipts', 'receipt', (value: Record<string, unknown>) => {
        const writes = value.writes as Array<Record<string, unknown>>;
        (writes[0]!.backlink as Record<string, unknown>).extra = true;
      }],
    ] as const;

    for (const [directory, kind, mutate] of mutations) {
      const { runtimeRoot, repository, settlementPlan } = await fixture();
      if (kind === 'receipt') {
        await executeArtifactSettlement(settlementPlan.planId, {
          repository,
          writer: async () => ({
            status: 'completed',
            writes: [{
              targetRef: settlementPlan.targetRef!,
              version: null,
              sha256: 'b'.repeat(64),
              externalId: null,
              readback: 'verified',
              backlink: {
                artifactRef: settlementPlan.artifact.ref,
                artifactSha256: settlementPlan.artifact.sha256,
                decisionId: settlementPlan.decisionId,
              },
            }],
          }),
          clock: () => new Date('2026-09-01T08:01:00.000Z'),
        });
      }
      const directoryPath = join(runtimeRoot, directory);
      const { readdir } = await import('node:fs/promises');
      const [filename] = await readdir(directoryPath);
      if (filename === undefined) throw new Error(`Synthetic ${kind} was not persisted`);
      const path = join(directoryPath, filename);
      const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      mutate(persisted);
      await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

      const read = kind === 'plan'
        ? repository.getPlan(settlementPlan.planId)
        : kind === 'authorization'
          ? repository.getAuthorization(settlementPlan.planId)
          : repository.getReceipt(settlementPlan.planId);
      await expect(read).rejects.toBeInstanceOf(ArtifactSettlementRepositoryError);
    }
  });
});
