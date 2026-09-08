import { describe, expect, it } from 'vitest';

import {
  projectAdmissionForObsidian,
  projectAdmissionForWeb,
} from '../../../src/services/agent-admission-projection.js';
import type { AdmissionVerdict } from '../../../src/domain/agent-admission.js';

const verdict: AdmissionVerdict = {
  verdict: 'needs_completion',
  evaluated_at: '2026-08-22T00:00:00.000Z',
  rule_version: 'agent-admission-v1',
  input_fingerprint: 'a'.repeat(64),
  reasons: [{
    code: 'objective_missing',
    field_or_gate: 'objective',
    message: 'Objective is required',
    recoverable: true,
    next_action: 'Add an objective',
  }],
  permission_gate: {
    mode: 'readonly',
    external_writes: [],
    requires_authorization: false,
    authorized: false,
  },
};

const traceability = {
  task_id: 'synthetic-task-001',
  task_revision: '2026-08-22T00:00:00.000Z',
  project_id: 'synthetic-project',
  context_pack_id: 'synthetic-pack-001',
  expected_artifact: 'research_result_v1',
  acceptance_criteria: ['A bounded evidence summary exists'],
  source_key: 'synthetic:source:001',
};

describe('agent admission projections', () => {
  it('uses the same DTO and reason contract for Web and Obsidian', () => {
    const expected = { ...verdict, traceability };
    expect(projectAdmissionForWeb(verdict, traceability)).toEqual(expected);
    expect(projectAdmissionForObsidian(verdict, traceability)).toEqual(expected);
    expect(projectAdmissionForWeb(verdict, traceability))
      .toEqual(projectAdmissionForObsidian(verdict, traceability));
  });
});
