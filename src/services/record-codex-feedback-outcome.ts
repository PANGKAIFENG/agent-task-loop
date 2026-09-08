import { z } from 'zod';

import {
  CODEX_FEEDBACK_MIGRATION_OUTCOMES,
  codexFeedbackOutcomeId,
  type CodexFeedbackOutcome,
  type CodexVisibleFeedbackOutcome,
} from '../domain/codex-feedback.js';
import { redactSecrets } from '../security/redact-secrets.js';
import type { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';
import {
  CodexFeedbackVisibleRecordInvalidError,
  type MarkdownCodexFeedbackRepository,
} from '../storage/markdown-codex-feedback-repository.js';

const inputSchema = z.object({
  selectionId: z.string().regex(/^cfcs_[0-9a-f]{24}$/u),
  targetBindingId: z.string().regex(/^cb_[0-9a-f]{24}$/u),
  outcome: z.enum(CODEX_FEEDBACK_MIGRATION_OUTCOMES),
  evidenceSummary: z.string().trim().min(1).max(2_000),
  artifactRef: z.string().trim().min(1).max(4_096).nullable(),
}).strict();

export type RecordCodexFeedbackOutcomeInput = z.input<typeof inputSchema>;

export class CodexFeedbackOutcomeInvalidError extends Error {
  readonly code = 'codex_feedback_outcome_invalid';

  constructor() {
    super('Codex feedback outcome does not match a selection and target binding');
    this.name = 'CodexFeedbackOutcomeInvalidError';
  }
}

export class CodexFeedbackOutcomeConflictError extends Error {
  readonly code = 'codex_feedback_outcome_conflict';

  constructor() {
    super('Codex feedback selection already has a different outcome');
    this.name = 'CodexFeedbackOutcomeConflictError';
  }
}

export interface RecordCodexFeedbackOutcomeDependencies {
  stateRepository: FileCodexFeedbackStateRepository;
  visibleRepository: MarkdownCodexFeedbackRepository;
  clock: () => Date;
}

function visibleOutcome(
  outcome: CodexFeedbackOutcome,
  selectedFeedbackIds: string[],
): CodexVisibleFeedbackOutcome {
  return {
    schemaVersion: 1,
    outcomeId: outcome.outcomeId,
    selectionId: outcome.selectionId,
    targetBindingId: outcome.targetBindingId,
    selectedFeedbackIds,
    outcome: outcome.outcome,
    evidenceSummary: outcome.evidenceSummary,
    artifactRef: outcome.artifactRef,
    recordedAt: outcome.recordedAt,
  };
}

export async function recordCodexFeedbackOutcome(
  dependencies: RecordCodexFeedbackOutcomeDependencies,
  input: RecordCodexFeedbackOutcomeInput,
): Promise<{
  outcome: CodexFeedbackOutcome;
  visibleOutcome: CodexVisibleFeedbackOutcome;
  created: boolean;
}> {
  const validated = inputSchema.safeParse(input);
  if (!validated.success) throw new CodexFeedbackOutcomeInvalidError();
  const parsed = inputSchema.safeParse({
    ...validated.data,
    evidenceSummary: redactSecrets(validated.data.evidenceSummary).trim(),
  });
  if (!parsed.success) throw new CodexFeedbackOutcomeInvalidError();
  return dependencies.stateRepository.withLock(async () => {
    const state = await dependencies.stateRepository.read();
    const selection = state.contextSelections.find((candidate) => (
      candidate.selectionId === parsed.data.selectionId
    ));
    const binding = state.bindings.find((candidate) => (
      candidate.bindingId === parsed.data.targetBindingId
    ));
    if (
      selection === undefined
      || binding === undefined
      || selection.targetBindingId !== binding.bindingId
      || (parsed.data.artifactRef !== null
        && parsed.data.artifactRef !== binding.artifactPath)
    ) throw new CodexFeedbackOutcomeInvalidError();

    const existing = state.outcomes.find((candidate) => (
      candidate.selectionId === selection.selectionId
    ));
    if (existing !== undefined) {
      if (
        existing.targetBindingId !== binding.bindingId
        || existing.outcome !== parsed.data.outcome
        || existing.evidenceSummary !== parsed.data.evidenceSummary
        || existing.artifactRef !== parsed.data.artifactRef
      ) throw new CodexFeedbackOutcomeConflictError();
      const expected = visibleOutcome(existing, selection.selectedFeedbackIds);
      const persisted = await dependencies.visibleRepository.readOutcome(
        existing.visibleRecord.ref,
        existing.visibleRecord.sha256,
      );
      if (JSON.stringify(persisted.record) !== JSON.stringify(expected)) {
        throw new CodexFeedbackVisibleRecordInvalidError();
      }
      return {
        outcome: existing,
        visibleOutcome: persisted.record,
        created: false,
      };
    }

    const recordedAt = dependencies.clock().toISOString();
    if (!Number.isFinite(Date.parse(recordedAt))) {
      throw new CodexFeedbackOutcomeInvalidError();
    }
    const outcomeId = codexFeedbackOutcomeId(selection.selectionId);
    const visible = await dependencies.visibleRepository.createOutcomeOrGet({
      schemaVersion: 1,
      outcomeId,
      selectionId: selection.selectionId,
      targetBindingId: binding.bindingId,
      selectedFeedbackIds: selection.selectedFeedbackIds,
      outcome: parsed.data.outcome,
      evidenceSummary: parsed.data.evidenceSummary,
      artifactRef: parsed.data.artifactRef,
      recordedAt,
    });
    const outcome: CodexFeedbackOutcome = {
      outcomeId,
      selectionId: selection.selectionId,
      targetBindingId: binding.bindingId,
      outcome: parsed.data.outcome,
      evidenceSummary: parsed.data.evidenceSummary,
      artifactRef: parsed.data.artifactRef,
      visibleRecord: { ref: visible.ref, sha256: visible.sha256 },
      recordedAt: visible.record.recordedAt,
    };
    state.outcomes.push(outcome);
    state.outcomes.sort((left, right) => left.outcomeId.localeCompare(right.outcomeId));
    await dependencies.stateRepository.save(state);
    return { outcome, visibleOutcome: visible.record, created: true };
  });
}
