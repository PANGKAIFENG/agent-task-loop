import { describe, expect, it } from 'vitest';

import {
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
