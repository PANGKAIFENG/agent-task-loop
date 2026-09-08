import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'expected an ISO timestamp',
);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedIdSchema = z.string().trim().min(1).max(200);
const absolutePathSchema = z.string().trim().min(1).max(4_096).refine(isAbsolute);

export const CODEX_FEEDBACK_CLASSIFICATIONS = [
  'acceptance',
  'reusable_correction',
  'rejection',
  'clarification',
  'one_off_preference',
] as const;

export const CODEX_FEEDBACK_MIGRATION_OUTCOMES = [
  'hit',
  'partial',
  'miss',
  'not_applicable',
] as const;

export const codexTaskBindingSchema = z.object({
  bindingId: z.string().regex(/^cb_[0-9a-f]{24}$/u),
  threadId: boundedIdSchema,
  taskId: boundedIdSchema,
  sourceRef: z.string().trim().min(1).max(2_000),
  sourceSha256: sha256Schema,
  artifactRoot: absolutePathSchema,
  artifactPath: absolutePathSchema,
  experimentId: boundedIdSchema.nullable(),
  createdAt: timestampSchema,
}).strict();

export const bindCodexTaskInputSchema = codexTaskBindingSchema.omit({
  bindingId: true,
  createdAt: true,
});

export type CodexTaskBinding = z.infer<typeof codexTaskBindingSchema>;
export type BindCodexTaskInput = z.input<typeof bindCodexTaskInputSchema>;

export const codexArtifactSnapshotSchema = z.object({
  snapshotId: z.string().regex(/^cas_[0-9a-f]{24}$/u),
  bindingId: codexTaskBindingSchema.shape.bindingId,
  artifactVersion: z.number().int().positive(),
  artifactSha256: sha256Schema,
  capturedAt: timestampSchema,
}).strict();

export type CodexArtifactSnapshot = z.infer<typeof codexArtifactSnapshotSchema>;

const visibleRecordSchema = z.object({
  ref: z.string().trim().min(1).max(2_000),
  sha256: sha256Schema,
}).strict();

export const codexVisibleFeedbackSampleSchema = z.object({
  schemaVersion: z.literal(1),
  feedbackId: z.string().regex(/^cfeedback_[0-9a-f]{24}$/u),
  status: z.literal('observing'),
  bindingId: codexTaskBindingSchema.shape.bindingId,
  threadId: boundedIdSchema,
  taskId: boundedIdSchema,
  sourceRef: z.string().trim().min(1).max(2_000),
  artifactRef: absolutePathSchema,
  artifactVersion: z.number().int().positive(),
  artifactSha256: sha256Schema,
  messageId: boundedIdSchema,
  messageSha256: sha256Schema,
  summary: z.string().trim().min(1).max(2_000),
  applicabilityLabels: z.array(z.string().trim().min(1).max(100)).max(20),
  guidance: z.string().trim().min(1).max(2_000).nullable(),
  captureMode: z.enum(['automatic', 'backfilled_by_v0']),
  createdAt: timestampSchema,
}).strict();

export type CodexVisibleFeedbackSample = z.infer<
  typeof codexVisibleFeedbackSampleSchema
>;

export const codexAcceptanceReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  acceptanceId: z.string().regex(/^cacceptance_[0-9a-f]{24}$/u),
  bindingId: codexTaskBindingSchema.shape.bindingId,
  threadId: boundedIdSchema,
  taskId: boundedIdSchema,
  sourceRef: z.string().trim().min(1).max(2_000),
  artifactRef: absolutePathSchema,
  artifactVersion: z.number().int().positive(),
  artifactSha256: sha256Schema,
  messageId: boundedIdSchema,
  messageSha256: sha256Schema,
  summary: z.string().trim().min(1).max(2_000),
  captureMode: z.enum(['automatic', 'backfilled_by_v0']),
  acceptedAt: timestampSchema,
}).strict();

export type CodexAcceptanceReceipt = z.infer<typeof codexAcceptanceReceiptSchema>;

export const codexVisibleFeedbackOutcomeSchema = z.object({
  schemaVersion: z.literal(1),
  outcomeId: z.string().regex(/^cfo_[0-9a-f]{24}$/u),
  selectionId: z.string().regex(/^cfcs_[0-9a-f]{24}$/u),
  targetBindingId: codexTaskBindingSchema.shape.bindingId,
  selectedFeedbackIds: z.array(
    z.string().regex(/^cfeedback_[0-9a-f]{24}$/u),
  ).max(1_000),
  outcome: z.enum(CODEX_FEEDBACK_MIGRATION_OUTCOMES),
  evidenceSummary: z.string().trim().min(1).max(2_000),
  artifactRef: absolutePathSchema.nullable(),
  recordedAt: timestampSchema,
}).strict();

export type CodexVisibleFeedbackOutcome = z.infer<
  typeof codexVisibleFeedbackOutcomeSchema
>;

export const codexFeedbackSettlementSchema = z.object({
  settlementId: z.string().regex(/^cfs_[0-9a-f]{24}$/u),
  bindingId: codexTaskBindingSchema.shape.bindingId,
  messageId: boundedIdSchema,
  messageSha256: sha256Schema,
  artifactVersion: z.number().int().positive(),
  classification: z.enum(CODEX_FEEDBACK_CLASSIFICATIONS),
  summary: z.string().trim().min(1).max(2_000),
  applicabilityLabels: z.array(z.string().trim().min(1).max(100)).max(20),
  guidance: z.string().trim().min(1).max(2_000).nullable(),
  captureMode: z.enum(['automatic', 'backfilled_by_v0']),
  action: z.enum([
    'feedback_created',
    'acceptance_created',
    'recorded_without_cross_task_asset',
  ]),
  visibleRecord: visibleRecordSchema.nullable(),
  settledAt: timestampSchema,
}).strict();

export type CodexFeedbackSettlement = z.infer<typeof codexFeedbackSettlementSchema>;

export const codexFeedbackContextSelectionSchema = z.object({
  selectionId: z.string().regex(/^cfcs_[0-9a-f]{24}$/u),
  targetBindingId: codexTaskBindingSchema.shape.bindingId,
  decisions: z.array(z.object({
    feedbackId: z.string().regex(/^cfeedback_[0-9a-f]{24}$/u),
    decision: z.enum(['selected', 'excluded']),
    reason: z.string().trim().min(1).max(1_000),
    documentRef: z.string().trim().min(1).max(2_000),
    documentSha256: sha256Schema,
  }).strict()).max(1_000),
  selectedFeedbackIds: z.array(z.string().regex(/^cfeedback_[0-9a-f]{24}$/u)).max(1_000),
  createdAt: timestampSchema,
}).strict();

export type CodexFeedbackContextSelection = z.infer<
  typeof codexFeedbackContextSelectionSchema
>;

export const codexFeedbackOutcomeSchema = z.object({
  outcomeId: z.string().regex(/^cfo_[0-9a-f]{24}$/u),
  selectionId: codexFeedbackContextSelectionSchema.shape.selectionId,
  targetBindingId: codexTaskBindingSchema.shape.bindingId,
  outcome: z.enum(CODEX_FEEDBACK_MIGRATION_OUTCOMES),
  evidenceSummary: z.string().trim().min(1).max(2_000),
  artifactRef: z.string().trim().min(1).max(2_000).nullable(),
  visibleRecord: visibleRecordSchema,
  recordedAt: timestampSchema,
}).strict();

export type CodexFeedbackOutcome = z.infer<typeof codexFeedbackOutcomeSchema>;

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const codexFeedbackStateSchema = z.object({
  schemaVersion: z.literal(1),
  bindings: z.array(codexTaskBindingSchema),
  artifactSnapshots: z.array(codexArtifactSnapshotSchema),
  settlements: z.array(codexFeedbackSettlementSchema),
  contextSelections: z.array(codexFeedbackContextSelectionSchema),
  activeContextSelections: z.array(z.object({
    targetBindingId: codexTaskBindingSchema.shape.bindingId,
    selectionId: codexFeedbackContextSelectionSchema.shape.selectionId,
  }).strict()).optional(),
  outcomes: z.array(codexFeedbackOutcomeSchema),
}).strict().superRefine((state, context) => {
  const duplicateChecks: Array<[string[], Array<string | number>, string]> = [
    [state.bindings.map((item) => item.bindingId), ['bindings'], 'duplicate binding id'],
    [state.bindings.map((item) => item.threadId), ['bindings'], 'duplicate thread id'],
    [state.bindings.map((item) => item.taskId), ['bindings'], 'duplicate task id'],
    [
      state.artifactSnapshots.map((item) => item.snapshotId),
      ['artifactSnapshots'],
      'duplicate Artifact snapshot id',
    ],
    [
      state.artifactSnapshots.map((item) => `${item.bindingId}:${item.artifactVersion}`),
      ['artifactSnapshots'],
      'duplicate Artifact snapshot binding/version pair',
    ],
    [
      state.settlements.map((item) => item.settlementId),
      ['settlements'],
      'duplicate settlement id',
    ],
    [state.settlements.map((item) => item.messageId), ['settlements'], 'duplicate message id'],
    [
      state.contextSelections.map((item) => item.selectionId),
      ['contextSelections'],
      'duplicate context selection id',
    ],
    [state.outcomes.map((item) => item.outcomeId), ['outcomes'], 'duplicate outcome id'],
    [state.outcomes.map((item) => item.selectionId), ['outcomes'], 'duplicate outcome selection'],
    [
      (state.activeContextSelections ?? []).map((item) => item.targetBindingId),
      ['activeContextSelections'],
      'duplicate active selection binding',
    ],
  ];
  for (const [values, path, message] of duplicateChecks) {
    if (hasDuplicates(values)) context.addIssue({ code: 'custom', path, message });
  }

  (state.activeContextSelections ?? []).forEach((active, index) => {
    if (
      !state.bindings.some((binding) => binding.bindingId === active.targetBindingId)
      || !state.contextSelections.some((selection) => (
        selection.targetBindingId === active.targetBindingId
        && selection.selectionId === active.selectionId
      ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['activeContextSelections', index],
        message: 'active selection must reference its bound receipt',
      });
    }
  });

  state.contextSelections.forEach((selection, index) => {
    const decisionIds = selection.decisions.map((decision) => decision.feedbackId);
    const selectedFromDecisions = selection.decisions
      .filter((decision) => decision.decision === 'selected')
      .map((decision) => decision.feedbackId)
      .sort((left, right) => left.localeCompare(right));
    const selectedIds = [...selection.selectedFeedbackIds]
      .sort((left, right) => left.localeCompare(right));
    if (hasDuplicates(decisionIds)) {
      context.addIssue({
        code: 'custom',
        path: ['contextSelections', index, 'decisions'],
        message: 'duplicate feedback decision',
      });
    }
    if (
      hasDuplicates(selection.selectedFeedbackIds)
      || JSON.stringify(selectedIds) !== JSON.stringify(selectedFromDecisions)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['contextSelections', index, 'selectedFeedbackIds'],
        message: 'selected feedback ids do not match decisions',
      });
    }
  });
});

export type CodexFeedbackState = z.infer<typeof codexFeedbackStateSchema>;

export function emptyCodexFeedbackState(): CodexFeedbackState {
  return {
    schemaVersion: 1,
    bindings: [],
    artifactSnapshots: [],
    settlements: [],
    contextSelections: [],
    activeContextSelections: [],
    outcomes: [],
  };
}

function stableId(prefix: string, identity: unknown): string {
  return `${prefix}_${createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 24)}`;
}

export function codexTaskBindingId(
  input: z.infer<typeof bindCodexTaskInputSchema>,
): string {
  return stableId('cb', input);
}

export function codexArtifactSnapshotId(
  bindingId: string,
  artifactVersion: number,
): string {
  return stableId('cas', { bindingId, artifactVersion });
}

export function codexFeedbackSettlementId(messageId: string): string {
  return stableId('cfs', { messageId });
}

export function codexFeedbackVisibleId(messageId: string): string {
  return stableId('cfeedback', { messageId });
}

export function codexAcceptanceVisibleId(messageId: string): string {
  return stableId('cacceptance', { messageId });
}

export function codexFeedbackSelectionId(identity: unknown): string {
  return stableId('cfcs', identity);
}

export function codexFeedbackOutcomeId(selectionId: string): string {
  return stableId('cfo', { selectionId });
}
