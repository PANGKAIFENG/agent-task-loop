import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { PRIORITIES, type Priority } from '../domain/task.js';
import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';
import {
  extractMeetingTranscript,
  meetingAnalysisInputHash,
  MEETING_ANALYSIS_END,
  MEETING_ANALYSIS_START,
  parseMeetingAttachments,
  type MeetingType,
} from './meeting-note.js';
import {
  buildMeetingAttachmentPath,
  type MeetingAttachment,
} from './meeting-attachment.js';
import {
  parseMeetingDocument,
  type MeetingDocumentParser,
} from './meeting-document-parser.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../storage/frontmatter.js';

const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_MEETING_TRANSCRIPT_CHARACTERS = 100_000;
const analysesInFlight = new Set<string>();

export class MeetingAnalysisAlreadyExistsError extends Error {
  constructor() {
    super('这份会议笔记已经完成分析，现有分析已保留');
    this.name = 'MeetingAnalysisAlreadyExistsError';
  }
}

export class MeetingAnalysisInProgressError extends Error {
  constructor() {
    super('这份会议笔记正在分析，请稍候');
    this.name = 'MeetingAnalysisInProgressError';
  }
}

export class MeetingAnalysisRetryRequiredError extends Error {
  constructor() {
    super('现有分析需要由用户明确选择重新分析');
    this.name = 'MeetingAnalysisRetryRequiredError';
  }
}

export interface MeetingAnalysisMetadata {
  title: string;
  meetingType: MeetingType;
  meetingDate: string;
  participants: readonly string[];
}

export interface MeetingTaskCandidate {
  title: string;
  explanation: string;
  priority: Priority;
  sourceName: string;
  sourceQuote: string;
}

export interface MeetingAnalysisResult {
  summary: string;
  conclusions: string[];
  taskCandidates: MeetingTaskCandidate[];
}

export interface MeetingAnalysisSource {
  name: string;
  text: string;
}

export type MeetingAnalysisStatus = 'pending' | 'failed' | 'ready_for_confirm' | 'stale';

export interface MeetingAnalysisView {
  status: MeetingAnalysisStatus;
  result: MeetingAnalysisResult | null;
  inputHash: string | null;
  model: string | null;
  updatedAt: string | null;
}

const meetingTaskCandidateSchema: z.ZodType<MeetingTaskCandidate> = z.object({
  title: z.string().trim().min(1).max(200),
  explanation: z.string().trim().min(1).max(1_000),
  priority: z.enum(PRIORITIES),
  sourceName: z.string().trim().min(1).max(300),
  sourceQuote: z.string().trim().min(1).max(1_000),
}).strict();

const meetingAnalysisSchema: z.ZodType<MeetingAnalysisResult> = z.object({
  summary: z.string().trim().min(1).max(4_000),
  conclusions: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
  taskCandidates: z.array(meetingTaskCandidateSchema).max(50),
}).strict();

export const meetingAnalysisJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'conclusions', 'taskCandidates'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 4_000 },
    conclusions: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 2_000 },
    },
    taskCandidates: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'explanation', 'priority', 'sourceName', 'sourceQuote'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          explanation: { type: 'string', minLength: 1, maxLength: 1_000 },
          priority: { type: 'string', enum: [...PRIORITIES] },
          sourceName: { type: 'string', minLength: 1, maxLength: 300 },
          sourceQuote: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
    },
  },
};

function analysisPrompt(
  metadata: MeetingAnalysisMetadata,
  sources: readonly MeetingAnalysisSource[],
): string {
  return [
    '你是一个只读的会议整理助手，只能根据给定会议信息和听记返回严格 JSON。',
    '不要调用工具，不要读取文件，不要访问网络，不要执行或创建任务。',
    '',
    '分析规则：',
    '- summary 简洁概括会议讨论和结果。',
    '- conclusions 只记录提供来源能够支持的明确结论。',
    '- taskCandidates 只提取尚未完成的明确行动项；没有时返回空数组。',
    '- 每个候选必须返回 sourceName，且 sourceQuote 必须逐字来自该名称对应的来源。',
    '- 不要补充来源中不存在的负责人、截止时间、结论或行动。',
    '',
    '会议信息：',
    JSON.stringify({
      title: metadata.title,
      meetingType: metadata.meetingType,
      meetingDate: metadata.meetingDate,
      participants: metadata.participants,
    }),
    '',
    '分析来源：',
    ...sources.flatMap((source, index) => [
      `来源 ${index + 1} 名称：${JSON.stringify(source.name)}`,
      '来源正文：',
      source.text,
      '',
    ]),
    '',
    '只返回符合 JSON Schema 的结果。',
  ].join('\n');
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

export async function analyzeMeetingSources(input: {
  metadata: MeetingAnalysisMetadata;
  sources: readonly MeetingAnalysisSource[];
  executor: ClaudeStructuredExecutor;
}): Promise<MeetingAnalysisResult> {
  if (input.sources.length === 0 || input.sources[0]?.text.trim() === '') {
    throw new Error('会议听记不能为空');
  }
  const sourceMap = new Map<string, string>();
  for (const source of input.sources) {
    const name = source.name.trim();
    if (name === '' || source.text.trim() === '') throw new Error('会议分析来源无效');
    if (sourceMap.has(name)) throw new Error(`会议分析来源名称重复：${name}`);
    sourceMap.set(name, source.text);
  }
  const totalCharacters = [...sourceMap.values()].reduce((sum, text) => sum + text.length, 0);
  if (totalCharacters > MAX_MEETING_TRANSCRIPT_CHARACTERS) {
    throw new Error('会议分析资料过长，请减少资料后分析');
  }

  const raw = await input.executor.execute({
    prompt: analysisPrompt(input.metadata, input.sources),
    jsonSchema: meetingAnalysisJsonSchema,
    schema: meetingAnalysisSchema,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
  const parsed = meetingAnalysisSchema.parse(raw);
  const seenTitles = new Set<string>();
  const taskCandidates = parsed.taskCandidates.filter((candidate) => {
    const source = sourceMap.get(candidate.sourceName);
    if (source === undefined) {
      throw new Error(`候选任务来源不存在：${candidate.sourceName}`);
    }
    if (!source.includes(candidate.sourceQuote)) {
      throw new Error(`候选任务引文在指定来源中不存在（原文中不存在）：${candidate.title}`);
    }
    const title = normalizedTitle(candidate.title);
    if (seenTitles.has(title)) return false;
    seenTitles.add(title);
    return true;
  });
  return { ...parsed, taskCandidates };
}

export async function analyzeMeetingTranscript(input: {
  metadata: MeetingAnalysisMetadata;
  transcript: string;
  executor: ClaudeStructuredExecutor;
}): Promise<MeetingAnalysisResult> {
  return analyzeMeetingSources({
    metadata: input.metadata,
    sources: [{ name: '会议听记', text: input.transcript }],
    executor: input.executor,
  });
}

export interface MeetingAnalysisFileSystem {
  read(path: string): Promise<string>;
  readBinary?(path: string): Promise<Uint8Array>;
  process(path: string, transform: (content: string) => string): Promise<string>;
}

function analysisMetadata(data: Record<string, unknown>): MeetingAnalysisMetadata {
  const schema = z.object({
    type: z.literal('meeting'),
    title: z.string().trim().min(1),
    meeting_type: z.enum(['interview', 'discussion', 'review', 'other']),
    meeting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    participants: z.array(z.string()),
  }).passthrough();
  const parsed = schema.parse(data);
  return {
    title: parsed.title,
    meetingType: parsed.meeting_type,
    meetingDate: parsed.meeting_date,
    participants: parsed.participants,
  };
}

function safeAnalysisText(value: string): string {
  return value.replaceAll('<!-- ATL_MEETING_', '&lt;!-- ATL_MEETING_');
}

function renderAnalysis(result: MeetingAnalysisResult): string {
  const lines = [
    '## AI 分析',
    '',
    '### 摘要',
    '',
    safeAnalysisText(result.summary),
    '',
    '### 结论',
    '',
    ...result.conclusions.map((item) => `- ${safeAnalysisText(item)}`),
    '',
    '### 待办候选',
    '',
  ];
  if (result.taskCandidates.length === 0) {
    lines.push('本次分析未发现明确待办。');
  } else {
    result.taskCandidates.forEach((candidate, index) => {
      lines.push(
        `${index + 1}. **${safeAnalysisText(candidate.title)}**`,
        `   - 说明：${safeAnalysisText(candidate.explanation)}`,
        `   - 优先级：${candidate.priority}`,
        `   - 来源：${safeAnalysisText(candidate.sourceName)}`,
        `   - 原文：${safeAnalysisText(candidate.sourceQuote)}`,
      );
    });
  }
  const snapshot = Buffer.from(JSON.stringify({ version: 1, result }), 'utf8').toString('base64');
  lines.push('', `<!-- ATL_MEETING_ANALYSIS_SNAPSHOT_V1:${snapshot} -->`);
  return lines.join('\n');
}

function replaceAnalysisRegion(body: string, content: string): string {
  const transcriptEnd = body.indexOf('<!-- ATL_MEETING_TRANSCRIPT_END -->');
  const start = body.indexOf(MEETING_ANALYSIS_START, transcriptEnd);
  const end = body.lastIndexOf(MEETING_ANALYSIS_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('会议分析区域无效');
  }
  return `${body.slice(0, start + MEETING_ANALYSIS_START.length)}\n${content}\n${body.slice(end)}`;
}

function updateAnalysisStatus(
  raw: string,
  status: MeetingAnalysisStatus,
  result?: MeetingAnalysisResult,
  metadata?: { inputHash: string; model: string; updatedAt: string },
): string {
  const document = parseTaskDocument(raw);
  const body = result === undefined
    ? document.body
    : replaceAnalysisRegion(document.body, renderAnalysis(result));
  const data: Record<string, unknown> = { ...document.data, analysis_status: status };
  if (result !== undefined && metadata !== undefined) {
    data.analysis_input_hash = metadata.inputHash;
    data.analysis_model = metadata.model;
    data.analysis_updated_at = metadata.updatedAt;
  }
  return serializeTaskDocument(data, body);
}

const SNAPSHOT_PATTERN = /<!-- ATL_MEETING_ANALYSIS_SNAPSHOT_V1:([A-Za-z0-9+/=]+) -->/u;

export function readMeetingAnalysis(
  raw: string,
  currentInputHash?: string,
): MeetingAnalysisView {
  const document = parseTaskDocument(raw);
  const rawStatus = document.data.analysis_status;
  let status: MeetingAnalysisStatus = (
    rawStatus === 'failed'
    || rawStatus === 'ready_for_confirm'
    || rawStatus === 'stale'
  ) ? rawStatus : 'pending';
  const inputHash = typeof document.data.analysis_input_hash === 'string'
    ? document.data.analysis_input_hash
    : null;
  if (currentInputHash !== undefined && inputHash !== null) {
    status = currentInputHash === inputHash
      ? (status === 'stale' ? 'ready_for_confirm' : status)
      : (status === 'ready_for_confirm' ? 'stale' : status);
  }
  let result: MeetingAnalysisResult | null = null;
  const transcriptEnd = document.body.indexOf('<!-- ATL_MEETING_TRANSCRIPT_END -->');
  const analysisStart = document.body.indexOf(MEETING_ANALYSIS_START, transcriptEnd);
  const analysisEnd = document.body.lastIndexOf(MEETING_ANALYSIS_END);
  const analysisRegion = (
    transcriptEnd !== -1
    && analysisStart !== -1
    && analysisEnd > analysisStart
  )
    ? document.body.slice(analysisStart + MEETING_ANALYSIS_START.length, analysisEnd)
    : '';
  const encoded = SNAPSHOT_PATTERN.exec(analysisRegion)?.[1];
  if (encoded !== undefined) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      result = z.object({
        version: z.literal(1),
        result: meetingAnalysisSchema,
      }).strict().parse(decoded).result;
    } catch {
      result = null;
    }
  }
  if (status === 'ready_for_confirm' && result === null) {
    status = 'stale';
  }
  return {
    status,
    result,
    inputHash,
    model: typeof document.data.analysis_model === 'string'
      ? document.data.analysis_model
      : null,
    updatedAt: typeof document.data.analysis_updated_at === 'string'
      ? document.data.analysis_updated_at
      : null,
  };
}

function contentId(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function uniqueSourceName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let suffix = 2;
  while (used.has(`${name} (${suffix})`)) suffix += 1;
  const unique = `${name} (${suffix})`;
  used.add(unique);
  return unique;
}

interface LoadedAnalysisInput {
  metadata: MeetingAnalysisMetadata;
  sources: MeetingAnalysisSource[];
  inputHash: string;
}

interface FingerprintedAnalysisInput {
  metadata: MeetingAnalysisMetadata;
  transcript: string;
  selectedReferences: Array<{
    attachment: MeetingAttachment;
    data: Uint8Array;
  }>;
  inputHash: string;
}

async function fingerprintAnalysisInput(
  raw: string,
  path: string,
  fileSystem: MeetingAnalysisFileSystem,
): Promise<FingerprintedAnalysisInput> {
  const document = parseTaskDocument(raw);
  const metadata = analysisMetadata(document.data);
  const transcript = extractMeetingTranscript(raw);
  const attachments = parseMeetingAttachments(document.data);
  const eventKeyHash = typeof document.data.dingtalk_event_key_hash === 'string'
    ? document.data.dingtalk_event_key_hash
    : '';
  const fingerprintAttachments: MeetingAttachment[] = [];
  const selectedReferences: FingerprintedAnalysisInput['selectedReferences'] = [];
  for (const attachment of attachments) {
    if (
      buildMeetingAttachmentPath(path, eventKeyHash, attachment) !== attachment.path
    ) throw new Error(`会议附件路径无效：${attachment.name}`);
    if (!attachment.analyzable || !attachment.includeInAnalysis) {
      fingerprintAttachments.push(attachment);
      continue;
    }
    if (fileSystem.readBinary === undefined) {
      throw new Error('当前 Vault 无法读取会议附件');
    }
    const data = await fileSystem.readBinary(attachment.path);
    const currentAttachment = { ...attachment, id: contentId(data) };
    fingerprintAttachments.push(currentAttachment);
    if (attachment.role === 'reference') {
      selectedReferences.push({ attachment, data });
    }
  }
  return {
    metadata,
    transcript,
    selectedReferences,
    inputHash: meetingAnalysisInputHash({
      source: {
        eventPath: '',
        eventKeyHash,
        title: metadata.title,
        scheduled: metadata.meetingDate,
        meetingDate: metadata.meetingDate,
      },
      meetingType: metadata.meetingType,
      participants: metadata.participants,
      transcript,
      attachments: fingerprintAttachments,
    }),
  };
}

async function loadAnalysisInput(
  raw: string,
  path: string,
  fileSystem: MeetingAnalysisFileSystem,
  parser: MeetingDocumentParser,
): Promise<LoadedAnalysisInput> {
  const fingerprint = await fingerprintAnalysisInput(raw, path, fileSystem);
  const usedSourceNames = new Set(['会议听记']);
  const sources: MeetingAnalysisSource[] = [{
    name: '会议听记',
    text: fingerprint.transcript,
  }];
  for (const { attachment, data } of fingerprint.selectedReferences) {
    sources.push({
      name: uniqueSourceName(attachment.name, usedSourceNames),
      text: await parser({ name: attachment.name, data }),
    });
  }
  return {
    metadata: fingerprint.metadata,
    sources,
    inputHash: fingerprint.inputHash,
  };
}

export async function currentMeetingAnalysisInputHashFromFiles(
  raw: string,
  path: string,
  fileSystem: MeetingAnalysisFileSystem,
): Promise<string> {
  return (await fingerprintAnalysisInput(raw, path, fileSystem)).inputHash;
}

export function currentMeetingAnalysisInputHash(raw: string): string {
  const document = parseTaskDocument(raw);
  const metadata = analysisMetadata(document.data);
  return meetingAnalysisInputHash({
    source: {
      eventPath: '',
      eventKeyHash: String(document.data.dingtalk_event_key_hash ?? ''),
      title: metadata.title,
      scheduled: metadata.meetingDate,
      meetingDate: metadata.meetingDate,
    },
    meetingType: metadata.meetingType,
    participants: metadata.participants,
    transcript: extractMeetingTranscript(raw),
    attachments: parseMeetingAttachments(document.data),
  });
}

export class MeetingAnalysisController {
  constructor(private readonly dependencies: {
    fileSystem: MeetingAnalysisFileSystem;
    executor: ClaudeStructuredExecutor;
    documentParser?: MeetingDocumentParser;
    modelLabel?: string;
    clock?: () => Date;
  }) {}

  async analyze(
    path: string,
    options: { force?: boolean } = {},
  ): Promise<MeetingAnalysisResult> {
    if (analysesInFlight.has(path)) throw new MeetingAnalysisInProgressError();
    analysesInFlight.add(path);
    try {
      const raw = await this.dependencies.fileSystem.read(path);
      const noteInputHash = currentMeetingAnalysisInputHash(raw);
      const input = await loadAnalysisInput(
        raw,
        path,
        this.dependencies.fileSystem,
        this.dependencies.documentParser ?? parseMeetingDocument,
      );
      const existing = readMeetingAnalysis(raw, input.inputHash);
      if (existing.status === 'ready_for_confirm' && options.force !== true) {
        throw new MeetingAnalysisAlreadyExistsError();
      }
      if (
        (existing.status === 'failed' || existing.status === 'stale')
        && options.force !== true
      ) throw new MeetingAnalysisRetryRequiredError();
      let result: MeetingAnalysisResult;
      try {
        result = await analyzeMeetingSources({
          metadata: input.metadata,
          sources: input.sources,
          executor: this.dependencies.executor,
        });
      } catch (error) {
        await this.dependencies.fileSystem.process(path, (latest) => (
          readMeetingAnalysis(latest).result === null
            ? updateAnalysisStatus(latest, 'failed')
            : updateAnalysisStatus(latest, 'stale')
        ));
        throw error;
      }

      let refreshedInput: LoadedAnalysisInput;
      try {
        refreshedInput = await loadAnalysisInput(
          await this.dependencies.fileSystem.read(path),
          path,
          this.dependencies.fileSystem,
          this.dependencies.documentParser ?? parseMeetingDocument,
        );
      } catch (error) {
        await this.dependencies.fileSystem.process(path, (latest) => (
          updateAnalysisStatus(
            latest,
            readMeetingAnalysis(latest).result === null ? 'failed' : 'stale',
          )
        ));
        throw error;
      }
      if (refreshedInput.inputHash !== input.inputHash) {
        await this.dependencies.fileSystem.process(path, (latest) => (
          updateAnalysisStatus(
            latest,
            readMeetingAnalysis(latest).result === null ? 'failed' : 'stale',
          )
        ));
        throw new Error('会议分析输入在处理期间发生变化，请重新分析');
      }

      let persistenceError: Error | null = null;
      await this.dependencies.fileSystem.process(path, (latest) => {
        const latestAnalysis = readMeetingAnalysis(latest);
        if (
          latestAnalysis.status === 'ready_for_confirm'
          && options.force !== true
        ) {
          persistenceError = new MeetingAnalysisAlreadyExistsError();
          return latest;
        }
        if (currentMeetingAnalysisInputHash(latest) !== noteInputHash) {
          persistenceError = new Error('会议分析输入在处理期间发生变化，请重新分析');
          return updateAnalysisStatus(
            latest,
            latestAnalysis.result === null ? 'failed' : 'stale',
          );
        }
        return updateAnalysisStatus(latest, 'ready_for_confirm', result, {
          inputHash: input.inputHash,
          model: this.dependencies.modelLabel?.trim() || 'inherit',
          updatedAt: (this.dependencies.clock?.() ?? new Date()).toISOString(),
        });
      });
      if (persistenceError !== null) throw persistenceError;
      return result;
    } finally {
      analysesInFlight.delete(path);
    }
  }
}
