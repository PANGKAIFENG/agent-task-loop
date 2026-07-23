import { z } from 'zod';
import { posix } from 'node:path';
import { parse } from 'yaml';

import { PRIORITIES, type Priority } from '../domain/task.js';
import {
  ClaudeDriverError,
  type ClaudeStructuredExecutor,
} from '../runner/claude-driver.js';
import type { SyncSourceRecord } from './sync-source-reader.js';

const MAX_BATCH_RECORDS = 40;
const MAX_BATCH_CONTENT_CHARACTERS = 60_000;
const EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000;

export interface ExtractedCandidate {
  title: string;
  summary: string;
  priority: Priority;
  topicKey: string;
  sourceRecordFingerprint: string;
  sourceQuote: string;
}

const extractedCandidateSchema: z.ZodType<ExtractedCandidate> = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1_000),
  priority: z.enum(PRIORITIES),
  topicKey: z.string().trim().min(1).max(120),
  sourceRecordFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceQuote: z.string().trim().min(1).max(300),
}).strict();

const extractionResultSchema = z.object({
  candidates: z.array(z.unknown()),
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
          'topicKey',
          'sourceRecordFingerprint',
          'sourceQuote',
        ],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          summary: { type: 'string', minLength: 1, maxLength: 1_000 },
          priority: { type: 'string', enum: [...PRIORITIES] },
          topicKey: { type: 'string', minLength: 1, maxLength: 120 },
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
    '- topicKey 用简短稳定的中文或英文短语表示预期成果；指向同一个预期成果的记录必须使用完全相同的 topicKey。',
    '- 不确定是否属于同一成果时使用不同 topicKey，不要为了减少数量强行合并。',
    '- sourceQuote 必须是支持该行动的原文短引用，最多 300 个字符。',
    '- 没有合格候选时返回空 candidates 数组。',
    '',
    '来源记录：',
    JSON.stringify(safeRecords),
    '',
    '只返回符合 JSON Schema 的结果。',
  ].join('\n');
}

function normalizedEvidence(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function frontmatterTags(content: string): string[] {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(content.replace(/\r\n?/g, '\n'));
  if (match?.[1] === undefined) return [];
  try {
    const document = parse(match[1]) as { tags?: unknown } | null;
    const tags = document?.tags;
    if (Array.isArray(tags)) {
      return tags.filter((tag): tag is string => typeof tag === 'string');
    }
    if (typeof tags === 'string') {
      return tags.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean);
    }
  } catch {
    return [];
  }
  return [];
}

function deterministicMarker(record: SyncSourceRecord): string | null {
  const hashtagLine = record.content.split('\n').find((line) => (
    /#\s*待办(?=$|[\s#，。,:：])/u.test(line)
  ));
  if (hashtagLine !== undefined) return hashtagLine.trim();
  const tag = frontmatterTags(record.content).find((candidate) => (
    candidate.normalize('NFKC').includes('待办')
    || candidate.normalize('NFKC').startsWith('产品思考_项目地址_')
  ));
  return tag ?? null;
}

function cleanCandidateTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/^[\s「『"']*[^:：\n]{0,30}[:：]/u, '')
    .replace(/#\s*(?:待办|记录|Ai使用|AI使用)/giu, '')
    .replace(/^待办(?:[_:：\s-]+|$)/u, '')
    .replace(/^产品思考_项目地址_/u, '')
    .replace(/^#+\s*/u, '')
    .replace(/[」』"']+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function fallbackTitle(record: SyncSourceRecord, marker: string): string {
  const fromMarker = cleanCandidateTitle(marker);
  if (fromMarker !== '' && fromMarker !== '待办') return fromMarker.slice(0, 200);
  const heading = record.content.match(/^#\s+(.+)$/mu)?.[1];
  const sourceTitle = heading === undefined
    ? posix.basename(record.sourceNote, posix.extname(record.sourceNote))
    : heading;
  return `跟进：${cleanCandidateTitle(sourceTitle)}`.slice(0, 200);
}

function fallbackCandidate(
  record: SyncSourceRecord,
  marker: string,
): ExtractedCandidate {
  const sourceQuote = marker.slice(0, 300);
  const title = fallbackTitle(record, marker);
  return {
    title,
    summary: '来源已明确标记为待办，等待确认后进入 Inbox。',
    priority: 'normal',
    topicKey: title.replace(/^跟进：/u, '').slice(0, 120),
    sourceRecordFingerprint: record.fingerprint,
    sourceQuote,
  };
}

export async function extractTaskCandidates(input: {
  records: readonly SyncSourceRecord[];
  executor: ClaudeStructuredExecutor;
}): Promise<ExtractedCandidate[]> {
  const candidates: ExtractedCandidate[] = [];
  for (const batch of batchCandidateSourceRecords(input.records)) {
    const sourceByFingerprint = new Map(batch.map((record) => (
      [record.fingerprint, record] as const
    )));
    const execution = {
      prompt: extractionPrompt(batch),
      jsonSchema: candidateExtractionJsonSchema,
      schema: extractionResultSchema,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    };
    let raw: unknown;
    try {
      raw = await input.executor.execute(execution);
    } catch (error) {
      if (!(error instanceof ClaudeDriverError) || error.code !== 'claude_timeout') {
        throw error;
      }
      raw = await input.executor.execute(execution);
    }
    const result = extractionResultSchema.parse(raw);
    const represented = new Set<string>();
    for (const rawCandidate of result.candidates) {
      const parsedCandidate = extractedCandidateSchema.safeParse(rawCandidate);
      if (!parsedCandidate.success) continue;
      const candidate = parsedCandidate.data;
      const source = sourceByFingerprint.get(candidate.sourceRecordFingerprint);
      if (source === undefined) continue;
      if (!normalizedEvidence(source.content).includes(
        normalizedEvidence(candidate.sourceQuote),
      )) {
        continue;
      }
      candidates.push(candidate);
      represented.add(candidate.sourceRecordFingerprint);
    }
    for (const record of batch) {
      const marker = deterministicMarker(record);
      if (marker !== null && !represented.has(record.fingerprint)) {
        candidates.push(fallbackCandidate(record, marker));
      }
    }
  }
  return candidates;
}
