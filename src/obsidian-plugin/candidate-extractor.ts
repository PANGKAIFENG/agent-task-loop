import { z } from 'zod';

import { PRIORITIES, type Priority } from '../domain/task.js';
import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';
import type { SyncSourceRecord } from './sync-source-reader.js';

const MAX_BATCH_RECORDS = 40;
const MAX_BATCH_CONTENT_CHARACTERS = 60_000;
const EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface ExtractedCandidate {
  title: string;
  summary: string;
  priority: Priority;
  sourceRecordFingerprint: string;
  sourceQuote: string;
}

const extractedCandidateSchema: z.ZodType<ExtractedCandidate> = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1_000),
  priority: z.enum(PRIORITIES),
  sourceRecordFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceQuote: z.string().trim().min(1).max(300),
}).strict();

const extractionResultSchema = z.object({
  candidates: z.array(extractedCandidateSchema),
}).strict();

export const candidateExtractionJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'summary',
          'priority',
          'sourceRecordFingerprint',
          'sourceQuote',
        ],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          summary: { type: 'string', minLength: 1, maxLength: 1_000 },
          priority: { type: 'string', enum: [...PRIORITIES] },
          sourceRecordFingerprint: {
            type: 'string',
            pattern: '^[a-f0-9]{64}$',
          },
          sourceQuote: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  },
};

export function batchCandidateSourceRecords(
  records: readonly SyncSourceRecord[],
): SyncSourceRecord[][] {
  const batches: SyncSourceRecord[][] = [];
  let batch: SyncSourceRecord[] = [];
  let contentCharacters = 0;

  for (const record of records) {
    const bounded = record.content.length > MAX_BATCH_CONTENT_CHARACTERS
      ? { ...record, content: record.content.slice(0, MAX_BATCH_CONTENT_CHARACTERS) }
      : { ...record };
    const nextCharacters = bounded.content.length;
    if (
      batch.length > 0
      && (
        batch.length >= MAX_BATCH_RECORDS
        || contentCharacters + nextCharacters > MAX_BATCH_CONTENT_CHARACTERS
      )
    ) {
      batches.push(batch);
      batch = [];
      contentCharacters = 0;
    }
    batch.push(bounded);
    contentCharacters += nextCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function extractionPrompt(records: readonly SyncSourceRecord[]): string {
  const safeRecords = records.map((record) => ({
    fingerprint: record.fingerprint,
    sourceDate: record.sourceDate,
    recordedAt: record.recordedAt,
    content: record.content,
  }));
  return [
    '你正在执行只读的待办候选提取，只能根据给定来源文本返回严格 JSON。',
    '',
    '提取规则：',
    '- 提取明确待办，或有明确行动意图且尚未完成的想法。',
    '- 排除纯资讯、情绪记录、已经完成的行动和没有行动意图的观察。',
    '- 不要补充项目、任务目标、验收标准、执行权限或来源中不存在的事实。',
    '- 每个候选必须引用一条给定记录的 fingerprint。',
    '- sourceQuote 必须是支持该行动的原文短引用，最多 300 个字符。',
    '- 没有合格候选时返回空 candidates 数组。',
    '',
    '来源记录：',
    JSON.stringify(safeRecords),
    '',
    '只返回符合 JSON Schema 的结果。',
  ].join('\n');
}

export async function extractTaskCandidates(input: {
  records: readonly SyncSourceRecord[];
  executor: ClaudeStructuredExecutor;
}): Promise<ExtractedCandidate[]> {
  const candidates: ExtractedCandidate[] = [];
  for (const batch of batchCandidateSourceRecords(input.records)) {
    const allowedFingerprints = new Set(batch.map((record) => record.fingerprint));
    const raw = await input.executor.execute({
      prompt: extractionPrompt(batch),
      jsonSchema: candidateExtractionJsonSchema,
      schema: extractionResultSchema,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    });
    const result = extractionResultSchema.parse(raw);
    for (const candidate of result.candidates) {
      if (!allowedFingerprints.has(candidate.sourceRecordFingerprint)) {
        throw new Error('Claude returned a candidate for an unknown source record');
      }
      candidates.push(candidate);
    }
  }
  return candidates;
}
