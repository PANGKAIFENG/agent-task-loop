import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  ADMISSION_RULE_VERSION,
  admissionInputFingerprint,
  evaluateAgentAdmission,
  isAdmissionStale,
  type AdmissionInput,
} from '../../../src/domain/agent-admission.js';

const NOW = '2026-08-22T00:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'synthetic-admission-001',
    title: 'Synthetic admission task',
    body: 'Synthetic body',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'synthetic-project',
    taskType: 'research',
    objective: 'Compare public evidence',
    acceptanceCriteria: ['A bounded evidence summary exists'],
    autoExecutable: false,
    permissionProfile: 'read_only_research',
    executionTarget: null,
    contextRefs: ['synthetic/context-pack.md'],
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: 'synthetic-source',
    sourceQuote: 'synthetic quote',
    sourceKey: 'synthetic:admission:001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    task: task(),
    project: { exists: true, projectId: 'synthetic-project' },
    source: { status: 'available', sourceKey: 'synthetic:admission:001' },
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
    evaluatedAt: NOW,
    ...overrides,
  };
}

function externalInput(
  authorization: AdmissionInput['permission']['authorization'] = null,
): AdmissionInput {
  return input({
    task: task({ permissionProfile: 'repo_delivery' }),
    capability: {
      capabilityId: 'research_v1',
      taskTypes: ['research'],
      projectRefs: ['synthetic-project'],
      applicable: true,
      profileComplete: true,
      permissions: { mode: 'external_write', externalWrites: ['external_repo_commit'] },
      eval: { gate: 'manual_review', passed: true },
    },
    permission: {
      mode: 'external_write',
      externalWrites: [{
        action: 'external_repo_commit',
        target: 'synthetic-owner/synthetic-repo',
        readBackExpectation: 'Read the synthetic target after the write',
      }],
      authorization,
    },
  });
}

function currentExternalInput(): AdmissionInput {
  const authorization = {
    taskId: 'synthetic-admission-001',
    taskRevision: NOW,
    admissionInputFingerprint: '',
    exactActions: externalInput().permission.externalWrites,
    actor: 'synthetic-reviewer',
    authorizedAt: NOW,
    expiresOrInvalidatesOn: '2026-08-22T01:00:00.000Z',
    readBackReceipt: 'synthetic-authorization-receipt',
  };
  const unbound = externalInput(authorization);
  return externalInput({
    ...authorization,
    admissionInputFingerprint: admissionInputFingerprint(unbound),
  });
}

function withCurrentAuthorization(admission: AdmissionInput): AdmissionInput {
  const authorization = {
    taskId: admission.task.taskId,
    taskRevision: admission.task.updatedAt,
    admissionInputFingerprint: '',
    exactActions: admission.permission.externalWrites,
    actor: 'synthetic-reviewer',
    authorizedAt: admission.evaluatedAt,
    expiresOrInvalidatesOn: '2026-08-22T01:00:00.000Z',
    readBackReceipt: 'synthetic-authorization-receipt',
  };
  const bound = {
    ...admission,
    permission: {
      ...admission.permission,
      authorization,
    },
  };
  return {
    ...bound,
    permission: {
      ...bound.permission,
      authorization: {
        ...authorization,
        admissionInputFingerprint: admissionInputFingerprint(bound),
      },
    },
  };
}

describe('evaluateAgentAdmission', () => {
  it('returns an admittable readonly verdict with a stable fingerprint', () => {
    const result = evaluateAgentAdmission(input());

    expect(result).toMatchObject({
      verdict: 'admittable',
      rule_version: ADMISSION_RULE_VERSION,
      evaluated_at: NOW,
      input_fingerprint: expect.any(String),
      permission_gate: {
        mode: 'readonly',
        external_writes: [],
        requires_authorization: false,
        authorized: false,
      },
      reasons: [],
    });
    expect(result.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns stable field-level reasons for missing input', () => {
    const result = evaluateAgentAdmission(input({
      task: task({
        reviewState: 'candidate',
        projectId: null,
        objective: null,
        acceptanceCriteria: [],
      }),
      project: { exists: false, projectId: null },
      source: { status: 'missing', sourceKey: null },
      contextPack: { contextPackId: null, complete: false, refs: [] },
      expectedArtifact: null,
      priorityAndTimeKnown: false,
      capability: null,
      permission: { mode: null, externalWrites: [], authorization: null },
    }));

    expect(result.verdict).toBe('needs_completion');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'task_not_confirmed',
      'project_missing_or_unknown',
      'source_missing',
      'objective_missing',
      'acceptance_missing',
      'artifact_missing',
      'context_pack_incomplete',
      'priority_or_time_unknown',
      'capability_not_applicable',
      'eval_gate_missing',
      'permission_mode_unknown',
    ]);
    for (const reason of result.reasons) {
      expect(reason).toMatchObject({
        field_or_gate: expect.any(String),
        message: expect.any(String),
        recoverable: expect.any(Boolean),
        next_action: expect.any(String),
      });
    }
  });

  it('requires independent authorization for an exact external-write set', () => {
    const result = evaluateAgentAdmission(externalInput());

    expect(result.verdict).toBe('needs_authorization');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'external_write_confirmation_required',
    ]);
    expect(result.permission_gate).toMatchObject({
      mode: 'external_write',
      requires_authorization: true,
      authorized: false,
    });
  });

  it('rejects an external action outside the Capability action allowlist', () => {
    const request = externalInput();
    const result = evaluateAgentAdmission({
      ...request,
      capability: {
        ...request.capability!,
        permissions: {
          mode: 'external_write',
          externalWrites: ['vault_write'],
        },
      },
    });

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'capability_permission_mismatch',
    ]);
    expect(result.permission_gate.authorized).toBe(false);
  });

  it('rejects an unknown Capability permission mode', () => {
    const result = evaluateAgentAdmission(input({
      capability: {
        ...input().capability!,
        permissions: { mode: 'unknown' as never, externalWrites: [] },
      },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'capability_permission_mismatch',
    ]);
  });

  it.each(['readonly', 'draft'] as const)(
    'rejects external writes in %s mode',
    (mode) => {
      const result = evaluateAgentAdmission(input({
        permission: {
          mode,
          externalWrites: externalInput().permission.externalWrites,
          authorization: null,
        },
      }));

      expect(result.verdict).toBe('rejected');
      expect(result.reasons.map(({ code }) => code)).toEqual([
        'external_write_not_allowed_for_mode',
      ]);
    },
  );

  it('rejects incomplete external-write actions before asking for authorization', () => {
    const result = evaluateAgentAdmission(input({
      permission: {
        mode: 'external_write',
        externalWrites: [{ action: 'unknown', target: '', readBackExpectation: '' }],
        authorization: null,
      },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'external_write_action_unknown',
      'external_write_target_required',
      'read_back_contract_required',
    ]);
  });

  it('does not mark an invalid external-write contract as authorized', () => {
    const invalid = input({
      permission: {
        mode: 'external_write',
        externalWrites: [{
          action: 'unknown',
          target: 'synthetic-target',
          readBackExpectation: 'Read the synthetic target after the write',
        }],
        authorization: null,
      },
    });
    const result = evaluateAgentAdmission({
      ...invalid,
      permission: {
        ...invalid.permission,
        authorization: {
          taskId: invalid.task.taskId,
          taskRevision: invalid.task.updatedAt,
          admissionInputFingerprint: admissionInputFingerprint(invalid),
          exactActions: invalid.permission.externalWrites,
          actor: 'synthetic-reviewer',
          authorizedAt: NOW,
          expiresOrInvalidatesOn: '2026-08-22T01:00:00.000Z',
          readBackReceipt: 'synthetic-authorization-receipt',
        },
      },
    });

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'external_write_action_unknown',
    ]);
    expect(result.permission_gate.authorized).toBe(false);
  });

  it('admits an exact, current external-write authorization with a receipt', () => {
    const result = evaluateAgentAdmission(currentExternalInput());

    expect(result).toMatchObject({
      verdict: 'admittable',
      reasons: [],
      permission_gate: {
        mode: 'external_write',
        requires_authorization: true,
        authorized: true,
      },
    });
  });

  it.each([
    ['absent Capability', (admission: AdmissionInput) => ({ ...admission, capability: null }), 'capability_not_applicable'],
    ['inapplicable Capability', (admission: AdmissionInput) => ({
      ...admission,
      capability: { ...admission.capability!, applicable: false },
    }), 'capability_not_applicable'],
    ['incomplete Capability profile', (admission: AdmissionInput) => ({
      ...admission,
      capability: { ...admission.capability!, profileComplete: false },
    }), 'capability_not_applicable'],
    ['missing Eval gate', (admission: AdmissionInput) => ({
      ...admission,
      capability: { ...admission.capability!, eval: null },
    }), 'eval_gate_missing'],
    ['failed Eval gate', (admission: AdmissionInput) => ({
      ...admission,
      capability: {
        ...admission.capability!,
        eval: { gate: 'manual_review', passed: false },
      },
    }), 'eval_gate_missing'],
    ['unknown Eval gate fact', (admission: AdmissionInput) => ({
      ...admission,
      capability: {
        ...admission.capability!,
        eval: { gate: 'manual_review', passed: 'unknown' as never },
      },
    }), 'eval_gate_missing'],
  ] as const)('never authorizes a current receipt when %s', (_, mutate, reasonCode) => {
    const result = evaluateAgentAdmission(withCurrentAuthorization(mutate(externalInput())));

    expect(result.verdict).not.toBe('admittable');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: reasonCode })]),
    );
    expect(result.permission_gate.authorized).toBe(false);
  });

  it('fails closed when the authorization has no read-back receipt', () => {
    const current = currentExternalInput();
    const result = evaluateAgentAdmission({
      ...current,
      permission: {
        ...current.permission,
        authorization: {
          ...current.permission.authorization!,
          readBackReceipt: null,
        },
      },
    });

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual(['verdict_stale']);
  });

  it('rejects an expired external-write authorization as stale', () => {
    const current = currentExternalInput();
    const expired = input({
      ...current,
      evaluatedAt: '2026-08-22T02:00:00.000Z',
    });

    expect(evaluateAgentAdmission(expired).reasons.map(({ code }) => code))
      .toEqual(['verdict_stale']);
    expect(isAdmissionStale(evaluateAgentAdmission(current), expired)).toBe(true);
  });

  it.each([
    ['invalid', 'not-a-timestamp'],
    ['future', '2026-08-22T00:30:00.000Z'],
    ['pre-revision', '2026-08-21T23:59:00.000Z'],
  ])('rejects an %s external-write authorization timestamp', (_, authorizedAt) => {
    const current = currentExternalInput();
    const result = evaluateAgentAdmission({
      ...current,
      permission: {
        ...current.permission,
        authorization: {
          ...current.permission.authorization!,
          authorizedAt,
        },
      },
    });

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual(['verdict_stale']);
  });

  it('fails closed when source, context, capability, or duplicate facts are unknown', () => {
    const result = evaluateAgentAdmission(input({
      source: { status: 'available', sourceKey: null },
      contextPack: { contextPackId: null, complete: true, refs: [''] },
      capability: {
        capabilityId: '',
        taskTypes: ['research'],
        projectRefs: ['synthetic-project'],
        applicable: true,
        profileComplete: true,
        permissions: { mode: 'readonly', externalWrites: [] },
        eval: { gate: '', passed: true },
      },
      duplicate: { possible: null as never },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'source_missing',
      'context_pack_incomplete',
      'capability_not_applicable',
      'eval_gate_missing',
      'possible_duplicate',
    ]);
  });

  it('does not treat truthy non-boolean facts as verified', () => {
    const unknown = 'unknown' as never;
    const result = evaluateAgentAdmission(input({
      project: { exists: unknown, projectId: 'synthetic-project' },
      contextPack: {
        contextPackId: 'synthetic-pack-001',
        complete: unknown,
        refs: ['synthetic/context-pack.md'],
      },
      priorityAndTimeKnown: unknown,
      capability: {
        capabilityId: 'research_v1',
        taskTypes: ['research'],
        projectRefs: ['synthetic-project'],
        applicable: unknown,
        profileComplete: unknown,
        permissions: { mode: 'readonly', externalWrites: [] },
        eval: { gate: 'manual_review', passed: unknown },
      },
    }));

    expect(result.verdict).not.toBe('admittable');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'project_missing_or_unknown',
      'context_pack_incomplete',
      'priority_or_time_unknown',
      'capability_not_applicable',
      'eval_gate_missing',
    ]);
  });

  it('fails closed when the source key conflicts or permission mode is unknown', () => {
    const result = evaluateAgentAdmission(input({
      source: { status: 'available', sourceKey: 'synthetic:other-source' },
      permission: {
        mode: 'unknown' as never,
        externalWrites: [],
        authorization: null,
      },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'source_conflict',
      'permission_mode_unknown',
    ]);
  });

  it('fails closed for an unknown source status and malformed external-write entry', () => {
    const result = evaluateAgentAdmission(input({
      source: {
        status: 'unknown' as never,
        sourceKey: 'synthetic:admission:001',
      },
      permission: {
        mode: 'external_write',
        externalWrites: [null as never],
        authorization: undefined as never,
      },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'source_unavailable',
      'external_write_action_unknown',
      'external_write_target_required',
      'read_back_contract_required',
    ]);
  });

  it('fails closed for duplicate or unavailable capacity', () => {
    const result = evaluateAgentAdmission(input({
      duplicate: { possible: true, taskIds: ['synthetic-other'] },
      capacity: { available: false, reason: 'synthetic queue full' },
    }));

    expect(result.verdict).toBe('rejected');
    expect(result.reasons.map(({ code }) => code)).toEqual([
      'possible_duplicate',
      'agent_capacity_unavailable',
    ]);
  });

  it('marks a verdict stale when any admission input changes', () => {
    const result = evaluateAgentAdmission(input());
    const widenedCapability = input({
      capability: {
        ...input().capability!,
        permissions: { mode: 'readonly', externalWrites: ['vault_write'] },
      },
    });

    expect(isAdmissionStale(result, input({ task: task({ objective: 'changed' }) }))).toBe(true);
    expect(isAdmissionStale(result, widenedCapability)).toBe(true);
    expect(isAdmissionStale(result, currentExternalInput())).toBe(true);
    expect(isAdmissionStale(result, input())).toBe(false);
  });

  it('marks the authorization transition itself stale even when its binding fingerprint is unchanged', () => {
    const pending = evaluateAgentAdmission(externalInput());
    expect(isAdmissionStale(pending, currentExternalInput())).toBe(true);
  });
});
