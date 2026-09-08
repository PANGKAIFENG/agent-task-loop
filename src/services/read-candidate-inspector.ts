import {
  buildCandidateUnderstanding,
  type CandidateUnderstanding,
} from '../domain/candidate-understanding.js';
import type { Task } from '../domain/task.js';
import {
  candidateUnderstandingForTask,
  projectCandidateInspectorForObsidian,
  projectCandidateInspectorForWeb,
  type CandidateInspectorProjection,
} from './candidate-inspector-projection.js';
import {
  projectAdmissionForObsidian,
  projectAdmissionForWeb,
} from './agent-admission-projection.js';
import { evaluateAgentAdmissionForTask } from './evaluate-agent-admission.js';
import { resolveCandidateSource } from './resolve-candidate-source.js';
import type { ServiceContext } from './service-context.js';

export type CandidateInspectorConsumer = 'web' | 'obsidian';

export interface ReadCandidateInspectorOptions {
  sourceRoot?: string;
  locateMoved?: (sourceKey: string) => Promise<string | null>;
}

function candidateField(understanding: CandidateUnderstanding, field: string): string | null {
  const value = understanding.suggestions
    .find((suggestion) => suggestion.field === field)?.suggestedValue.trim();
  return value === undefined || value === '' ? null : value;
}

export async function candidateUnderstandingForInspectorRead(
  ctx: ServiceContext,
  task: Task,
  options: ReadCandidateInspectorOptions = {},
): Promise<CandidateUnderstanding> {
  if (task.candidateUnderstanding !== null && task.candidateUnderstanding !== undefined) {
    return candidateUnderstandingForTask(task);
  }
  if (
    options.sourceRoot === undefined
    || (
      (task.sourceQuote?.trim() ?? '') === ''
      && task.sourceKey.trim() === ''
      && (task.sourceNote?.trim() ?? '') === ''
    )
  ) {
    return candidateUnderstandingForTask(task);
  }
  const source = await resolveCandidateSource({
    root: options.sourceRoot,
    seed: {
      sourceRefId: `task-source-${task.taskId}`.slice(0, 200),
      sourceType: task.origin.trim().slice(0, 100) || 'task_source',
      sourceKey: task.sourceKey,
      sourceNote: task.sourceNote,
      quote: task.sourceQuote,
      capturedAt: task.createdAt,
    },
    now: ctx.clock(),
    ...(options.locateMoved === undefined ? {} : { locateMoved: options.locateMoved }),
  });
  return buildCandidateUnderstanding({
    task: {
      taskId: task.taskId,
      title: task.title,
      body: '',
      taskType: task.taskType,
      contextRefs: task.contextRefs,
      possibleDuplicateIds: task.possibleDuplicateIds,
    },
    sourceRefs: [source],
    aiDraft: {
      objective: task.taskBrief?.objective ?? task.objective ?? '',
      nextAction: task.taskBrief?.nextAction ?? '',
      completionCriteria: task.taskBrief?.completionCriteria
        ?? task.acceptanceCriteria[0]
        ?? '',
    },
  });
}

export async function readCandidateInspector(
  ctx: ServiceContext,
  task: Task,
  consumer: CandidateInspectorConsumer,
  options: ReadCandidateInspectorOptions = {},
): Promise<CandidateInspectorProjection> {
  const understanding = await candidateUnderstandingForInspectorRead(ctx, task, options);
  const verdict = await evaluateAgentAdmissionForTask(ctx, task);
  const traceability = {
    task_id: task.taskId,
    task_revision: task.updatedAt,
    project_id: task.projectId,
    context_pack_id: null,
    expected_artifact: candidateField(understanding, 'expected_artifact'),
    acceptance_criteria: [...task.acceptanceCriteria],
    source_key: task.sourceKey.trim() === '' ? null : task.sourceKey,
  };
  return consumer === 'web'
    ? projectCandidateInspectorForWeb(
      task,
      projectAdmissionForWeb(verdict, traceability),
      understanding,
    )
    : projectCandidateInspectorForObsidian(
      task,
      projectAdmissionForObsidian(verdict, traceability),
      understanding,
    );
}
