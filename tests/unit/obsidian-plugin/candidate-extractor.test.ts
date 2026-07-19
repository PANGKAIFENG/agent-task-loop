import { describe, expect, it, vi } from 'vitest';

import {
  batchCandidateSourceRecords,
  extractTaskCandidates,
} from '../../../src/obsidian-plugin/candidate-extractor.js';
import type { SyncSourceRecord } from '../../../src/obsidian-plugin/sync-source-reader.js';
import type {
  ClaudeStructuredExecutor,
  ClaudeStructuredInput,
} from '../../../src/runner/claude-driver.js';

function record(index: number, content = `#待办 调研工具 ${index}`): SyncSourceRecord {
  return {
    fingerprint: index.toString(16).padStart(64, '0'),
    sourceDate: '2026-07-17',
    sourceNote: `笔记同步助手/2026-07-17/note-${index}.md`,
    recordedAt: null,
    content,
  };
}

function fakeExecutor(outputs: unknown[]): ClaudeStructuredExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async <T>(input: ClaudeStructuredInput<T>) => {
    void input;
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return output as T;
  });
  return { execute } as unknown as ClaudeStructuredExecutor & {
    execute: ReturnType<typeof vi.fn>;
  };
}

describe('batchCandidateSourceRecords', () => {
  it('limits each batch to 40 records and 60,000 source characters', () => {
    const records = Array.from({ length: 41 }, (_, index) => (
      record(index, String(index).repeat(2_000))
    ));

    const batches = batchCandidateSourceRecords(records);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(41);
    expect(batches.every((batch) => batch.length <= 40)).toBe(true);
    expect(batches.every((batch) => (
      batch.reduce((total, item) => total + item.content.length, 0) <= 60_000
    ))).toBe(true);
  });

  it('bounds a single oversized record without changing its source identity', () => {
    const [batch] = batchCandidateSourceRecords([record(1, 'x'.repeat(70_000))]);

    expect(batch?.[0]?.content).toHaveLength(60_000);
    expect(batch?.[0]?.fingerprint).toBe(record(1).fingerprint);
  });
});

describe('extractTaskCandidates', () => {
  it('builds a restricted prompt and returns validated candidates', async () => {
    const source = record(1);
    const executor = fakeExecutor([{ candidates: [{
      title: '调研工具 1',
      summary: '比较工具能力与适用场景。',
      priority: 'normal',
      topicKey: '工具-1-调研',
      sourceRecordFingerprint: source.fingerprint,
      sourceQuote: '#待办 调研工具 1',
    }] }]);

    await expect(extractTaskCandidates({ records: [source], executor }))
      .resolves.toEqual([{
        title: '调研工具 1',
        summary: '比较工具能力与适用场景。',
        priority: 'normal',
        topicKey: '工具-1-调研',
        sourceRecordFingerprint: source.fingerprint,
        sourceQuote: '#待办 调研工具 1',
      }]);

    const input = executor.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
    expect(input.prompt).toContain('明确待办');
    expect(input.prompt).toContain('纯资讯');
    expect(input.prompt).toContain('已经完成');
    expect(input.prompt).toContain('不要补充项目');
    expect(input.prompt).toContain('topicKey');
    expect(input.prompt).toContain('同一个预期成果');
    expect(input.prompt).toContain(source.fingerprint);
    expect(input.prompt).toContain(source.content);
  });

  it.each([
    ['invalid priority', {
      title: '调研工具',
      summary: '说明',
      priority: 'medium',
      topicKey: '工具调研',
      sourceRecordFingerprint: record(1).fingerprint,
      sourceQuote: '引用',
    }],
    ['unknown fingerprint', {
      title: '调研工具',
      summary: '说明',
      priority: 'normal',
      topicKey: '工具调研',
      sourceRecordFingerprint: 'f'.repeat(64),
      sourceQuote: '引用',
    }],
    ['oversized source quote', {
      title: '调研工具',
      summary: '说明',
      priority: 'normal',
      topicKey: '工具调研',
      sourceRecordFingerprint: record(1).fingerprint,
      sourceQuote: '引'.repeat(301),
    }],
  ])('rejects %s in model output', async (_label, candidate) => {
    const executor = fakeExecutor([{ candidates: [candidate] }]);

    await expect(extractTaskCandidates({ records: [record(1)], executor }))
      .rejects.toThrow();
  });

  it('propagates non-JSON structured-executor failures without partial output', async () => {
    const executor = fakeExecutor([new Error('Claude returned invalid JSON')]);

    await expect(extractTaskCandidates({ records: [record(1)], executor }))
      .rejects.toThrow('Claude returned invalid JSON');
  });

  it('rejects a source quote that is not present in the referenced record', async () => {
    const source = record(1, '#待办 调研真实存在的工具');
    const executor = fakeExecutor([{ candidates: [{
      title: '调研不存在的工具',
      summary: '模型幻觉出的候选。',
      priority: 'normal',
      topicKey: '工具调研',
      sourceRecordFingerprint: source.fingerprint,
      sourceQuote: '#待办 调研原文中不存在的工具',
    }] }]);

    await expect(extractTaskCandidates({ records: [source], executor }))
      .rejects.toThrow('source quote');
  });

  it('processes every bounded batch and combines the results', async () => {
    const sources = Array.from({ length: 41 }, (_, index) => record(index));
    const executor = fakeExecutor([
      { candidates: [] },
      { candidates: [] },
    ]);

    await expect(extractTaskCandidates({ records: sources, executor }))
      .resolves.toHaveLength(41);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('creates a deterministic fallback when the model omits an explicit hashtag todo', async () => {
    const source = record(1, '评估示例工具 #待办');
    const executor = fakeExecutor([{ candidates: [] }]);

    const result = await extractTaskCandidates({ records: [source], executor });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      priority: 'normal',
      topicKey: '评估示例工具',
      sourceRecordFingerprint: source.fingerprint,
      sourceQuote: '评估示例工具 #待办',
    });
    expect(result[0]?.title).toContain('评估示例工具');
  });

  it('removes the sync sender wrapper from a deterministic todo title', async () => {
    const source = record(1, '「测试用户:#待办 每天汇总示例榜单」');
    const executor = fakeExecutor([{ candidates: [] }]);

    const result = await extractTaskCandidates({ records: [source], executor });

    expect(result[0]?.title).toBe('每天汇总示例榜单');
    expect(result[0]?.topicKey).toBe('每天汇总示例榜单');
  });

  it('creates a deterministic fallback for an article with a todo frontmatter tag', async () => {
    const source = record(2, `---\ntags:\n  - 待办\n  - AI\n---\n# AI 不能担责\n\n文章正文。`);
    const executor = fakeExecutor([{ candidates: [] }]);

    const result = await extractTaskCandidates({ records: [source], executor });

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toContain('AI 不能担责');
    expect(result[0]?.topicKey).toBe('AI 不能担责');
    expect(result[0]?.sourceRecordFingerprint).toBe(source.fingerprint);
  });

  it('creates a deterministic fallback for an actionable link annotation', async () => {
    const source = record(3, `---\ntags:\n  - 产品思考_项目地址_评估示例连接器方案\n---\n# Example connector project\n\nhttps://example.com/connector`);
    const executor = fakeExecutor([{ candidates: [] }]);

    const result = await extractTaskCandidates({ records: [source], executor });

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toContain('示例连接器');
    expect(result[0]?.topicKey).toContain('示例连接器');
    expect(result[0]?.sourceRecordFingerprint).toBe(source.fingerprint);
  });

  it('removes the todo prefix from an actionable frontmatter tag', async () => {
    const source = record(4, `---\ntags:\n  - 待办_安装 UI 设计 skill\n---\n# UI skill`);
    const executor = fakeExecutor([{ candidates: [] }]);

    const result = await extractTaskCandidates({ records: [source], executor });

    expect(result[0]?.title).toBe('安装 UI 设计 skill');
    expect(result[0]?.topicKey).toBe('安装 UI 设计 skill');
  });
});
