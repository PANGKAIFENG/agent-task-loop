import { describe, expect, it, vi } from 'vitest';

import {
  enrichTask,
  type TaskEnrichmentInput,
} from '../../../src/obsidian-plugin/task-enrichment.js';
import type {
  ClaudeStructuredExecutor,
  ClaudeStructuredInput,
} from '../../../src/runner/claude-driver.js';

function fakeExecutor(output: unknown): ClaudeStructuredExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async <T>() => {
    if (output instanceof Error) throw output;
    return output as T;
  });
  return { execute } as unknown as ClaudeStructuredExecutor & {
    execute: ReturnType<typeof vi.fn>;
  };
}

const input: TaskEnrichmentInput = {
  title: '评估 AnySearch',
  body: '判断是否接入 StyleWork',
  userIntent: '给出明确的接入建议',
  projectName: 'StyleWork',
};

describe('enrichTask', () => {
  it('requests a restricted structured clarification and normalizes the result', async () => {
    const executor = fakeExecutor({
      objective: ' 给出 AnySearch 是否适合接入 StyleWork 的明确建议。 ',
      acceptanceCriteria: [' 对比核心能力与当前需求。 ', '说明接入风险。'],
    });

    await expect(enrichTask(executor, input)).resolves.toEqual({
      objective: '给出 AnySearch 是否适合接入 StyleWork 的明确建议。',
      acceptanceCriteria: ['对比核心能力与当前需求。', '说明接入风险。'],
    });

    const execution = executor.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
    expect(execution.timeoutMs).toBe(120_000);
    expect(execution.prompt).toContain('不要执行任务');
    expect(execution.prompt).toContain('不要读取任何文件');
    expect(execution.prompt).toContain(input.title);
    expect(execution.prompt).toContain(input.body);
    expect(execution.prompt).toContain(input.userIntent);
    expect(execution.prompt).toContain('StyleWork');
  });

  it('rejects an empty objective or more than five completion criteria', async () => {
    await expect(enrichTask(fakeExecutor({
      objective: '',
      acceptanceCriteria: Array.from({ length: 6 }, () => '完成'),
    }), input)).rejects.toThrow();
  });

  it('passes executor errors through without mutating the input', async () => {
    const before = structuredClone(input);
    const executor = fakeExecutor(new Error('Claude unavailable'));

    await expect(enrichTask(executor, input)).rejects.toThrow('Claude unavailable');
    expect(input).toEqual(before);
  });
});
