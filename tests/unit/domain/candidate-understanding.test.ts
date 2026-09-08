import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCandidateUnderstanding,
  candidateSourceRefSchema,
  candidateUnderstandingSchema,
  reviseCandidateUnderstanding,
  type CandidateUnderstandingInput,
} from '../../../src/domain/candidate-understanding.js';

async function fixture(name: string): Promise<CandidateUnderstandingInput> {
  const raw = await readFile(join(
    process.cwd(),
    'tests',
    'fixtures',
    'candidate-understanding',
    name,
  ), 'utf8');
  return JSON.parse(raw) as CandidateUnderstandingInput;
}

function field(
  understanding: ReturnType<typeof buildCandidateUnderstanding>,
  name: string,
) {
  const suggestion = understanding.suggestions.find((candidate) => candidate.field === name);
  expect(suggestion).toBeDefined();
  return suggestion!;
}

describe('buildCandidateUnderstanding', () => {
  it('turns one explicit research source into bounded attributed editable fields', async () => {
    const understanding = buildCandidateUnderstanding(
      await fixture('explicit-research.json'),
    );

    expect(understanding.taskType).toBe('research');
    expect(understanding.generationId).toMatch(/^candidate-[a-f0-9]{16}$/u);
    expect(understanding.suggestions.map(({ field }) => field)).toEqual([
      'title',
      'objective',
      'next_action',
      'expected_artifact',
      'completion_criteria',
    ]);
    expect(field(understanding, 'title')).toMatchObject({
      suggestedValue: '核对竞品证据',
      attribution: 'source_fact',
      sourceRefIds: ['source-synthetic-research'],
    });
    expect(field(understanding, 'objective')).toMatchObject({
      suggestedValue: '形成可评审的竞品判断',
      attribution: 'source_fact',
    });
    expect(field(understanding, 'next_action')).toMatchObject({
      suggestedValue: '整理官方页面',
      attribution: 'source_fact',
    });
    expect(field(understanding, 'expected_artifact')).toMatchObject({
      suggestedValue: '证据对照表',
      attribution: 'source_fact',
    });
    expect(field(understanding, 'completion_criteria')).toMatchObject({
      suggestedValue: '三条声明均有结论',
      attribution: 'source_fact',
    });
    expect(understanding.sourceRefs[0]?.quote.length).toBeLessThanOrEqual(300);
    expect(understanding.sourceRefs[0]?.parentContext?.length).toBeLessThanOrEqual(1_000);
    expect(understanding.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'research_source_boundary',
        severity: 'optional',
        question: expect.stringContaining('来源范围'),
      }),
    ]));
    expect(understanding.gaps.some(({ severity }) => severity === 'blocking')).toBe(false);
  });

  it('keeps unknown batch-list fields empty and emits answerable code-change gaps', async () => {
    const understanding = buildCandidateUnderstanding(
      await fixture('batch-code-change.json'),
    );

    expect(understanding.taskType).toBe('code_change');
    expect(field(understanding, 'title')).toMatchObject({
      suggestedValue: '补齐项目 Alpha 的测试门禁',
      attribution: 'source_fact',
    });
    expect(field(understanding, 'objective')).toMatchObject({
      suggestedValue: '关闭项目 Alpha 的发布前风险',
      attribution: 'ai_inference',
      reason: expect.stringContaining('推断'),
    });
    expect(field(understanding, 'expected_artifact')).toMatchObject({
      suggestedValue: '',
      attribution: 'missing',
      sourceRefIds: [],
    });
    expect(field(understanding, 'completion_criteria')).toMatchObject({
      suggestedValue: '',
      attribution: 'missing',
    });
    expect(understanding.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'expected_artifact',
        severity: 'blocking',
        reasonCode: 'code_expected_artifact_missing',
        question: expect.stringContaining('产物'),
      }),
      expect.objectContaining({
        field: 'completion_criteria',
        severity: 'blocking',
        reasonCode: 'code_validation_missing',
        question: expect.stringContaining('验证'),
      }),
      expect.objectContaining({
        field: 'workspace',
        severity: 'blocking',
        reasonCode: 'code_workspace_missing',
        question: expect.stringContaining('工作区'),
      }),
    ]));
  });

  it('recomputes missing gaps from field edits and can restore a generated value', async () => {
    const input = await fixture('batch-code-change.json');
    const generated = buildCandidateUnderstanding(input);
    const generatedArtifact = field(generated, 'expected_artifact').suggestedValue;

    const edited = reviseCandidateUnderstanding(generated, input.task, {
      expected_artifact: '提交一个经过测试的本地代码候选。',
      completion_criteria: 'Node 24 的 typecheck、lint、test 与 build 全部通过。',
    });
    expect(field(edited, 'expected_artifact')).toMatchObject({
      suggestedValue: '提交一个经过测试的本地代码候选。',
      attribution: 'ai_inference',
    });
    expect(edited.gaps.map(({ reasonCode }) => reasonCode)).not.toContain(
      'code_validation_missing',
    );

    const restored = reviseCandidateUnderstanding(edited, input.task, {
      expected_artifact: generatedArtifact,
    });
    expect(field(restored, 'expected_artifact').suggestedValue).toBe(generatedArtifact);
    expect(generated.sourceRefs).toEqual(edited.sourceRefs);
  });

  it('rejects a non-available source ref without an explicit failure reason', () => {
    expect(() => candidateSourceRefSchema.parse({
      sourceRefId: 'source-synthetic-invalid',
      sourceType: 'synthetic_note',
      sourceKey: 'synthetic:invalid-source',
      sourceNote: 'Sources/invalid.md',
      anchor: null,
      quote: '有限合成引用',
      capturedAt: '2026-08-22T08:00:00.000Z',
      lastVerifiedAt: '2026-08-22T09:00:00.000Z',
      status: 'changed',
      failureReason: null,
      parentContext: null,
      lastVerifiedEvidence: {
        resolvedNote: 'Sources/invalid.md',
        checkedCharacters: 20,
        quoteMatched: false,
        truncated: false,
      },
    })).toThrow();
  });

  it('does not call a captured title a source fact when bounded evidence does not support it', () => {
    const understanding = buildCandidateUnderstanding({
      task: {
        taskId: 'task-synthetic-unsupported-title',
        title: '编写完全不同的发布说明',
        body: '原始正文不参与归因。',
        taskType: 'research',
      },
      sourceRefs: [{
        sourceRefId: 'source-synthetic-unrelated',
        sourceType: 'synthetic_note',
        sourceKey: 'synthetic:unrelated',
        sourceNote: 'Sources/unrelated.md',
        anchor: 'line:2',
        quote: '核对季度公开定价页面。',
        capturedAt: '2026-08-22T08:00:00.000Z',
        lastVerifiedAt: '2026-08-22T09:00:00.000Z',
        status: 'available',
        failureReason: null,
        parentContext: '公开材料清单，不包含发布说明。',
        lastVerifiedEvidence: {
          resolvedNote: 'Sources/unrelated.md',
          checkedCharacters: 40,
          quoteMatched: true,
          truncated: false,
        },
      }],
    });

    expect(field(understanding, 'title')).toMatchObject({
      suggestedValue: '编写完全不同的发布说明',
      attribution: 'ai_inference',
      sourceRefIds: [],
      reason: expect.stringContaining('推断'),
    });
  });

  it('rejects source facts without a supporting ref in the same understanding', async () => {
    const understanding = buildCandidateUnderstanding(await fixture('explicit-research.json'));
    const title = understanding.suggestions.find(({ field }) => field === 'title')!;

    expect(() => candidateUnderstandingSchema.parse({
      ...understanding,
      suggestions: understanding.suggestions.map((suggestion) => (
        suggestion.field === 'title'
          ? { ...title, sourceRefIds: [] }
          : suggestion
      )),
    })).toThrow();
    expect(() => candidateUnderstandingSchema.parse({
      ...understanding,
      suggestions: understanding.suggestions.map((suggestion) => (
        suggestion.field === 'title'
          ? { ...title, sourceRefIds: ['source-not-in-understanding'] }
          : suggestion
      )),
    })).toThrow();
  });
});
