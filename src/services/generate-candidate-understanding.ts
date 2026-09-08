import { z } from 'zod';

import {
  buildCandidateUnderstanding,
  type CandidateSourceRef,
  type CandidateUnderstanding,
  type CandidateUnderstandingInput,
} from '../domain/candidate-understanding.js';
import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';

export interface GenerateCandidateUnderstandingInput {
  task: CandidateUnderstandingInput['task'];
  sourceRefs: readonly CandidateSourceRef[];
  project: {
    name: string;
    description: string;
  } | null;
}

const generatedDraftSchema = z.object({
  objective: z.string().trim().max(4_000),
  nextAction: z.string().trim().max(4_000),
  expectedArtifact: z.string().trim().max(4_000),
  completionCriteria: z.string().trim().max(4_000),
  taskType: z.enum(['research', 'code_change', 'unknown']),
}).strict();

const generatedDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'objective',
    'nextAction',
    'expectedArtifact',
    'completionCriteria',
    'taskType',
  ],
  properties: {
    objective: { type: 'string', maxLength: 4_000 },
    nextAction: { type: 'string', maxLength: 4_000 },
    expectedArtifact: { type: 'string', maxLength: 4_000 },
    completionCriteria: { type: 'string', maxLength: 4_000 },
    taskType: { type: 'string', enum: ['research', 'code_change', 'unknown'] },
  },
} as const;

const GENERATION_TIMEOUT_MS = 120_000;

function promptFor(input: GenerateCandidateUnderstandingInput): string {
  const evidence = input.sourceRefs.slice(0, 3).map((source, index) => [
    `来源 ${index + 1} 状态：${source.status}`,
    `有限引用：${source.quote.trim().slice(0, 300) || '无'}`,
    `必要上层上下文：${source.parentContext?.trim().slice(0, 600) || '无'}`,
  ].join('\n')).join('\n');
  const project = input.project === null
    ? '未关联项目。'
    : [
      `项目名称：${input.project.name.trim().slice(0, 300)}`,
      `项目说明：${input.project.description.trim().slice(0, 1_000)}`,
    ].join('\n');
  return [
    '你是候选任务理解助手，只根据下列有限证据生成可编辑建议。',
    '不要执行任务、调用工具、读取文件或访问网络。',
    '不要补造事实；无法判断的字段返回空字符串，taskType 返回 unknown。',
    '只返回符合 JSON Schema 的简洁中文结果。',
    '',
    `候选标题：${input.task.title.trim().slice(0, 500)}`,
    project,
    evidence === '' ? '没有可用来源引用。' : evidence,
    '',
    '输出 objective、nextAction、expectedArtifact、completionCriteria 和 taskType。',
  ].join('\n');
}

export async function generateCandidateUnderstanding(
  executor: ClaudeStructuredExecutor,
  input: GenerateCandidateUnderstandingInput,
): Promise<CandidateUnderstanding> {
  const draft = generatedDraftSchema.parse(await executor.execute({
    prompt: promptFor(input),
    jsonSchema: generatedDraftJsonSchema,
    schema: generatedDraftSchema,
    timeoutMs: GENERATION_TIMEOUT_MS,
  }));
  return buildCandidateUnderstanding({
    task: input.task,
    sourceRefs: input.sourceRefs,
    aiDraft: draft,
  });
}
