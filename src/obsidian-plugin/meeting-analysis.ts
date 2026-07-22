import { z } from 'zod';

import { PRIORITIES, type Priority } from '../domain/task.js';
import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';
import {
  extractMeetingTranscript,
  MEETING_ANALYSIS_END,
  MEETING_ANALYSIS_START,
  type MeetingType,
} from './meeting-note.js';
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
  sourceQuote: string;
}

export interface MeetingAnalysisResult {
  summary: string;
  conclusions: string[];
  taskCandidates: MeetingTaskCandidate[];
}

const meetingTaskCandidateSchema: z.ZodType<MeetingTaskCandidate> = z.object({
  title: z.string().trim().min(1).max(200),
  explanation: z.string().trim().min(1).max(1_000),
  priority: z.enum(PRIORITIES),
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
        required: ['title', 'explanation', 'priority', 'sourceQuote'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          explanation: { type: 'string', minLength: 1, maxLength: 1_000 },
          priority: { type: 'string', enum: [...PRIORITIES] },
          sourceQuote: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
      },
    },
  },
};

function analysisPrompt(
  metadata: MeetingAnalysisMetadata,
  transcript: string,
): string {
  return [
    '你是一个只读的会议整理助手，只能根据给定会议信息和听记返回严格 JSON。',
    '不要调用工具，不要读取文件，不要访问网络，不要执行或创建任务。',
    '',
    '分析规则：',
    '- summary 简洁概括会议讨论和结果。',
    '- conclusions 只记录听记能够支持的明确结论。',
    '- taskCandidates 只提取尚未完成的明确行动项；没有时返回空数组。',
    '- 每个候选的 sourceQuote 必须逐字来自会议听记。',
    '- 不要补充听记中不存在的负责人、截止时间、结论或行动。',
    '',
    '会议信息：',
    JSON.stringify({
      title: metadata.title,
      meetingType: metadata.meetingType,
      meetingDate: metadata.meetingDate,
      participants: metadata.participants,
    }),
    '',
    '会议听记：',
    transcript,
    '',
    '只返回符合 JSON Schema 的结果。',
  ].join('\n');
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

export async function analyzeMeetingTranscript(input: {
  metadata: MeetingAnalysisMetadata;
  transcript: string;
  executor: ClaudeStructuredExecutor;
}): Promise<MeetingAnalysisResult> {
  if (input.transcript.trim() === '') {
    throw new Error('会议听记不能为空');
  }
  if (input.transcript.length > MAX_MEETING_TRANSCRIPT_CHARACTERS) {
    throw new Error('会议听记过长，请拆分后分析');
  }

  const raw = await input.executor.execute({
    prompt: analysisPrompt(input.metadata, input.transcript),
    jsonSchema: meetingAnalysisJsonSchema,
    schema: meetingAnalysisSchema,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
  const parsed = meetingAnalysisSchema.parse(raw);
  const seenTitles = new Set<string>();
  const taskCandidates = parsed.taskCandidates.filter((candidate) => {
    if (!input.transcript.includes(candidate.sourceQuote)) {
      throw new Error(`候选任务引文在原文中不存在：${candidate.title}`);
    }
    const title = normalizedTitle(candidate.title);
    if (seenTitles.has(title)) return false;
    seenTitles.add(title);
    return true;
  });
  return { ...parsed, taskCandidates };
}

export interface MeetingAnalysisFileSystem {
  read(path: string): Promise<string>;
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
        `   - 原文：${safeAnalysisText(candidate.sourceQuote)}`,
      );
    });
  }
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

function updateAnalysisStatus(raw: string, status: 'ready_for_confirm' | 'failed', result?: MeetingAnalysisResult): string {
  const document = parseTaskDocument(raw);
  const body = result === undefined
    ? document.body
    : replaceAnalysisRegion(document.body, renderAnalysis(result));
  return serializeTaskDocument({ ...document.data, analysis_status: status }, body);
}

export class MeetingAnalysisController {
  constructor(private readonly dependencies: {
    fileSystem: MeetingAnalysisFileSystem;
    executor: ClaudeStructuredExecutor;
  }) {}

  async analyze(path: string): Promise<MeetingAnalysisResult> {
    if (analysesInFlight.has(path)) throw new MeetingAnalysisInProgressError();
    analysesInFlight.add(path);
    try {
      const raw = await this.dependencies.fileSystem.read(path);
      const document = parseTaskDocument(raw);
      if (document.data.analysis_status === 'ready_for_confirm') {
        throw new MeetingAnalysisAlreadyExistsError();
      }
      const transcript = extractMeetingTranscript(raw);
      let result: MeetingAnalysisResult;
      try {
        result = await analyzeMeetingTranscript({
          metadata: analysisMetadata(document.data),
          transcript,
          executor: this.dependencies.executor,
        });
      } catch (error) {
        await this.dependencies.fileSystem.process(path, (latest) => (
          parseTaskDocument(latest).data.analysis_status === 'ready_for_confirm'
            ? latest
            : updateAnalysisStatus(latest, 'failed')
        ));
        throw error;
      }

      let persistenceError: Error | null = null;
      await this.dependencies.fileSystem.process(path, (latest) => {
        if (parseTaskDocument(latest).data.analysis_status === 'ready_for_confirm') {
          persistenceError = new MeetingAnalysisAlreadyExistsError();
          return latest;
        }
        if (extractMeetingTranscript(latest) !== transcript) {
          persistenceError = new Error('会议听记在分析期间发生变化，请重新分析');
          return updateAnalysisStatus(latest, 'failed');
        }
        return updateAnalysisStatus(latest, 'ready_for_confirm', result);
      });
      if (persistenceError !== null) throw persistenceError;
      return result;
    } finally {
      analysesInFlight.delete(path);
    }
  }
}
