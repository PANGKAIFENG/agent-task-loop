import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactSettlementReceipt,
  createArtifactSettlementPlan,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
} from '../../../src/domain/artifact-settlement.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';
import { AuthorizedVaultArtifactSettlementWriter } from '../../../src/storage/authorized-vault-artifact-settlement-writer.js';
import { FileArtifactSettlementRepository } from '../../../src/storage/file-artifact-settlement-repository.js';

const roots: string[] = [];
const ARTIFACT_REF = 'Artifacts/task-synthetic-96/attempt-001.md';
const DECISION_ID = 'decision-synthetic-96-a';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function authorizationFor(
  plan: ArtifactSettlementPlan,
  vaultRoot: string,
): ArtifactSettlementAuthorizationEvidence {
  return {
    schemaVersion: 1,
    authorizationId: `authorization-${plan.planId}`,
    planId: plan.planId,
    artifactRef: plan.artifact.ref,
    artifactSha256: plan.artifact.sha256,
    decisionId: plan.decisionId,
    logicalDestination: 'project_knowledge',
    vaultRoot,
    targetRef: plan.targetRef!,
    requiredPermission: plan.requiredPermission!,
    authorizedAt: '2026-09-01T08:00:30.000Z',
    readBackReceipt: `synthetic-readback://${plan.planId}`,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-authorized-settlement-'));
  roots.push(root);
  const artifactContent = [
    '---',
    'type: artifact',
    'schema_version: 1',
    'task_id: task-synthetic-96',
    '---',
    '',
    '## Summary',
    '',
    'Synthetic source Artifact.',
    '',
  ].join('\n');
  const artifactPath = join(root, '10_Tasks', ARTIFACT_REF);
  await mkdir(join(root, '10_Tasks', 'Artifacts', 'task-synthetic-96'), {
    recursive: true,
  });
  await writeFile(artifactPath, artifactContent, 'utf8');
  const plan = createArtifactSettlementPlan({
    artifact: {
      taskId: 'task-synthetic-96',
      ref: ARTIFACT_REF,
      version: 1,
      sha256: sha256(artifactContent),
    },
    decisionId: DECISION_ID,
    requestedDestination: 'project_knowledge',
    targetRef: 'vault-file:///Projects/Synthetic/decision.md',
    authorizedDestinations: ['project_knowledge'],
    createdAt: '2026-09-01T08:00:00.000Z',
  });
  const authorization = authorizationFor(plan, root);
  return { root, artifactContent, plan, authorization };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('AuthorizedVaultArtifactSettlementWriter', () => {
  it('writes only the exact authorized target and verifies source SHA plus backlinks by readback', async () => {
    const { root, artifactContent, plan, authorization } = await fixture();
    const writer = new AuthorizedVaultArtifactSettlementWriter(root);

    const result = await writer.write(plan, authorization);

    expect(result).toEqual({
      status: 'completed',
      writes: [{
        targetRef: plan.targetRef,
        version: null,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        externalId: null,
        readback: 'verified',
        backlink: {
          artifactRef: plan.artifact.ref,
          artifactSha256: plan.artifact.sha256,
          decisionId: plan.decisionId,
        },
      }],
    });
    const settled = await readFile(
      join(root, 'Projects', 'Synthetic', 'decision.md'),
      'utf8',
    );
    expect(settled).toContain('type: artifact_settlement');
    expect(settled).toContain(`artifact_ref: ${plan.artifact.ref}`);
    expect(settled).toContain(`artifact_sha256: ${plan.artifact.sha256}`);
    expect(settled).toContain(`decision_id: ${plan.decisionId}`);
    expect(settled).toContain(artifactContent);
  });

  it('fails closed when authorization names a different canonical Vault root', async () => {
    const { root, plan, authorization } = await fixture();
    const otherRoot = await mkdtemp(join(tmpdir(), 'atl-other-vault-'));
    roots.push(otherRoot);
    const writer = new AuthorizedVaultArtifactSettlementWriter(root);

    await expect(writer.write(plan, {
      ...authorization,
      vaultRoot: otherRoot,
    })).resolves.toEqual({ status: 'failed', writes: [] });
    await expect(access(join(root, 'Projects', 'Synthetic', 'decision.md')))
      .rejects.toThrow();
  });

  it('fails closed before target creation when the source Artifact SHA has drifted', async () => {
    const { root, plan, authorization } = await fixture();
    await writeFile(
      join(root, '10_Tasks', ARTIFACT_REF),
      'tampered after settlement authorization\n',
      'utf8',
    );
    const writer = new AuthorizedVaultArtifactSettlementWriter(root);

    await expect(writer.write(plan, authorization))
      .resolves.toEqual({ status: 'failed', writes: [] });
    await expect(access(join(root, 'Projects', 'Synthetic', 'decision.md')))
      .rejects.toThrow();
  });

  it('does not overwrite an existing target with conflicting content', async () => {
    const { root, plan, authorization } = await fixture();
    const target = join(root, 'Projects', 'Synthetic', 'decision.md');
    await mkdir(join(root, 'Projects', 'Synthetic'), { recursive: true });
    await writeFile(target, 'existing human-owned content\n', 'utf8');
    const writer = new AuthorizedVaultArtifactSettlementWriter(root);

    await expect(writer.write(plan, authorization))
      .resolves.toEqual({ status: 'failed', writes: [] });
    await expect(readFile(target, 'utf8')).resolves.toBe('existing human-owned content\n');
  });

  it('recovers an unknown receipt by readback without changing the target', async () => {
    const { root, plan, authorization } = await fixture();
    const writer = new AuthorizedVaultArtifactSettlementWriter(root);
    await writer.write(plan, authorization);
    const target = join(root, 'Projects', 'Synthetic', 'decision.md');
    const before = await stat(target);
    const beforeContent = await readFile(target, 'utf8');
    const intent = createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    );

    const recovered = await writer.recoverUnknown(plan, intent, authorization);

    expect(recovered).toMatchObject({
      status: 'completed',
      writes: [{
        targetRef: plan.targetRef,
        readback: 'verified',
        backlink: {
          artifactRef: plan.artifact.ref,
          artifactSha256: plan.artifact.sha256,
          decisionId: plan.decisionId,
        },
      }],
    });
    expect(await readFile(target, 'utf8')).toBe(beforeContent);
    expect((await stat(target)).ino).toBe(before.ino);
  });

  it('recovers an unknown receipt by creating the target when the writer never started', async () => {
    const { root, plan, authorization } = await fixture();
    const intent = createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    );

    const recovered = await new AuthorizedVaultArtifactSettlementWriter(root)
      .recoverUnknown(plan, intent, authorization);

    expect(recovered).toMatchObject({
      status: 'completed',
      writes: [{
        targetRef: plan.targetRef,
        readback: 'verified',
        backlink: {
          artifactRef: plan.artifact.ref,
          artifactSha256: plan.artifact.sha256,
          decisionId: plan.decisionId,
        },
      }],
    });
    await expect(readFile(
      join(root, 'Projects', 'Synthetic', 'decision.md'),
      'utf8',
    )).resolves.toContain('type: artifact_settlement');
  });

  it('recovers a persisted intent through new repository and writer instances', async () => {
    const { root, plan, authorization } = await fixture();
    const runtimeRoot = join(root, '.atl-runtime');
    const initialRepository = new FileArtifactSettlementRepository(runtimeRoot);
    await initialRepository.createPlan(plan);
    await initialRepository.createAuthorization(authorization);
    await initialRepository.createReceipt(createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    ));

    const restartedWriter = new AuthorizedVaultArtifactSettlementWriter(root);
    const recovered = await executeArtifactSettlement(plan.planId, {
      repository: new FileArtifactSettlementRepository(runtimeRoot),
      writer: (currentPlan, currentAuthorization) => (
        restartedWriter.write(currentPlan, currentAuthorization)
      ),
      recoverUnknown: (currentPlan, receipt, currentAuthorization) => (
        restartedWriter.recoverUnknown(currentPlan, receipt, currentAuthorization)
      ),
      clock: () => new Date('2026-09-01T08:02:00.000Z'),
    });

    expect(recovered).toMatchObject({
      executed: false,
      receipt: { status: 'completed' },
    });
    await expect(new FileArtifactSettlementRepository(runtimeRoot).getReceipt(plan.planId))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(readFile(
      join(root, 'Projects', 'Synthetic', 'decision.md'),
      'utf8',
    )).resolves.toContain(`settlement_plan_id: ${plan.planId}`);
  });

  it('converges on one create-only target when two recovery attempts race', async () => {
    const { root, plan, authorization } = await fixture();
    const intent = createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    );

    const results = await Promise.all([
      new AuthorizedVaultArtifactSettlementWriter(root)
        .recoverUnknown(plan, intent, authorization),
      new AuthorizedVaultArtifactSettlementWriter(root)
        .recoverUnknown(plan, intent, authorization),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ]);
    await expect(readFile(
      join(root, 'Projects', 'Synthetic', 'decision.md'),
      'utf8',
    )).resolves.toContain(`settlement_plan_id: ${plan.planId}`);
  });

  it('fails recovery without replacing a conflicting target', async () => {
    const { root, plan, authorization } = await fixture();
    const target = join(root, 'Projects', 'Synthetic', 'decision.md');
    await mkdir(join(root, 'Projects', 'Synthetic'), { recursive: true });
    await writeFile(target, 'existing human-owned content\n', 'utf8');
    const intent = createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    );

    await expect(new AuthorizedVaultArtifactSettlementWriter(root)
      .recoverUnknown(plan, intent, authorization))
      .resolves.toEqual({ status: 'failed', writes: [] });
    await expect(readFile(target, 'utf8')).resolves.toBe('existing human-owned content\n');
  });

  it('fails recovery when the target is an unreadable non-regular entry', async () => {
    const { root, plan, authorization } = await fixture();
    const targetDirectory = join(root, 'Projects', 'Synthetic');
    const target = join(targetDirectory, 'decision.md');
    await mkdir(targetDirectory, { recursive: true });
    await symlink(join(root, '10_Tasks', ARTIFACT_REF), target);
    const intent = createArtifactSettlementReceipt(
      plan,
      { status: 'unknown', writes: [] },
      '2026-09-01T08:01:00.000Z',
    );

    await expect(new AuthorizedVaultArtifactSettlementWriter(root)
      .recoverUnknown(plan, intent, authorization))
      .resolves.toEqual({ status: 'failed', writes: [] });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});
