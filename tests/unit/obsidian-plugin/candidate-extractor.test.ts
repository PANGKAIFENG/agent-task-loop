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
      sourceRecordFingerprint: source.fingerprint,
      sourceQuote: '#待办 调研工具 1',
    }] }]);

    await expect(extractTaskCandidates({ records: [source], executor }))
      .resolves.toEqual([{
        title: '调研工具 1',
        summary: '比较工具能力与适用场景。',
        priority: 'normal',
        sourceRecordFingerprint: source.fingerprint,
        sourceQuote: '#待办 调研工具 1',
      }]);

    const input = executor.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
    expect(input.prompt).toContain('明确待办');
    expect(input.prompt).toContain('纯资讯');
    expect(input.prompt).toContain('已经完成');
    expect(input.prompt).toContain('不要补充项目');
    expect(input.prompt).toContain(source.fingerprint);
    expect(input.prompt).toContain(source.content);
  });

  it.each([
    ['invalid priority', {
      title: '调研工具',
      summary: '说明',
      priority: 'medium',
      sourceRecordFingerprint: record(1).fingerprint,
      sourceQuote: '引用',
    }],
    ['unknown fingerprint', {
      title: '调研工具',
      summary: '说明',
      priority: 'normal',
      sourceRecordFingerprint: 'f'.repeat(64),
      sourceQuote: '引用',
    }],
    ['oversized source quote', {
      title: '调研工具',
      summary: '说明',
      priority: 'normal',
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

  it('processes every bounded batch and combines the results', async () => {
    const sources = Array.from({ length: 41 }, (_, index) => record(index));
    const executor = fakeExecutor([
      { candidates: [] },
      { candidates: [] },
    ]);

    await expect(extractTaskCandidates({ records: sources, executor }))
      .resolves.toEqual([]);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });
});
