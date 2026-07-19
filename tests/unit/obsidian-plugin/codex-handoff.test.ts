import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { formatCodexHandoff } from '../../../src/obsidian-plugin/codex-handoff.js';

const task: Task = {
  schemaVersion: 1,
  taskId: 'task-example',
  title: '评估 AnySearch',
  body: '判断是否接入 StyleWork。',
  status: 'ready',
  reviewState: 'confirmed',
  projectId: 'stylework',
  taskType: 'research',
  objective: '给出明确的接入建议。',
  acceptanceCriteria: ['对比能力。', '说明风险。'],
  autoExecutable: false,
  permissionProfile: null,
  origin: 'sync_assistant',
  sourceDate: '2026-07-19',
  sourceNote: '笔记同步助手/2026-07-19/想法.md',
  sourceQuote: '调研 AnySearch 是否值得接入。',
  sourceKey: 'synthetic:handoff',
  possibleDuplicateIds: [],
  priority: 'normal',
  attempts: 0,
  claim: null,
  artifactRefs: [],
  reviewFeedback: null,
  readyAt: '2026-07-19T10:00:00.000Z',
  createdAt: '2026-07-19T09:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
};

describe('formatCodexHandoff', () => {
  it('formats the absolute file path and structured task context', () => {
    const result = formatCodexHandoff(
      task,
      '/vault/10_Tasks/Active/stylework/task-example.md',
    );

    expect(result).toContain('任务文件：/vault/10_Tasks/Active/stylework/task-example.md');
    expect(result).toContain('任务：评估 AnySearch');
    expect(result).toContain('项目：stylework');
    expect(result).toContain('目标：给出明确的接入建议。');
    expect(result).toContain('- 对比能力。');
    expect(result).toContain('状态：ready');
    expect(result).toContain('来源摘要：调研 AnySearch 是否值得接入。');
  });

  it('omits missing source paths and does not mutate the task', () => {
    const withoutSource = { ...task, sourceNote: null, sourceQuote: null };
    const before = structuredClone(withoutSource);

    const result = formatCodexHandoff(withoutSource, '/vault/task-example.md');

    expect(result).not.toContain('来源笔记');
    expect(result).not.toContain('来源摘要');
    expect(withoutSource).toEqual(before);
  });
});
