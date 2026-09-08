import { createHash } from 'node:crypto';

import { z } from 'zod';

export const CANDIDATE_FIELDS = [
  'title',
  'objective',
  'next_action',
  'expected_artifact',
  'completion_criteria',
] as const;

export const CANDIDATE_TASK_TYPES = ['research', 'code_change', 'unknown'] as const;
export const FIELD_ATTRIBUTIONS = ['source_fact', 'ai_inference', 'missing'] as const;
export const SOURCE_REF_STATUSES = [
  'available',
  'moved',
  'changed',
  'unavailable',
  'missing',
] as const;

export type CandidateField = (typeof CANDIDATE_FIELDS)[number];
export type CandidateTaskType = (typeof CANDIDATE_TASK_TYPES)[number];
export type FieldAttribution = (typeof FIELD_ATTRIBUTIONS)[number];
export type SourceRefStatus = (typeof SOURCE_REF_STATUSES)[number];

export interface LastVerifiedEvidence {
  resolvedNote: string | null;
  checkedCharacters: number;
  quoteMatched: boolean;
  truncated: boolean;
}

export interface CandidateSourceRef {
  sourceRefId: string;
  sourceType: string;
  sourceKey: string;
  sourceNote: string | null;
  anchor: string | null;
  quote: string;
  capturedAt: string;
  lastVerifiedAt: string | null;
  status: SourceRefStatus;
  failureReason: string | null;
  parentContext: string | null;
  lastVerifiedEvidence: LastVerifiedEvidence | null;
}

export interface FieldSuggestion {
  field: CandidateField;
  suggestedValue: string;
  attribution: FieldAttribution;
  sourceRefIds: string[];
  reason: string;
  generationId: string;
}

export interface CandidateGap {
  gapId: string;
  field: string;
  severity: 'blocking' | 'optional';
  reasonCode: string;
  question: string;
  impact: 'confirmation' | 'admission' | 'permission' | 'acceptance';
  sourceRefIds: string[];
}

export interface CandidateUnderstanding {
  schemaVersion: 1;
  generationId: string;
  taskType: CandidateTaskType;
  suggestions: FieldSuggestion[];
  sourceRefs: CandidateSourceRef[];
  gaps: CandidateGap[];
}

export interface CandidateUnderstandingRevision extends CandidateUnderstanding {
  revision: number;
  confirmed: boolean;
  updatedAt: string;
}

export interface CandidateUnderstandingInput {
  task: {
    taskId: string;
    title: string;
    body: string;
    taskType: 'research' | 'development' | null;
    contextRefs?: readonly string[] | undefined;
    possibleDuplicateIds?: readonly string[] | undefined;
  };
  sourceRefs: readonly CandidateSourceRef[];
  aiDraft?: {
    objective?: string;
    nextAction?: string;
    expectedArtifact?: string;
    completionCriteria?: string;
    taskType?: CandidateTaskType;
  } | null;
}

export type CandidateFieldValues = Partial<Record<CandidateField, string | undefined>>;

const boundedString = (maximum: number) => z.string().max(maximum);

export const candidateSourceRefSchema: z.ZodType<CandidateSourceRef> = z.object({
  sourceRefId: boundedString(200).min(1),
  sourceType: boundedString(100).min(1),
  sourceKey: boundedString(300),
  sourceNote: boundedString(500).nullable(),
  anchor: boundedString(300).nullable(),
  quote: boundedString(300),
  capturedAt: z.string().datetime({ offset: true }),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(SOURCE_REF_STATUSES),
  failureReason: boundedString(500).nullable(),
  parentContext: boundedString(1_000).nullable(),
  lastVerifiedEvidence: z.object({
    resolvedNote: boundedString(500).nullable(),
    checkedCharacters: z.number().int().nonnegative().max(64_000),
    quoteMatched: z.boolean(),
    truncated: z.boolean(),
  }).strict().nullable(),
}).strict().superRefine((source, context) => {
  if (source.status !== 'available' && source.failureReason === null) {
    context.addIssue({
      code: 'custom',
      path: ['failureReason'],
      message: 'Non-available source refs require a failure reason',
    });
  }
});

export const fieldSuggestionSchema: z.ZodType<FieldSuggestion> = z.object({
  field: z.enum(CANDIDATE_FIELDS),
  suggestedValue: boundedString(4_000),
  attribution: z.enum(FIELD_ATTRIBUTIONS),
  sourceRefIds: z.array(boundedString(200).min(1)).max(8),
  reason: boundedString(1_000).min(1),
  generationId: boundedString(100).min(1),
}).strict();

export const candidateGapSchema: z.ZodType<CandidateGap> = z.object({
  gapId: boundedString(100).min(1),
  field: boundedString(100).min(1),
  severity: z.enum(['blocking', 'optional']),
  reasonCode: boundedString(100).min(1),
  question: boundedString(1_000).min(1),
  impact: z.enum(['confirmation', 'admission', 'permission', 'acceptance']),
  sourceRefIds: z.array(boundedString(200).min(1)).max(8),
}).strict();

export const candidateUnderstandingSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: boundedString(100).min(1),
  taskType: z.enum(CANDIDATE_TASK_TYPES),
  suggestions: z.array(fieldSuggestionSchema).length(CANDIDATE_FIELDS.length),
  sourceRefs: z.array(candidateSourceRefSchema).max(8),
  gaps: z.array(candidateGapSchema).max(30),
}).strict().superRefine((understanding, context) => {
  const sources = new Map(understanding.sourceRefs.map((source) => [source.sourceRefId, source]));
  understanding.suggestions.forEach((item, index) => {
    if (item.attribution !== 'source_fact') return;
    const supporting = item.sourceRefIds
      .map((sourceRefId) => sources.get(sourceRefId))
      .filter((source): source is CandidateSourceRef => source !== undefined)
      .some((source) => sourceSupports(item.suggestedValue, source));
    if (!supporting) {
      context.addIssue({
        code: 'custom',
        path: ['suggestions', index, 'sourceRefIds'],
        message: 'Source facts require a directly supporting source ref',
      });
    }
  });
});

export const candidateUnderstandingRevisionSchema: z.ZodType<CandidateUnderstandingRevision> =
  candidateUnderstandingSchema.extend({
    revision: z.number().int().positive(),
    confirmed: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict();

function bounded(value: string | null | undefined, maximum: number): string {
  return (value ?? '').trim().slice(0, maximum);
}

function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').replace(/[\s，。；：、:;.!！?？「」『』()（）[\]]+/gu, '').trim();
}

function sourceSupports(value: string, source: CandidateSourceRef): boolean {
  if (source.status !== 'available' && source.status !== 'moved') return false;
  const normalized = normalizeEvidence(value);
  if (normalized === '') return false;
  return [source.quote, source.parentContext ?? '']
    .some((text) => normalizeEvidence(text).includes(normalized));
}

function candidateTaskType(input: CandidateUnderstandingInput): CandidateTaskType {
  if (input.aiDraft?.taskType !== undefined) return input.aiDraft.taskType;
  if (input.task.taskType === 'research') return 'research';
  if (input.task.taskType === 'development') return 'code_change';
  return 'unknown';
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

function suggestion(
  generationId: string,
  field: CandidateField,
  value: string,
  sources: readonly CandidateSourceRef[],
): FieldSuggestion {
  const supporting = sources.filter((source) => sourceSupports(value, source));
  if (value === '') {
    return {
      field,
      suggestedValue: '',
      attribution: 'missing',
      sourceRefIds: [],
      reason: '当前有限来源无法确认该字段，请人工补充。',
      generationId,
    };
  }
  if (supporting.length > 0) {
    return {
      field,
      suggestedValue: value,
      attribution: 'source_fact',
      sourceRefIds: supporting.slice(0, 8).map(({ sourceRefId }) => sourceRefId),
      reason: '该字段可在有限来源引用中直接定位。',
      generationId,
    };
  }
  return {
    field,
    suggestedValue: value,
    attribution: 'ai_inference',
    sourceRefIds: [],
    reason: '该字段是基于当前有限上下文的 AI 推断，需人工确认。',
    generationId,
  };
}

function gap(
  generationId: string,
  input: Omit<CandidateGap, 'gapId'>,
): CandidateGap {
  return {
    ...input,
    gapId: stableId('gap', [generationId, input.reasonCode, input.field]),
  };
}

function gapsFor(
  generationId: string,
  taskType: CandidateTaskType,
  suggestions: readonly FieldSuggestion[],
  input: CandidateUnderstandingInput,
  sources: readonly CandidateSourceRef[],
): CandidateGap[] {
  const result: CandidateGap[] = [];
  const byField = new Map(suggestions.map((item) => [item.field, item]));
  const missing = (field: CandidateField) => byField.get(field)?.attribution === 'missing';
  const brokenSources = sources.filter((source) => (
    source.status === 'changed'
    || source.status === 'unavailable'
    || source.status === 'missing'
  ));
  if (sources.length === 0 || brokenSources.length > 0) {
    result.push(gap(generationId, {
      field: 'source',
      severity: 'blocking',
      reasonCode: sources.length === 0 ? 'source_missing' : 'source_unavailable',
      question: '可以补充或确认一条能支持当前任务的来源吗？',
      impact: 'confirmation',
      sourceRefIds: brokenSources.slice(0, 8).map(({ sourceRefId }) => sourceRefId),
    }));
  }
  if (missing('objective')) {
    result.push(gap(generationId, {
      field: 'objective',
      severity: 'blocking',
      reasonCode: `${taskType}_objective_missing`,
      question: '这项任务最终要解决什么问题或得到什么结果？',
      impact: 'confirmation',
      sourceRefIds: [],
    }));
  }
  if (missing('expected_artifact')) {
    result.push(gap(generationId, {
      field: 'expected_artifact',
      severity: 'blocking',
      reasonCode: taskType === 'code_change'
        ? 'code_expected_artifact_missing'
        : 'research_expected_artifact_missing',
      question: taskType === 'code_change'
        ? '预期交付的代码或评审产物是什么？'
        : '预期输出的调研产物是什么？',
      impact: 'acceptance',
      sourceRefIds: [],
    }));
  }
  if (missing('completion_criteria')) {
    result.push(gap(generationId, {
      field: 'completion_criteria',
      severity: 'blocking',
      reasonCode: taskType === 'code_change'
        ? 'code_validation_missing'
        : 'research_completion_missing',
      question: taskType === 'code_change'
        ? '需要通过哪些验证才能判断改动完成？'
        : '满足什么条件时可以判断调研完成？',
      impact: 'acceptance',
      sourceRefIds: [],
    }));
  }
  if (taskType === 'research') {
    result.push(gap(generationId, {
      field: 'research_source_boundary',
      severity: 'optional',
      reasonCode: 'research_source_boundary_optional',
      question: '是否需要限定调研的来源范围或时间范围？',
      impact: 'acceptance',
      sourceRefIds: [],
    }));
  }
  if (taskType === 'code_change') {
    const refs = input.task.contextRefs ?? [];
    if (!refs.some((ref) => ref.trim() !== '')) {
      result.push(gap(generationId, {
        field: 'workspace',
        severity: 'blocking',
        reasonCode: 'code_workspace_missing',
        question: '这项改动应在哪个工作区或仓库中完成？',
        impact: 'admission',
        sourceRefIds: [],
      }));
    }
    result.push(gap(generationId, {
      field: 'change_scope',
      severity: 'optional',
      reasonCode: 'code_change_scope_optional',
      question: '是否需要进一步限定允许修改的模块或文件范围？',
      impact: 'permission',
      sourceRefIds: [],
    }));
  }
  if (taskType === 'unknown') {
    result.push(gap(generationId, {
      field: 'task_type',
      severity: 'blocking',
      reasonCode: 'task_type_unknown',
      question: '这是一项调研任务还是代码改动任务？',
      impact: 'confirmation',
      sourceRefIds: [],
    }));
  }
  if ((input.task.possibleDuplicateIds?.length ?? 0) > 0) {
    result.push(gap(generationId, {
      field: 'duplicate',
      severity: 'blocking',
      reasonCode: 'possible_duplicate',
      question: '这些疑似重复任务应合并、保留还是关闭？',
      impact: 'admission',
      sourceRefIds: [],
    }));
  }
  return result;
}

export function buildCandidateUnderstanding(
  input: CandidateUnderstandingInput,
): CandidateUnderstanding {
  const sources = input.sourceRefs.slice(0, 8).map((source) => candidateSourceRefSchema.parse({
    ...source,
    quote: bounded(source.quote, 300),
    parentContext: source.parentContext === null
      ? null
      : bounded(source.parentContext, 1_000),
  }));
  const taskType = candidateTaskType(input);
  const values = {
    title: bounded(input.task.title, 500),
    objective: bounded(input.aiDraft?.objective, 4_000),
    next_action: bounded(input.aiDraft?.nextAction, 4_000),
    expected_artifact: bounded(input.aiDraft?.expectedArtifact, 4_000),
    completion_criteria: bounded(input.aiDraft?.completionCriteria, 4_000),
  } satisfies Record<CandidateField, string>;
  const generationId = stableId('candidate', {
    taskId: input.task.taskId,
    taskType,
    values,
    sources: sources.map(({ sourceRefId, status, quote, parentContext }) => ({
      sourceRefId,
      status,
      quote,
      parentContext,
    })),
  });
  const suggestions = CANDIDATE_FIELDS.map((field) => suggestion(
    generationId,
    field,
    values[field],
    sources,
  ));
  return candidateUnderstandingSchema.parse({
    schemaVersion: 1,
    generationId,
    taskType,
    suggestions,
    sourceRefs: sources,
    gaps: gapsFor(generationId, taskType, suggestions, input, sources),
  });
}

export function reviseCandidateUnderstanding(
  current: CandidateUnderstanding,
  task: CandidateUnderstandingInput['task'],
  values: CandidateFieldValues,
): CandidateUnderstanding {
  const parsed = candidateUnderstandingSchema.parse({
    schemaVersion: current.schemaVersion,
    generationId: current.generationId,
    taskType: current.taskType,
    suggestions: current.suggestions,
    sourceRefs: current.sourceRefs,
    gaps: current.gaps,
  });
  const suggestions = parsed.suggestions.map((item): FieldSuggestion => {
    const edited = values[item.field];
    if (edited === undefined) return item;
    const value = bounded(edited, item.field === 'title' ? 500 : 4_000);
    if (value === item.suggestedValue) return item;
    if (value === '') {
      return {
        ...item,
        suggestedValue: '',
        attribution: 'missing',
        sourceRefIds: [],
        reason: '该字段已由人工清空，保存前仍需补充。',
      };
    }
    return {
      ...item,
      suggestedValue: value,
      attribution: 'ai_inference',
      sourceRefIds: [],
      reason: '该字段已由人工编辑；原始来源与生成建议保持独立。',
    };
  });
  return candidateUnderstandingSchema.parse({
    ...parsed,
    suggestions,
    gaps: gapsFor(parsed.generationId, parsed.taskType, suggestions, {
      task,
      sourceRefs: parsed.sourceRefs,
    }, parsed.sourceRefs),
  });
}
