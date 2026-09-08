import {
  buildCandidateUnderstanding,
  type CandidateGap,
  type CandidateSourceRef,
  type CandidateUnderstanding,
  type FieldSuggestion,
} from '../domain/candidate-understanding.js';
import type { Task, TaskBrief } from '../domain/task.js';
import type { ProjectedAgentAdmission } from './agent-admission-projection.js';

export interface CandidateInspectorProjection {
  taskIdentity: {
    taskId: string;
    title: string;
    status: string;
    reviewState: Task['reviewState'];
    updatedAt: string;
    candidateRevision: number;
    candidateConfirmed: boolean;
    autoExecutable: boolean;
  };
  understandingIdentity: Pick<
    CandidateUnderstanding,
    'schemaVersion' | 'generationId' | 'taskType'
  >;
  currentTaskBrief: TaskBrief | null;
  suggestions: FieldSuggestion[];
  sourceRefs: CandidateSourceRef[];
  sourceActions: CandidateSourceAction[];
  gaps: CandidateGap[];
  admission: ProjectedAgentAdmission;
  permissionGate: ProjectedAgentAdmission['permission_gate'];
}

export interface CandidateSourceAction {
  actionId: 'open_source';
  sourceRefId: string;
  intent: 'open' | 'recover';
  label: '打开原始输入并定位' | '重新定位来源';
}

export function sourceActionsFor(
  sourceRefs: readonly CandidateSourceRef[],
): CandidateSourceAction[] {
  return sourceRefs.slice(0, 8).map((source) => {
    const open = source.status === 'available' || source.status === 'moved';
    return {
      actionId: 'open_source',
      sourceRefId: source.sourceRefId,
      intent: open ? 'open' : 'recover',
      label: open ? '打开原始输入并定位' : '重新定位来源',
    };
  });
}

function legacyUnderstanding(task: Task): CandidateUnderstanding {
  const quote = task.sourceQuote?.trim().slice(0, 300) ?? '';
  const sourceRefs: CandidateSourceRef[] = quote === '' && task.sourceKey.trim() === ''
    ? []
    : [{
      sourceRefId: `legacy-${task.taskId}`.slice(0, 200),
      sourceType: task.origin.trim().slice(0, 100) || 'legacy_task',
      sourceKey: task.sourceKey.trim().slice(0, 300),
      sourceNote: task.sourceNote?.trim().slice(0, 500) ?? null,
      anchor: null,
      quote,
      capturedAt: task.createdAt,
      lastVerifiedAt: null,
      status: 'unavailable',
      failureReason: 'legacy_source_not_verified',
      parentContext: null,
      lastVerifiedEvidence: null,
    }];
  return buildCandidateUnderstanding({
    task: {
      taskId: task.taskId,
      title: task.title,
      body: '',
      taskType: task.taskType,
      contextRefs: task.contextRefs,
      possibleDuplicateIds: task.possibleDuplicateIds,
    },
    sourceRefs,
    aiDraft: {
      objective: task.taskBrief?.objective ?? task.objective ?? '',
      nextAction: task.taskBrief?.nextAction ?? '',
      completionCriteria: task.taskBrief?.completionCriteria
        ?? task.acceptanceCriteria[0]
        ?? '',
    },
  });
}

export function candidateUnderstandingForTask(task: Task): CandidateUnderstanding {
  if (task.candidateUnderstanding === null || task.candidateUnderstanding === undefined) {
    return legacyUnderstanding(task);
  }
  return {
    schemaVersion: task.candidateUnderstanding.schemaVersion,
    generationId: task.candidateUnderstanding.generationId,
    taskType: task.candidateUnderstanding.taskType,
    suggestions: task.candidateUnderstanding.suggestions.map((suggestion) => ({
      ...suggestion,
      sourceRefIds: [...suggestion.sourceRefIds],
    })),
    sourceRefs: task.candidateUnderstanding.sourceRefs.map(cloneSourceRef),
    gaps: task.candidateUnderstanding.gaps.map((gap) => ({
      ...gap,
      sourceRefIds: [...gap.sourceRefIds],
    })),
  };
}

function cloneSourceRef(source: CandidateSourceRef): CandidateSourceRef {
  return {
    ...source,
    lastVerifiedEvidence: source.lastVerifiedEvidence === null
      ? null
      : { ...source.lastVerifiedEvidence },
  };
}

function cloneAdmission(admission: ProjectedAgentAdmission): ProjectedAgentAdmission {
  return {
    ...admission,
    reasons: admission.reasons.map((reason) => ({ ...reason })),
    permission_gate: {
      ...admission.permission_gate,
      external_writes: admission.permission_gate.external_writes.map((write) => ({ ...write })),
    },
    ...(admission.traceability === undefined
      ? {}
      : {
        traceability: {
          ...admission.traceability,
          acceptance_criteria: [...admission.traceability.acceptance_criteria],
        },
      }),
  };
}

function projectCandidateInspector(
  task: Task,
  admissionInput: ProjectedAgentAdmission,
  understandingInput: CandidateUnderstanding = candidateUnderstandingForTask(task),
): CandidateInspectorProjection {
  const understanding = understandingInput;
  const admission = cloneAdmission(admissionInput);
  return {
    taskIdentity: {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      reviewState: task.reviewState,
      updatedAt: task.updatedAt,
      candidateRevision: task.candidateUnderstanding?.revision ?? 0,
      candidateConfirmed: task.candidateUnderstanding?.confirmed ?? false,
      autoExecutable: task.autoExecutable,
    },
    understandingIdentity: {
      schemaVersion: understanding.schemaVersion,
      generationId: understanding.generationId,
      taskType: understanding.taskType,
    },
    currentTaskBrief: task.taskBrief === null || task.taskBrief === undefined
      ? null
      : { ...task.taskBrief },
    suggestions: understanding.suggestions.map((suggestion) => ({
      ...suggestion,
      sourceRefIds: [...suggestion.sourceRefIds],
    })),
    sourceRefs: understanding.sourceRefs.slice(0, 8).map(cloneSourceRef),
    sourceActions: sourceActionsFor(understanding.sourceRefs),
    gaps: understanding.gaps.slice(0, 30).map((gap) => ({
      ...gap,
      sourceRefIds: [...gap.sourceRefIds],
    })),
    admission,
    permissionGate: {
      ...admission.permission_gate,
      external_writes: admission.permission_gate.external_writes.map((write) => ({ ...write })),
    },
  };
}

export function projectCandidateInspectorForWeb(
  task: Task,
  admission: ProjectedAgentAdmission,
  understanding?: CandidateUnderstanding,
): CandidateInspectorProjection {
  return projectCandidateInspector(task, admission, understanding);
}

export function projectCandidateInspectorForObsidian(
  task: Task,
  admission: ProjectedAgentAdmission,
  understanding?: CandidateUnderstanding,
): CandidateInspectorProjection {
  return projectCandidateInspector(task, admission, understanding);
}
