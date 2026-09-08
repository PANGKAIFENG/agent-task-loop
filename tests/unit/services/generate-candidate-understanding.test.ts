import { describe, expect, it, vi } from 'vitest';

import { generateCandidateUnderstanding } from '../../../src/services/generate-candidate-understanding.js';
import type {
  ClaudeStructuredExecutor,
  ClaudeStructuredInput,
} from '../../../src/runner/claude-driver.js';

function executor(output: unknown): ClaudeStructuredExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async <T>() => output as T);
  return { execute } as unknown as ClaudeStructuredExecutor & {
    execute: ReturnType<typeof vi.fn>;
  };
}

describe('generateCandidateUnderstanding', () => {
  it('sends only bounded candidate evidence and returns artifact and task type suggestions', async () => {
    const model = executor({
      objective: '形成可评审的实现判断',
      nextAction: '核对当前接口与测试',
      expectedArtifact: '本地候选 commit 与 Handoff',
      completionCriteria: 'Node 24 门禁通过',
      taskType: 'code_change',
    });
    const secretBody = `FULL_BODY_MUST_NOT_APPEAR_${'x'.repeat(10_000)}`;
    const result = await generateCandidateUnderstanding(model, {
      task: {
        taskId: 'task-synthetic-generation',
        title: `实现候选理解 ${'题'.repeat(700)}`,
        body: secretBody,
        taskType: 'development',
        contextRefs: ['repo:personal-ai-workbench'],
        possibleDuplicateIds: [],
      },
      sourceRefs: [{
        sourceRefId: 'source-generation',
        sourceType: 'synthetic_fixture',
        sourceKey: 'synthetic:generation',
        sourceNote: 'fixtures/generation.md',
        anchor: '#bounded',
        quote: `有限引用 ${'q'.repeat(500)}`,
        capturedAt: '2026-08-22T02:00:00.000Z',
        lastVerifiedAt: '2026-08-22T02:01:00.000Z',
        status: 'available',
        failureReason: null,
        parentContext: `批量共同上下文 ${'p'.repeat(1_500)}`,
        lastVerifiedEvidence: null,
      }],
      project: {
        name: `个人工作台 ${'n'.repeat(700)}`,
        description: `项目说明 ${'d'.repeat(3_000)}`,
      },
    });

    expect(result.taskType).toBe('code_change');
    expect(result.suggestions.find(({ field }) => field === 'expected_artifact'))
      .toMatchObject({ suggestedValue: '本地候选 commit 与 Handoff' });

    const execution = model.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
    expect(execution.prompt).not.toContain('FULL_BODY_MUST_NOT_APPEAR');
    expect(execution.prompt).toContain('有限引用');
    expect(execution.prompt).toContain('批量共同上下文');
    expect(execution.prompt.length).toBeLessThan(6_000);
    expect(execution.timeoutMs).toBe(120_000);
  });

  it('does not mutate the task input when the model is unavailable', async () => {
    const model = executor(null);
    model.execute.mockRejectedValue(new Error('model unavailable'));
    const input = {
      task: {
        taskId: 'task-synthetic-ai-unavailable',
        title: '人工仍可编辑',
        body: '原始正文',
        taskType: 'research' as const,
        contextRefs: [],
        possibleDuplicateIds: [],
      },
      sourceRefs: [],
      project: null,
    };
    const before = structuredClone(input);

    await expect(generateCandidateUnderstanding(model, input))
      .rejects.toThrow('model unavailable');
    expect(input).toEqual(before);
  });
});
