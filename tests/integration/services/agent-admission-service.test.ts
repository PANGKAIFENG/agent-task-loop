import { afterEach, describe, expect, it } from 'vitest';

import type {
  AdmissionInput,
  ExternalWriteSpec,
} from '../../../src/domain/agent-admission.js';
import type { Task } from '../../../src/domain/task.js';
import {
  authorizeAgentExecution,
  AgentAuthorizationStaleVerdictError,
} from '../../../src/services/authorize-agent-execution.js';
import {
  buildAgentAdmissionInput,
  evaluateAgentAdmissionForTask,
  type AgentAdmissionInputOverrides,
} from '../../../src/services/evaluate-agent-admission.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { confirmTask } from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];
const WRITE: ExternalWriteSpec = {
  action: 'vault_write',
  target: 'synthetic-target',
  readBackExpectation: 'Read the synthetic target after the write',
};
const REPO_WRITE: ExternalWriteSpec = {
  action: 'external_repo_commit',
  target: 'synthetic-owner/synthetic-repo',
  readBackExpectation: 'Read the synthetic commit from the synthetic repository',
};

async function makeReady(context: TestServiceContext): Promise<Task> {
  await createProject(context.ctx, {
    projectId: 'synthetic-project',
    name: 'Synthetic project',
    description: 'Synthetic project for admission tests.',
    resources: [],
  });
  const captured = await captureTask(context.ctx, {
    title: 'Synthetic admission task',
    body: 'Synthetic task body.',
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: 'synthetic-source',
    sourceQuote: 'synthetic quote',
    sourceKey: 'synthetic:agent-admission-service',
    priority: 'normal',
  });
  return confirmTask(context.ctx, captured.taskId, {
    projectId: 'synthetic-project',
    taskType: 'research',
    objective: 'Compare public evidence.',
    acceptanceCriteria: ['A bounded evidence summary exists.'],
    permissionProfile: 'read_only_research',
    priority: 'normal',
  });
}

function externalOverrides(
  authorization: AdmissionInput['permission']['authorization'] = null,
): AgentAdmissionInputOverrides {
  return {
    source: {
      status: 'available',
      sourceKey: 'synthetic:agent-admission-service',
    },
    contextPack: {
      contextPackId: 'synthetic-pack-001',
      complete: true,
      refs: ['synthetic/context-pack.md'],
    },
    expectedArtifact: 'research_result_v1',
    priorityAndTimeKnown: true,
    capability: {
      capabilityId: 'research_v1',
      taskTypes: ['research'],
      projectRefs: ['synthetic-project'],
      applicable: true,
      profileComplete: true,
      permissions: { mode: 'readonly', externalWrites: [] },
      eval: { gate: 'manual_review', passed: true },
    },
    permission: {
      mode: 'external_write',
      externalWrites: [WRITE],
      authorization,
    },
    capacity: { available: true },
    duplicate: { possible: false },
  };
}

function repoExternalOverrides(
  authorization: AdmissionInput['permission']['authorization'] = null,
): AgentAdmissionInputOverrides {
  return {
    source: {
      status: 'available',
      sourceKey: 'synthetic:agent-admission-service',
    },
    contextPack: {
      contextPackId: 'synthetic-pack-001',
      complete: true,
      refs: ['synthetic/context-pack.md'],
    },
    expectedArtifact: 'research_result_v1',
    priorityAndTimeKnown: true,
    capability: {
      capabilityId: 'development_v1',
      taskTypes: ['research'],
      projectRefs: ['synthetic-project'],
      applicable: true,
      profileComplete: true,
      permissions: { mode: 'external_write', externalWrites: ['external_repo_commit'] },
      eval: { gate: 'manual_review', passed: true },
    },
    permission: {
      mode: 'external_write',
      externalWrites: [REPO_WRITE],
      authorization,
    },
    capacity: { available: true },
    duplicate: { possible: false },
  };
}

function readonlyOverrides(): AgentAdmissionInputOverrides {
  return {
    source: {
      status: 'available',
      sourceKey: 'synthetic:agent-admission-service',
    },
    contextPack: {
      contextPackId: 'synthetic-pack-001',
      complete: true,
      refs: ['synthetic/context-pack.md'],
    },
    expectedArtifact: 'research_result_v1',
    priorityAndTimeKnown: true,
    capability: {
      capabilityId: 'research_v1',
      taskTypes: ['research'],
      projectRefs: ['synthetic-project'],
      applicable: true,
      profileComplete: true,
      permissions: { mode: 'readonly', externalWrites: [] },
      eval: { gate: 'manual_review', passed: true },
    },
    permission: {
      mode: 'readonly',
      externalWrites: [],
      authorization: null,
    },
    capacity: { available: true },
    duplicate: { possible: false },
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('agent admission service', () => {
  it('fails closed when no verified admission facts are supplied', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);

    await expect(evaluateAgentAdmissionForTask(context.ctx, ready))
      .resolves.toMatchObject({
        verdict: 'rejected',
        permission_gate: { authorized: false },
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'source_unavailable' }),
          expect.objectContaining({ code: 'context_pack_incomplete' }),
          expect.objectContaining({ code: 'artifact_missing' }),
          expect.objectContaining({ code: 'priority_or_time_unknown' }),
          expect.objectContaining({ code: 'capability_not_applicable' }),
          expect.objectContaining({ code: 'eval_gate_missing' }),
          expect.objectContaining({ code: 'agent_capacity_unavailable' }),
        ]),
      });
    await expect(authorizeAgentExecution(context.ctx, ready.taskId))
      .rejects.toMatchObject({
        code: 'task_agent_authorization_not_ready',
        verdict: expect.objectContaining({ verdict: 'rejected' }),
      });
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toMatchObject({
      status: 'ready',
      autoExecutable: false,
    });
  });

  it('keeps the task Ready when requested writes exceed Task and Capability boundaries', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const overrides = externalOverrides();

    await expect(evaluateAgentAdmissionForTask(context.ctx, ready, overrides))
      .resolves.toMatchObject({
        verdict: 'rejected',
        permission_gate: { authorized: false },
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'task_permission_mismatch' }),
          expect.objectContaining({ code: 'capability_permission_mismatch' }),
        ]),
      });
    await expect(authorizeAgentExecution(context.ctx, ready.taskId, { admission: overrides }))
      .rejects.toMatchObject({
        code: 'task_agent_authorization_not_ready',
        verdict: expect.objectContaining({ verdict: 'rejected' }),
      });
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toMatchObject({
      status: 'ready',
      autoExecutable: false,
    });
    await expect(context.ctx.audit.listForTask(ready.taskId)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'task.agent_authorized' })]),
    );
  });

  it('returns the current admission verdict alongside legacy readiness errors', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const incomplete = await context.ctx.tasks.save({
      ...ready,
      reviewState: 'candidate',
      objective: null,
      acceptanceCriteria: [],
      updatedAt: '2026-07-14T00:01:00.000Z',
    });

    await expect(authorizeAgentExecution(context.ctx, incomplete.taskId, {
      admission: readonlyOverrides(),
    }))
      .rejects.toMatchObject({
        code: 'task_agent_authorization_not_ready',
        verdict: expect.objectContaining({
          verdict: 'needs_completion',
          reasons: expect.arrayContaining([
            expect.objectContaining({ code: 'task_not_confirmed' }),
            expect.objectContaining({ code: 'objective_missing' }),
          ]),
        }),
      });
  });

  it('recomputes inside the lock and audits the current readonly admission fingerprint', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const withoutAuthorization = readonlyOverrides();
    const baseline = await buildAgentAdmissionInput(context.ctx, ready, withoutAuthorization);
    const fingerprint = (await evaluateAgentAdmissionForTask(
      context.ctx,
      ready,
      withoutAuthorization,
    )).input_fingerprint;
    const authorized = await authorizeAgentExecution(context.ctx, ready.taskId, {
      admission: withoutAuthorization,
    });

    expect(authorized).toMatchObject({ status: 'agent_executable', autoExecutable: true });
    expect(baseline.task.taskId).toBe(ready.taskId);
    await expect(context.ctx.audit.listForTask(ready.taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'task.agent_authorized',
          admissionInputFingerprint: fingerprint,
        }),
      ]),
    );
  });

  it('rejects caller-supplied external writes outside a read-only Task boundary', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const withoutAuthorization = externalOverrides();
    const fingerprint = (await evaluateAgentAdmissionForTask(
      context.ctx,
      ready,
      withoutAuthorization,
    )).input_fingerprint;

    await expect(authorizeAgentExecution(context.ctx, ready.taskId, {
      admission: {
        ...withoutAuthorization,
        permission: {
          ...withoutAuthorization.permission!,
          authorization: {
            taskId: ready.taskId,
            taskRevision: ready.updatedAt,
            admissionInputFingerprint: fingerprint,
            exactActions: [WRITE],
            actor: 'synthetic-reviewer',
            authorizedAt: '2026-07-14T00:00:00.000Z',
            expiresOrInvalidatesOn: '2026-07-15T00:00:00.000Z',
            readBackReceipt: 'synthetic-authorization-receipt',
          },
        },
      },
    })).rejects.toMatchObject({
      code: 'task_agent_authorization_not_ready',
      verdict: expect.objectContaining({
        verdict: 'rejected',
        permission_gate: expect.objectContaining({ authorized: false }),
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'task_permission_mismatch' }),
          expect.objectContaining({ code: 'capability_permission_mismatch' }),
        ]),
      }),
    });
    await expect(context.ctx.tasks.get(ready.taskId)).resolves.toMatchObject({
      permissionProfile: 'read_only_research',
      status: 'ready',
      autoExecutable: false,
    });
  });

  it('does not project authorization for an invalid Capability Eval with a current receipt', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const repoTask = await context.ctx.tasks.save({
      ...ready,
      permissionProfile: 'repo_delivery',
    });
    const withoutAuthorization: AgentAdmissionInputOverrides = {
      ...repoExternalOverrides(),
      capability: {
        ...repoExternalOverrides().capability!,
        eval: { gate: 'manual_review', passed: 'unknown' as never },
      },
    };
    const fingerprint = (await evaluateAgentAdmissionForTask(
      context.ctx,
      repoTask,
      withoutAuthorization,
    )).input_fingerprint;
    const expiry = new Date(context.ctx.clock().getTime() + 60 * 60 * 1000).toISOString();
    const result = await evaluateAgentAdmissionForTask(context.ctx, repoTask, {
      ...withoutAuthorization,
      permission: {
        ...withoutAuthorization.permission!,
        authorization: {
          taskId: repoTask.taskId,
          taskRevision: repoTask.updatedAt,
          admissionInputFingerprint: fingerprint,
          exactActions: [REPO_WRITE],
          actor: 'synthetic-reviewer',
          authorizedAt: repoTask.updatedAt,
          expiresOrInvalidatesOn: expiry,
          readBackReceipt: 'synthetic-authorization-receipt',
        },
      },
    });

    expect(result.verdict).toBe('needs_completion');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'eval_gate_missing' })]),
    );
    expect(result.permission_gate.authorized).toBe(false);
  });

  it('rejects a previously authorized fingerprint after the task revision changes', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const overrides = externalOverrides();
    const fingerprint = (await evaluateAgentAdmissionForTask(context.ctx, ready, overrides))
      .input_fingerprint;
    const authorization = {
      taskId: ready.taskId,
      taskRevision: ready.updatedAt,
      admissionInputFingerprint: fingerprint,
      exactActions: [WRITE],
      actor: 'synthetic-reviewer',
      authorizedAt: '2026-07-14T00:00:00.000Z',
      expiresOrInvalidatesOn: '2026-07-15T00:00:00.000Z',
      readBackReceipt: 'synthetic-authorization-receipt',
    };
    const revised = await context.ctx.tasks.save({
      ...ready,
      objective: 'Changed synthetic objective.',
      updatedAt: '2026-07-14T00:01:00.000Z',
    });

    await expect(authorizeAgentExecution(context.ctx, revised.taskId, {
      admission: {
        ...overrides,
        permission: { ...overrides.permission!, authorization },
      },
    })).rejects.toMatchObject({
      code: 'task_agent_authorization_not_ready',
      verdict: expect.objectContaining({
        verdict: 'rejected',
        reasons: expect.arrayContaining([expect.objectContaining({ code: 'verdict_stale' })]),
      }),
    });
    await expect(context.ctx.tasks.get(revised.taskId)).resolves.toMatchObject({
      status: 'ready',
      objective: 'Changed synthetic objective.',
    });
  });

  it('uses the service clock for expiry instead of a caller-supplied evaluation time', async () => {
    const context = await createTestServiceContext({ now: new Date('2026-07-14T01:01:00.000Z') });
    contexts.push(context);
    const ready = await makeReady(context);
    const revised = await context.ctx.tasks.save({
      ...ready,
      updatedAt: '2026-07-14T01:00:00.000Z',
    });
    const overrides = externalOverrides({
      taskId: revised.taskId,
      taskRevision: revised.updatedAt,
      admissionInputFingerprint: '',
      exactActions: [WRITE],
      actor: 'synthetic-reviewer',
      authorizedAt: '2026-07-14T01:00:00.000Z',
      expiresOrInvalidatesOn: '2026-07-14T01:00:30.000Z',
      readBackReceipt: 'synthetic-authorization-receipt',
    });
    const fingerprint = (await evaluateAgentAdmissionForTask(
      context.ctx,
      revised,
      { ...overrides, evaluatedAt: '2026-07-14T01:00:10.000Z' },
    )).input_fingerprint;

    await expect(authorizeAgentExecution(context.ctx, revised.taskId, {
      admission: {
        ...overrides,
        evaluatedAt: '2026-07-14T01:00:10.000Z',
        permission: {
          ...overrides.permission!,
          authorization: {
            ...overrides.permission!.authorization!,
            admissionInputFingerprint: fingerprint,
          },
        },
      },
    })).rejects.toMatchObject({
      code: 'task_agent_authorization_not_ready',
      verdict: expect.objectContaining({
        verdict: 'rejected',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'verdict_stale' }),
        ]),
      }),
    });
  });

  it('rejects a stale readonly verdict after re-reading a changed task inside the lock', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const prior = await evaluateAgentAdmissionForTask(context.ctx, ready, readonlyOverrides());
    const revised = await context.ctx.tasks.save({
      ...ready,
      objective: 'Changed after the verdict was displayed.',
      updatedAt: '2026-07-14T00:02:00.000Z',
    });

    await expect(authorizeAgentExecution(context.ctx, revised.taskId, {
      expectedInputFingerprint: prior.input_fingerprint,
      admission: readonlyOverrides(),
    })).rejects.toBeInstanceOf(AgentAuthorizationStaleVerdictError);
    await expect(context.ctx.tasks.get(revised.taskId)).resolves.toMatchObject({
      status: 'ready',
      objective: 'Changed after the verdict was displayed.',
    });
  });

  it('does not bypass the PAW-GOAL-003 development authorization and dispatch path', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    const ready = await makeReady(context);
    const development = await context.ctx.tasks.save({
      ...ready,
      taskType: 'development',
      permissionProfile: 'repo_delivery',
      executionTarget: 'multica',
      contextRefs: ['synthetic/context-pack.md'],
    });
    const withoutAuthorization: AgentAdmissionInputOverrides = {
      ...externalOverrides(),
      capability: {
        capabilityId: 'development_v1',
        taskTypes: ['development'],
        projectRefs: ['synthetic-project'],
        applicable: true,
        profileComplete: true,
        permissions: { mode: 'external_write', externalWrites: ['external_repo_commit'] },
        eval: { gate: 'manual_review', passed: true },
      },
      permission: {
        mode: 'external_write',
        externalWrites: [REPO_WRITE],
        authorization: null,
      },
    };
    const fingerprint = (await evaluateAgentAdmissionForTask(
      context.ctx,
      development,
      withoutAuthorization,
    )).input_fingerprint;
    const authorization = {
      taskId: development.taskId,
      taskRevision: development.updatedAt,
      admissionInputFingerprint: fingerprint,
      exactActions: [REPO_WRITE],
      actor: 'synthetic-reviewer',
      authorizedAt: '2026-07-14T00:00:00.000Z',
      expiresOrInvalidatesOn: '2026-07-15T00:00:00.000Z',
      readBackReceipt: 'synthetic-authorization-receipt',
    };

    await expect(authorizeAgentExecution(context.ctx, development.taskId, {
      admission: {
        ...withoutAuthorization,
        permission: {
          ...withoutAuthorization.permission!,
          authorization,
        },
      },
    })).rejects.toMatchObject({
      code: 'task_agent_authorization_not_ready',
      errors: expect.arrayContaining([
        'taskType must be research',
        'permissionProfile must be read_only_research',
      ]),
    });
    await expect(context.ctx.tasks.get(development.taskId)).resolves.toMatchObject({
      status: 'ready',
      executionTarget: 'multica',
    });
  });
});
