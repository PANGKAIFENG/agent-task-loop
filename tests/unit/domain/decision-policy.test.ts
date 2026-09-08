import { describe, expect, it } from 'vitest';

import {
  DECISION_DIMENSIONS,
  decisionPolicySchema,
  LEGAL_POLICY_TRANSITIONS,
  POLICY_STATUSES,
  type PolicyStatus,
} from '../../../src/domain/decision-policy.js';

interface PolicyFixture {
  policy_id: string;
  version: string;
  status: string;
  dimension: string;
  decision_question: string;
  inputs: { name: string; source: string }[];
  sources: string[];
  rules: { statement: string; priority?: number }[];
  exceptions: string[];
  outputs: string[];
  rationale: string;
  examples: { input: string; output: string }[];
  counterexamples: { input: string; output: string }[];
  metrics: string[];
  next_review_at: string;
  created_at: string;
  status_history?: { status: string; at: string }[];
}

function omit<T extends object>(source: T, key: keyof T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));
}

function makePolicy(overrides: Partial<PolicyFixture> = {}): PolicyFixture {
  return {
    policy_id: 'policy.input-routing.synthetic',
    version: 'v001',
    status: 'observing',
    dimension: 'input-routing',
    decision_question: 'Is a WeChat message information, a candidate, a task, a project or a decision?',
    inputs: [{ name: 'sender identity', source: 'wechat contact profile' }],
    sources: ['synthetic_input', 'PAW-GOAL-002@0.1'],
    rules: [
      { statement: 'Route messages with an explicit commitment to inbox candidates.', priority: 10 },
      { statement: 'Leave messages without a detectable ask in the inbox.', priority: 20 },
    ],
    exceptions: ['Messages from unknown senders stay unreviewed.'],
    outputs: ['inbox', 'candidate', 'project_link', 'clarify_request'],
    rationale: 'First version calibrated by the synthetic loop only.',
    examples: [{ input: 'synthetic message asking for a report', output: 'candidate' }],
    counterexamples: [{ input: 'synthetic chit-chat', output: 'inbox' }],
    metrics: ['trace_coverage', 'user_correction_rate'],
    next_review_at: '2026-08-24',
    created_at: '2026-08-18T06:00:00.000Z',
    ...overrides,
  };
}

describe('decision policy schema', () => {
  it('accepts three legal synthetic fixtures', () => {
    const observing = makePolicy();
    const active = makePolicy({
      policy_id: 'policy.attention-priority.synthetic',
      dimension: 'attention-priority',
      status: 'active',
      version: 'v002',
    });
    const draft = makePolicy({
      policy_id: 'policy.agent-admission.synthetic',
      dimension: 'agent-admission',
      status: 'draft',
    });

    for (const fixture of [observing, active, draft]) {
      const result = decisionPolicySchema.safeParse(fixture);
      expect(result.success, JSON.stringify(fixture)).toBe(true);
    }
    if (decisionPolicySchema.safeParse(observing).success) {
      const parsed = decisionPolicySchema.parse(observing);
      expect(parsed.status_history).toEqual([]);
    }
  });

  it('applies the status_history default and accepts an explicit history', () => {
    const withoutHistory = decisionPolicySchema.parse(makePolicy());
    expect(withoutHistory.status_history).toEqual([]);

    const withHistory = decisionPolicySchema.parse(makePolicy({
      status_history: [
        { status: 'draft', at: '2026-08-17T08:00:00.000Z' },
        { status: 'observing', at: '2026-08-18T06:00:00.000Z' },
      ],
    }));
    expect(withHistory.status_history).toHaveLength(2);
  });

  it('rejects fixtures with missing required fields', () => {
    expect(decisionPolicySchema.safeParse(omit(makePolicy(), 'decision_question')).success)
      .toBe(false);
    expect(decisionPolicySchema.safeParse(omit(makePolicy(), 'rationale')).success).toBe(false);
    expect(decisionPolicySchema.safeParse(omit(makePolicy(), 'next_review_at')).success)
      .toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const withUnknown = { ...makePolicy(), unknown_field: 'extra' };
    expect(decisionPolicySchema.safeParse(withUnknown).success).toBe(false);

    const withNestedUnknown = makePolicy({
      inputs: [{ name: 'x', source: 'y', extra: 1 } as unknown as { name: string; source: string }],
    });
    expect(decisionPolicySchema.safeParse(withNestedUnknown).success).toBe(false);
  });

  it('rejects illegal status and dimension enums', () => {
    expect(decisionPolicySchema.safeParse(makePolicy({ status: 'live' })).success).toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({ dimension: 'misc' })).success).toBe(false);
  });

  it('rejects malformed policy ids and versions', () => {
    for (const policyId of [
      'input-routing.synthetic',       // missing policy. prefix
      'policy.input-routing',          // no namespace segment after the dimension part
      'policy.InputRouting.synthetic', // uppercase
      'policy.input-routing.synthetic!', // illegal character
      'policy..synthetic',
    ]) {
      expect(decisionPolicySchema.safeParse(makePolicy({ policy_id: policyId })).success, policyId)
        .toBe(false);
    }

    for (const version of ['v01', 'v0001', 'V001', '1', 'v001x']) {
      expect(decisionPolicySchema.safeParse(makePolicy({ version })).success, version).toBe(false);
    }
  });

  it('rejects illegal dates', () => {
    expect(decisionPolicySchema.safeParse(makePolicy({ created_at: '2026-08-18 06:00:00' })).success)
      .toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({ created_at: '2026-08-18' })).success)
      .toBe(false);
    for (const reviewAt of ['2026/08/24', '24-08-2026', '2026-8-4', 'not-a-date']) {
      expect(decisionPolicySchema.safeParse(makePolicy({ next_review_at: reviewAt })).success, reviewAt)
        .toBe(false);
    }
  });

  it('rejects overlength fields and out-of-range priorities', () => {
    expect(decisionPolicySchema.safeParse(makePolicy({
      decision_question: 'q'.repeat(501),
    })).success).toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({
      inputs: [{ name: 'n'.repeat(201), source: 's' }],
    })).success).toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({
      rules: [{ statement: 'r'.repeat(1001), priority: 10 }],
    })).success).toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({
      rationale: 'x'.repeat(2001),
    })).success).toBe(false);
    expect(decisionPolicySchema.safeParse(makePolicy({
      examples: [{ input: 'i'.repeat(501), output: 'o' }],
    })).success).toBe(false);
    for (const priority of [0, 100, -1, 1.5]) {
      expect(decisionPolicySchema.safeParse(makePolicy({
        rules: [{ statement: 'rule', priority }],
      })).success, `priority=${priority}`).toBe(false);
    }
    expect(decisionPolicySchema.safeParse(makePolicy({
      rules: [{ statement: 'rule', priority: 1 }],
      examples: [{ input: 'i'.repeat(500), output: 'o'.repeat(500) }],
    })).success).toBe(true);
  });

  it('rejects empty arrays where at least one entry is required', () => {
    for (const overrides of [
      { inputs: [] },
      { sources: [] },
      { rules: [] },
      { outputs: [] },
      { metrics: [] },
    ]) {
      expect(decisionPolicySchema.safeParse(makePolicy(overrides)).success, JSON.stringify(overrides))
        .toBe(false);
    }
  });
});

describe('legal policy transitions', () => {
  const expectedMatrix: Record<PolicyStatus, readonly PolicyStatus[]> = {
    draft: ['observing', 'deprecated'],
    observing: ['active', 'deprecated'],
    active: ['deprecated'],
    deprecated: [],
  };

  it('matches the frozen transition matrix', () => {
    expect(LEGAL_POLICY_TRANSITIONS).toEqual(expectedMatrix);
  });

  it('allows exactly the five enumerated transitions and rejects the other eleven', () => {
    const legal: string[] = [];
    for (const from of POLICY_STATUSES) {
      for (const to of POLICY_STATUSES) {
        const isLegal = LEGAL_POLICY_TRANSITIONS[from].includes(to);
        if (isLegal) {
          legal.push(`${from}->${to}`);
        }
      }
    }
    expect(legal).toEqual([
      'draft->observing',
      'draft->deprecated',
      'observing->active',
      'observing->deprecated',
      'active->deprecated',
    ]);
    expect(POLICY_STATUSES.length * POLICY_STATUSES.length - legal.length).toBe(11);
  });

  it('forbids reactivating a deprecated policy', () => {
    expect(LEGAL_POLICY_TRANSITIONS.deprecated).toEqual([]);
    expect(LEGAL_POLICY_TRANSITIONS.deprecated.includes('active')).toBe(false);
  });

  it('keeps the dimension catalog frozen', () => {
    expect(DECISION_DIMENSIONS).toEqual([
      'input-routing',
      'goal-decomposition',
      'attention-priority',
      'agent-admission',
      'intervention-escalation',
      'external-action',
      'result-acceptance',
      'session-return',
      'capability-upgrade',
    ]);
  });
});
