import { z } from 'zod';

import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';

export interface TaskBriefGenerationInput {
  title: string;
  body: string;
  project: {
    name: string;
    description: string;
  } | null;
}

export const taskBriefDraftSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    nextAction: z.string().trim().min(1).max(4_000),
    completionCriteria: z.string().trim().min(1).max(4_000),
  })
  .strict();

export type TaskBriefDraft = z.infer<typeof taskBriefDraftSchema>;

export const taskBriefDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'nextAction', 'completionCriteria'],
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: 4_000 },
    nextAction: { type: 'string', minLength: 1, maxLength: 4_000 },
    completionCriteria: { type: 'string', minLength: 1, maxLength: 4_000 },
  },
} as const;

const GENERATION_TIMEOUT_MS = 120_000;

function promptFor(input: TaskBriefGenerationInput): string {
  const projectContext = input.project === null
    ? '未关联业务项目。'
    : [
        `业务项目：${input.project.name.slice(0, 500)}`,
        `项目说明：${input.project.description.slice(0, 2_000)}`,
      ].join('\n');
  return [
    '你是任务澄清助手，只负责根据用户已经提供的信息形成简洁、可执行的任务简报。',
    '不要执行任务，不要调用工具，不要读取文件，不要访问网络。',
    '不要补造用户没有表达的事实；必要的建议要写成清晰、低风险的下一步。',
    '请使用简洁中文，并只返回符合 JSON Schema 的结果。',
    '',
    `任务标题：${input.title.slice(0, 500)}`,
    `任务正文：${input.body.slice(0, 8_000)}`,
    projectContext,
    '',
    '输出三个字段：',
    '- objective：这项任务最终要解决什么或得到什么。',
    '- nextAction：用户现在可以开始做的一个明确动作。',
    '- completionCriteria：可以判断任务已经完成的条件。',
  ].join('\n');
}

export async function generateTaskBrief(
  executor: ClaudeStructuredExecutor,
  input: TaskBriefGenerationInput,
): Promise<TaskBriefDraft> {
  const raw = await executor.execute({
    prompt: promptFor(input),
    jsonSchema: taskBriefDraftJsonSchema,
    schema: taskBriefDraftSchema,
    timeoutMs: GENERATION_TIMEOUT_MS,
  });
  return taskBriefDraftSchema.parse(raw);
}
