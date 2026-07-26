import { describe, expect, it, vi } from 'vitest';

import {
  generateTaskBrief,
  type TaskBriefGenerationInput,
} from '../../../src/obsidian-plugin/task-brief-generation.js';
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

const input: TaskBriefGenerationInput = {
  title: '梳理任务面板字段',
  body: '需要明确一期哪些字段保留。',
  project: {
    name: '个人工作台',
    description: '用于管理个人任务与复盘。',
  },
};

describe('generateTaskBrief', () => {
  it('generates the three Phase 1 brief fields from bounded task context', async () => {
    const executor = fakeExecutor({
      objective: ' 明确一期任务面板的核心字段。 ',
      nextAction: ' 对照现有字段逐项判断。 ',
      completionCriteria: ' 形成可评审的字段清单。 ',
    });

    await expect(generateTaskBrief(executor, input)).resolves.toEqual({
      objective: '明确一期任务面板的核心字段。',
      nextAction: '对照现有字段逐项判断。',
      completionCriteria: '形成可评审的字段清单。',
    });

    const execution = executor.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
    expect(execution.timeoutMs).toBe(120_000);
    expect(execution.prompt).toContain('不要执行任务');
    expect(execution.prompt).toContain('不要调用工具');
    expect(execution.prompt).toContain(input.title);
    expect(execution.prompt).toContain(input.body);
    expect(execution.prompt).toContain('个人工作台');
    expect(execution.prompt).toContain('用于管理个人任务与复盘');
  });

  it('passes model failure through and leaves manual editing to the modal', async () => {
    const executor = fakeExecutor(new Error('model unavailable'));

    await expect(generateTaskBrief(executor, input)).rejects.toThrow('model unavailable');
  });
});
