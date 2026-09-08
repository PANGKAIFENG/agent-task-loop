import { z } from 'zod';

import {
  CANDIDATE_FIELDS,
  candidateUnderstandingRevisionSchema,
  candidateUnderstandingSchema,
  reviseCandidateUnderstanding,
  type CandidateFieldValues,
  type CandidateUnderstanding,
} from '../domain/candidate-understanding.js';
import { taskSchema, type Task } from '../domain/task.js';
import { assertTransition } from '../domain/transitions.js';
import {
  TaskConflictError,
  TaskSavedIndexStaleError,
} from '../storage/markdown-task-repository.js';
import type { ServiceContext } from './service-context.js';

export interface ConfirmCandidateUnderstandingInput {
  understanding: CandidateUnderstanding;
  expectedRevision: number;
  expectedTaskUpdatedAt: string;
  confirm: boolean;
  values: CandidateFieldValues;
}

export class InvalidCandidateUnderstandingInputError extends Error {
  readonly code = 'invalid_candidate_understanding_input';

  constructor() {
    super('Invalid candidate understanding input');
    this.name = 'InvalidCandidateUnderstandingInputError';
  }
}

export class CandidateUnderstandingBlockedError extends Error {
  readonly code = 'candidate_understanding_blocked';

  constructor() {
    super('Blocking candidate gaps must be resolved before confirmation');
    this.name = 'CandidateUnderstandingBlockedError';
  }
}

export class CandidateUnderstandingInvalidStateError extends Error {
  readonly code = 'candidate_understanding_invalid_state';

  constructor() {
    super('Task must be in Inbox or unconfirmed Ready to confirm candidate understanding');
    this.name = 'CandidateUnderstandingInvalidStateError';
  }
}

export class CandidateUnderstandingAuditFailedError extends Error {
  readonly code = 'candidate_understanding_audit_failed';

  constructor() {
    super('Candidate understanding audit failed');
    this.name = 'CandidateUnderstandingAuditFailedError';
  }
}

export class CandidateUnderstandingRecoveryError extends Error {
  readonly code = 'candidate_understanding_recovery_error';
  readonly partialCommit = true;
  readonly recoveryRequired = true;

  constructor() {
    super('Candidate understanding recovery required');
    this.name = 'CandidateUnderstandingRecoveryError';
  }
}

const candidateValuesSchema = z.object(Object.fromEntries(
  CANDIDATE_FIELDS.map((field) => [
    field,
    z.string().max(field === 'title' ? 500 : 4_000).optional(),
  ]),
) as Record<(typeof CANDIDATE_FIELDS)[number], z.ZodOptional<z.ZodString>>).partial().strict();

const inputSchema = z.object({
  understanding: z.union([
    candidateUnderstandingRevisionSchema,
    candidateUnderstandingSchema,
  ]),
  expectedRevision: z.number().int().nonnegative(),
  expectedTaskUpdatedAt: z.string().datetime({ offset: true }),
  confirm: z.boolean(),
  values: candidateValuesSchema,
}).strict();

function fieldValue(
  understanding: CandidateUnderstanding,
  field: (typeof CANDIDATE_FIELDS)[number],
): string {
  return understanding.suggestions.find((item) => item.field === field)?.suggestedValue ?? '';
}

function nextTimestamp(now: Date, previous: string): string {
  if (now.getTime() > Date.parse(previous)) return now.toISOString();
  return new Date(Date.parse(previous) + 1).toISOString();
}

async function saveAndAudit(
  ctx: ServiceContext,
  original: Task,
  updated: Task,
): Promise<Task> {
  let saved = updated;
  let staleIndex: TaskSavedIndexStaleError | null = null;
  try {
    saved = await ctx.tasks.save(updated);
  } catch (error) {
    if (!(error instanceof TaskSavedIndexStaleError)) throw error;
    staleIndex = error;
  }
  try {
    await ctx.audit.append({
      event: updated.candidateUnderstanding?.confirmed === true
        ? 'task.candidate_understanding_confirmed'
        : 'task.candidate_understanding_saved',
      at: updated.updatedAt,
      taskId: updated.taskId,
      details: {
        revision: updated.candidateUnderstanding?.revision ?? 0,
        blockingGaps: updated.candidateUnderstanding?.gaps
          .filter(({ severity }) => severity === 'blocking').length ?? 0,
        agentAuthorized: false,
      },
    });
  } catch {
    try {
      await ctx.tasks.save({
        ...original,
        taskBrief: original.taskBrief ?? null,
        candidateUnderstanding: original.candidateUnderstanding ?? null,
      });
    } catch (error) {
      if (error instanceof TaskSavedIndexStaleError) {
        throw new CandidateUnderstandingAuditFailedError();
      }
      throw new CandidateUnderstandingRecoveryError();
    }
    throw new CandidateUnderstandingAuditFailedError();
  }
  if (staleIndex !== null) throw staleIndex;
  return saved;
}

export async function confirmCandidateUnderstanding(
  ctx: ServiceContext,
  taskId: string,
  input: ConfirmCandidateUnderstandingInput,
): Promise<Task> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new InvalidCandidateUnderstandingInputError();

  return ctx.tasks.withTaskLock(taskId, async () => {
    const original = await ctx.tasks.get(taskId);
    const confirmsInboxCandidate = original.status === 'inbox'
      && original.reviewState !== 'confirmed';
    const confirmsReadyCandidate = original.status === 'ready'
      && original.reviewState !== 'confirmed';
    if (!confirmsInboxCandidate && !confirmsReadyCandidate) {
      throw new CandidateUnderstandingInvalidStateError();
    }
    const currentRevision = original.candidateUnderstanding?.revision ?? 0;
    if (
      original.updatedAt !== parsed.data.expectedTaskUpdatedAt
      || currentRevision !== parsed.data.expectedRevision
    ) {
      throw new TaskConflictError();
    }
    const supplied = candidateUnderstandingSchema.parse({
      schemaVersion: parsed.data.understanding.schemaVersion,
      generationId: parsed.data.understanding.generationId,
      taskType: parsed.data.understanding.taskType,
      suggestions: parsed.data.understanding.suggestions,
      sourceRefs: parsed.data.understanding.sourceRefs,
      gaps: parsed.data.understanding.gaps,
    });
    const current = original.candidateUnderstanding ?? supplied;
    if (current.generationId !== supplied.generationId) throw new TaskConflictError();
    const revised = reviseCandidateUnderstanding(current, original, parsed.data.values);
    const blockingGaps = revised.gaps.filter(({ severity }) => severity === 'blocking');
    if (parsed.data.confirm && blockingGaps.length > 0) {
      throw new CandidateUnderstandingBlockedError();
    }
    const timestamp = nextTimestamp(ctx.clock(), original.updatedAt);
    const candidateUnderstanding = candidateUnderstandingRevisionSchema.parse({
      ...revised,
      revision: currentRevision + 1,
      confirmed: parsed.data.confirm,
      updatedAt: timestamp,
    });
    let updated: Task = taskSchema.parse({
      ...original,
      candidateUnderstanding,
      autoExecutable: false,
      updatedAt: timestamp,
    });
    if (parsed.data.confirm) {
      if (original.status === 'inbox') assertTransition('inbox', 'ready');
      const taskType = revised.taskType === 'research'
        ? 'research'
        : revised.taskType === 'code_change' ? 'development' : null;
      const objective = fieldValue(revised, 'objective');
      const completionCriteria = fieldValue(revised, 'completion_criteria');
      updated = taskSchema.parse({
        ...updated,
        title: fieldValue(revised, 'title'),
        status: 'ready',
        reviewState: 'confirmed',
        taskType,
        objective,
        acceptanceCriteria: [completionCriteria],
        taskBrief: {
          schemaVersion: 1,
          objective,
          nextAction: fieldValue(revised, 'next_action'),
          completionCriteria,
          updatedAt: timestamp,
        },
        readyAt: original.readyAt ?? timestamp,
      });
    }
    return saveAndAudit(ctx, original, updated);
  });
}
