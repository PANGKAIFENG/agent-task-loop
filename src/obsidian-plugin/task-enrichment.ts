import { z } from 'zod';

import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';

export interface TaskEnrichmentInput {
  title: string;
  body: string;
  userIntent: string;
  projectNames: readonly string[];
}

export const taskEnrichmentSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(5),
}).strict();

export type TaskEnrichment = z.infer<typeof taskEnrichmentSchema>;

export const taskEnrichmentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'acceptanceCriteria'],
  properties: {
    objective: { type: 'string', minLength: 1, maxLength: 4_000 },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 2_000 },
    },
  },
} as const;

const ENRICHMENT_TIMEOUT_MS = 120_000;

function promptFor(input: TaskEnrichmentInput): string {
  const projects = input.projectNames.length > 0
    ? input.projectNames.join('、')
    : '未选择项目';
  return [
    '你是一个任务整理助手，只负责把用户的想法整理成清晰的任务目标和完成条件。',
    '不要执行任务，不要调用工具，不要读取任何文件，不要访问网络。',
    '只根据下面给出的任务信息和用户补充生成严格 JSON。',
    '请使用简洁中文；不要捏造任务中没有的信息。',
    '',
    `任务标题：${input.title.slice(0, 500)}`,
    `任务正文：${input.body.slice(0, 8_000)}`,
    `用户补充：${input.userIntent.slice(0, 4_000)}`,
    `可选项目：${projects.slice(0, 2_000)}`,
    '',
    '输出 objective 和 1 至 5 条 acceptanceCriteria。',
    '只返回符合 JSON Schema 的结果。',
  ].join('\n');
}

export async function enrichTask(
  executor: ClaudeStructuredExecutor,
  input: TaskEnrichmentInput,
): Promise<TaskEnrichment> {
  const raw = await executor.execute({
    prompt: promptFor(input),
    jsonSchema: taskEnrichmentJsonSchema,
    schema: taskEnrichmentSchema,
    timeoutMs: ENRICHMENT_TIMEOUT_MS,
  });
  const parsed = taskEnrichmentSchema.parse(raw);
  const acceptanceCriteria = [...new Set(parsed.acceptanceCriteria.map((item) => item.trim()))];
  return taskEnrichmentSchema.parse({
    objective: parsed.objective.trim(),
    acceptanceCriteria,
  });
}
