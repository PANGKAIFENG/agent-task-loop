import { describe, expect, it } from 'vitest';

import {
  driverResultJsonSchema,
  driverResultSchema,
  researchResultJsonSchema,
  researchResultSchema,
  type ResearchResult,
} from '../../../src/runner/result-contract.js';

const NOW = '2026-07-15T00:00:00.000Z';

function validResult(overrides: Partial<ResearchResult> = {}): ResearchResult {
  return {
    summary: 'The public documentation supports the finding.',
    findings: ['The documented limit is 100 requests per minute.'],
    evidence: [{
      title: 'Official limits',
      url: 'https://example.com/docs/limits',
      accessedAt: NOW,
    }],
    uncertainties: ['Enterprise limits are not published.'],
    recommendedActions: ['Confirm enterprise limits with the vendor.'],
    acceptance: [{
      criterion: 'Cite an official source.',
      status: 'met',
      note: 'The official limits page is cited.',
    }],
    ...overrides,
  };
}

describe('researchResultSchema', () => {
  it('accepts the Task 7 ArtifactResult shape with HTTPS evidence', () => {
    expect(researchResultSchema.parse(validResult())).toEqual(validResult());
  });

  it('rejects HTTP evidence', () => {
    const result = validResult({
      evidence: [{
        title: 'Insecure evidence',
        url: 'http://example.com/docs',
        accessedAt: NOW,
      }],
    });

    expect(researchResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects an empty findings list and blank findings', () => {
    expect(researchResultSchema.safeParse(validResult({ findings: [] })).success)
      .toBe(false);
    expect(researchResultSchema.safeParse(validResult({ findings: ['  '] })).success)
      .toBe(false);
  });

  it('rejects a result without acceptance mappings', () => {
    expect(researchResultSchema.safeParse(validResult({ acceptance: [] })).success)
      .toBe(false);
  });

  it('rejects malformed evidence timestamps and acceptance statuses', () => {
    const invalidTimestamp = validResult({
      evidence: [{
        title: 'Official limits',
        url: 'https://example.com/docs/limits',
        accessedAt: '2026-07-15',
      }],
    });
    const invalidStatus = {
      ...validResult(),
      acceptance: [{
        criterion: 'Cite an official source.',
        status: 'complete',
        note: 'Done.',
      }],
    };

    expect(researchResultSchema.safeParse(invalidTimestamp).success).toBe(false);
    expect(researchResultSchema.safeParse(invalidStatus).success).toBe(false);
  });
});

describe('researchResultJsonSchema', () => {
  it('exports a strict JSON Schema suitable for Claude Code --json-schema', () => {
    expect(researchResultJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'summary',
        'findings',
        'evidence',
        'uncertainties',
        'recommendedActions',
        'acceptance',
      ]),
      properties: {
        findings: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', pattern: '\\S' },
        },
        evidence: {
          type: 'array',
          items: {
            properties: {
              url: { type: 'string', pattern: '^https:\\/\\/' },
            },
          },
        },
        acceptance: { type: 'array', minItems: 1 },
      },
    });
  });
});

describe('driverResultSchema', () => {
  it('accepts a concrete user decision request', () => {
    expect(driverResultSchema.parse({
      kind: 'decision_request',
      decisionRequestId: 'decision-001',
      question: 'Which documented option should be used?',
      options: [
        { id: 'a', label: 'Use option A' },
        { id: 'b', label: 'Use option B' },
      ],
    })).toMatchObject({ kind: 'decision_request' });
  });

  it('rejects duplicate option IDs', () => {
    expect(driverResultSchema.safeParse({
      kind: 'decision_request',
      decisionRequestId: 'decision-001',
      question: 'Which documented option should be used?',
      options: [
        { id: 'same', label: 'Use option A' },
        { id: 'same', label: 'Use option B' },
      ],
    }).success).toBe(false);
  });
});

describe('driverResultJsonSchema', () => {
  it('exports both research and decision-request branches', () => {
    const branches = (driverResultJsonSchema as { anyOf: Array<{
      properties?: Record<string, unknown>;
    }> }).anyOf;
    expect(branches).toHaveLength(2);
    expect(branches.some((branch) => (
      (branch.properties?.kind as { const?: unknown } | undefined)?.const
      === 'decision_request'
    ))).toBe(true);
    expect(branches.some((branch) => branch.properties?.summary !== undefined))
      .toBe(true);
  });
});
