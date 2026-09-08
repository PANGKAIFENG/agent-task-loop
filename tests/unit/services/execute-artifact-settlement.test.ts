import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactSettlementPlan,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
  type SettlementWriteResult,
} from '../../../src/domain/artifact-settlement.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';

const artifact = {
  taskId: 'task-synthetic-96',
  ref: 'Artifacts/task-synthetic-96/attempt-001.md',
  version: 1,
  sha256: 'a'.repeat(64),
};

function authorizationFor(
  plan: ArtifactSettlementPlan,
): ArtifactSettlementAuthorizationEvidence {
  if (
    plan.logicalDestination === 'undecided'
    || plan.targetRef === null
    || plan.requiredPermission === null
  ) throw new Error('Synthetic plan is not authorizable');
  return {
    schemaVersion: 1,
    authorizationId: `authorization-${plan.planId}`,
    planId: plan.planId,
    artifactRef: plan.artifact.ref,
    artifactSha256: plan.artifact.sha256,
    decisionId: plan.decisionId,
    logicalDestination: plan.logicalDestination,
    vaultRoot: '/synthetic/vault',
    targetRef: plan.targetRef,
    requiredPermission: plan.requiredPermission,
    authorizedAt: '2026-08-31T12:00:30.000Z',
    readBackReceipt: `synthetic-readback://${plan.planId}`,
  };
}

async function execute(
  plan: ArtifactSettlementPlan,
  writer: (canonicalPlan: ArtifactSettlementPlan) => Promise<SettlementWriteResult>,
  authorization: ArtifactSettlementAuthorizationEvidence | null = null,
  clock?: () => Date,
) {
  return executeArtifactSettlement(plan.planId, {
    repository: {
      getPlan: async (planId) => planId === plan.planId ? plan : null,
      getAuthorization: async (planId) => (
        planId === plan.planId ? authorization : null
      ),
    },
    writer,
    ...(clock === undefined ? {} : { clock }),
  });
}

describe('Artifact settlement', () => {
  it('returns a decision plan and performs zero writes when destination is unknown', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: null,
      targetRef: null,
      authorizedDestinations: [],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const writer = vi.fn();

    const result = await execute(plan, writer);

    expect(plan.state).toBe('pending_decision');
    expect(result).toEqual({ plan, executed: false, receipt: null });
    expect(writer).not.toHaveBeenCalled();
  });

  it('performs zero writes when the destination has not been authorized', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: [],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const writer = vi.fn();

    const result = await execute(plan, writer);

    expect(plan).toMatchObject({
      state: 'pending_authorization',
      requiredPermission: 'settle:project_knowledge',
    });
    expect(result.executed).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it('performs zero writes when a caller mutates a pending plan to ready', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: [],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    plan.state = 'ready';
    const writer = vi.fn();

    const result = await execute(plan, writer);

    expect(result.executed).toBe(false);
    expect(result.receipt).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it('requires persisted authorization evidence even for a valid ready plan', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const writer = vi.fn();

    const result = await execute(plan, writer);

    expect(result.executed).toBe(false);
    expect(result.receipt).toBeNull();
    expect(writer).not.toHaveBeenCalled();
  });

  it('records verified readback and stable backlinks for an authorized local write', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const writer = vi.fn(async () => ({
      status: 'completed' as const,
      writes: [{
        targetRef: 'projects://skill-eval/decision',
        version: 'v4',
        sha256: 'b'.repeat(64),
        externalId: null,
        readback: 'verified' as const,
        backlink: {
          artifactRef: artifact.ref,
          artifactSha256: artifact.sha256,
          decisionId: 'decision-synthetic-96-a',
        },
      }],
    }));

    const result = await execute(
      plan,
      writer,
      authorizationFor(plan),
      () => new Date('2026-08-31T12:01:00.000Z'),
    );

    expect(result.executed).toBe(true);
    expect(result.receipt).toMatchObject({
      receiptId: expect.stringMatching(/^sr_[0-9a-f]{24}$/),
      planId: plan.planId,
      status: 'completed',
      writes: [{
        targetRef: 'projects://skill-eval/decision',
        readback: 'verified',
        backlink: {
          artifactRef: artifact.ref,
          artifactSha256: artifact.sha256,
          decisionId: 'decision-synthetic-96-a',
        },
      }],
    });
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the writer reports a different target or an unproven backlink', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-08-31T12:00:00.000Z',
    });
    const writer = vi.fn(async () => ({
      status: 'completed' as const,
      writes: [{
        targetRef: 'projects://other-project/decision',
        version: 'v4',
        sha256: 'b'.repeat(64),
        externalId: null,
        readback: 'verified' as const,
        backlink: null,
      }],
    }));

    const result = await execute(plan, writer, authorizationFor(plan));

    expect(result.receipt?.status).toBe('failed');
  });

  it('does not manufacture backlink proof for an otherwise verified target readback', async () => {
    const plan = createArtifactSettlementPlan({
      artifact,
      decisionId: 'decision-synthetic-96-a',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://skill-eval/decision',
      authorizedDestinations: ['project_knowledge'],
      createdAt: '2026-08-31T12:00:00.000Z',
    });

    const result = await execute(
      plan,
      async () => ({
        status: 'completed',
        writes: [{
          targetRef: plan.targetRef!,
          version: 'v4',
          sha256: 'b'.repeat(64),
          externalId: null,
          readback: 'verified',
          backlink: null,
        }],
      }),
      authorizationFor(plan),
    );

    expect(result.receipt?.status).toBe('failed');
    expect(result.receipt?.writes[0]?.backlink).toBeNull();
  });
});
