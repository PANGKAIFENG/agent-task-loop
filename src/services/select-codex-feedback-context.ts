import { z } from 'zod';

import {
  codexFeedbackSelectionId,
  codexFeedbackVisibleId,
  type CodexFeedbackState,
  type CodexFeedbackContextSelection,
  type CodexVisibleFeedbackSample,
} from '../domain/codex-feedback.js';
import type { ContextCandidate } from '../domain/context-manifest.js';
import type { AdditionalLocalContext } from '../runner/context-bundle.js';
import { redactSecrets } from '../security/redact-secrets.js';
import type { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';
import type {
  MarkdownCodexFeedbackRepository,
  PersistedCodexRecord,
} from '../storage/markdown-codex-feedback-repository.js';
import { CodexFeedbackVisibleRecordInvalidError } from '../storage/markdown-codex-feedback-repository.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const inputSchema = z.object({
  targetBindingId: z.string().regex(/^cb_[0-9a-f]{24}$/u),
  decisions: z.array(z.object({
    feedbackId: z.string().regex(/^cfeedback_[0-9a-f]{24}$/u),
    expectedDocumentSha256: sha256Schema,
    decision: z.enum(['selected', 'excluded']),
    reason: z.string().trim().min(1).max(1_000),
  }).strict()).max(1_000),
}).strict();

export type SelectCodexFeedbackContextInput = z.input<typeof inputSchema>;

export interface CodexFeedbackCandidate {
  feedbackId: string;
  bindingId: string;
  taskId: string;
  sourceRef: string;
  status: 'observing';
  summary: string;
  applicabilityLabels: string[];
  guidance: string | null;
  documentRef: string;
  documentPath: string;
  documentSha256: string;
  createdAt: string;
}

export class CodexFeedbackContextDecisionInvalidError extends Error {
  readonly code = 'codex_feedback_context_decision_invalid';

  constructor() {
    super('Every current observing feedback candidate requires one valid decision and reason');
    this.name = 'CodexFeedbackContextDecisionInvalidError';
  }
}

interface ReadDependencies {
  stateRepository: FileCodexFeedbackStateRepository;
  visibleRepository: MarkdownCodexFeedbackRepository;
}

export interface SelectCodexFeedbackContextDependencies extends ReadDependencies {
  clock: () => Date;
}

function candidate(
  persisted: PersistedCodexRecord<CodexVisibleFeedbackSample>,
): CodexFeedbackCandidate {
  return {
    feedbackId: persisted.record.feedbackId,
    bindingId: persisted.record.bindingId,
    taskId: persisted.record.taskId,
    sourceRef: persisted.record.sourceRef,
    status: persisted.record.status,
    summary: persisted.record.summary,
    applicabilityLabels: persisted.record.applicabilityLabels,
    guidance: persisted.record.guidance,
    documentRef: persisted.ref,
    documentPath: persisted.path,
    documentSha256: persisted.sha256,
    createdAt: persisted.record.createdAt,
  };
}

async function verifiedFeedbackRecords(
  dependencies: ReadDependencies,
  state: CodexFeedbackState,
): Promise<Array<PersistedCodexRecord<CodexVisibleFeedbackSample>>> {
  const listed = await dependencies.visibleRepository.listFeedback();
  const reusableSettlements = state.settlements.filter((settlement) => (
    settlement.classification === 'reusable_correction'
  ));
  if (listed.length !== reusableSettlements.length) {
    throw new CodexFeedbackVisibleRecordInvalidError();
  }
  const listedRefs = new Set(listed.map((item) => item.ref));
  const verified: Array<PersistedCodexRecord<CodexVisibleFeedbackSample>> = [];
  for (const settlement of reusableSettlements) {
    if (
      settlement.action !== 'feedback_created'
      || settlement.visibleRecord === null
      || !listedRefs.has(settlement.visibleRecord.ref)
    ) throw new CodexFeedbackVisibleRecordInvalidError();
    const binding = state.bindings.find((item) => item.bindingId === settlement.bindingId);
    const snapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === settlement.bindingId
      && item.artifactVersion === settlement.artifactVersion
    ));
    if (binding === undefined || snapshot === undefined) {
      throw new CodexFeedbackVisibleRecordInvalidError();
    }
    const persisted = await dependencies.visibleRepository.readFeedback(
      settlement.visibleRecord.ref,
      settlement.visibleRecord.sha256,
    );
    const expected: CodexVisibleFeedbackSample = {
      schemaVersion: 1,
      feedbackId: codexFeedbackVisibleId(settlement.messageId),
      status: 'observing',
      bindingId: binding.bindingId,
      threadId: binding.threadId,
      taskId: binding.taskId,
      sourceRef: binding.sourceRef,
      artifactRef: binding.artifactPath,
      artifactVersion: snapshot.artifactVersion,
      artifactSha256: snapshot.artifactSha256,
      messageId: settlement.messageId,
      messageSha256: settlement.messageSha256,
      summary: settlement.summary,
      applicabilityLabels: settlement.applicabilityLabels,
      guidance: settlement.guidance,
      captureMode: settlement.captureMode,
      createdAt: settlement.settledAt,
    };
    if (JSON.stringify(persisted.record) !== JSON.stringify(expected)) {
      throw new CodexFeedbackVisibleRecordInvalidError();
    }
    verified.push(persisted);
  }
  return verified;
}

export async function queryCodexFeedbackCandidates(
  dependencies: ReadDependencies,
  input: { targetBindingId: string },
): Promise<CodexFeedbackCandidate[]> {
  if (!/^cb_[0-9a-f]{24}$/u.test(input.targetBindingId)) {
    throw new CodexFeedbackContextDecisionInvalidError();
  }
  const state = await dependencies.stateRepository.read();
  if (!state.bindings.some((binding) => binding.bindingId === input.targetBindingId)) {
    throw new CodexFeedbackContextDecisionInvalidError();
  }
  return (await verifiedFeedbackRecords(dependencies, state))
    .filter((item) => (
      item.record.status === 'observing'
      && item.record.bindingId !== input.targetBindingId
    ))
    .map(candidate)
    .sort((left, right) => left.feedbackId.localeCompare(right.feedbackId));
}

/** Resolve the same durable activation for production and CLI inspection. */
export function resolveCodexFeedbackActiveSelection(
  state: CodexFeedbackState,
  targetBindingId: string,
): {
  receipt: CodexFeedbackContextSelection | null;
  status: 'active' | 'none' | 'legacy_single' | 'legacy_ambiguous';
} {
  const selections = state.contextSelections.filter((selection) => (
    selection.targetBindingId === targetBindingId
  ));
  const active = state.activeContextSelections?.find((selection) => (
    selection.targetBindingId === targetBindingId
  ));
  if (active !== undefined) {
    const receipt = selections.find((selection) => (
      selection.selectionId === active.selectionId
    ));
    if (receipt === undefined) throw new CodexFeedbackContextDecisionInvalidError();
    return { receipt, status: 'active' };
  }
  // Legacy receipts encode no activation order. Never choose by their clocks.
  if (selections.length > 1) return { receipt: null, status: 'legacy_ambiguous' };
  const receipt = selections[0];
  return receipt === undefined
    ? { receipt: null, status: 'none' }
    : { receipt, status: 'legacy_single' };
}

/** Load verified context only from the persisted active receipt. */
export async function loadSelectedCodexFeedbackContext(
  dependencies: ReadDependencies,
  input: { targetBindingId: string },
): Promise<{
  selectionId: string | null;
  additionalLocalContexts: AdditionalLocalContext[];
  manifestCandidates: ContextCandidate[];
}> {
  if (!/^cb_[0-9a-f]{24}$/u.test(input.targetBindingId)) {
    throw new CodexFeedbackContextDecisionInvalidError();
  }
  const state = await dependencies.stateRepository.read();
  if (!state.bindings.some((binding) => binding.bindingId === input.targetBindingId)) {
    throw new CodexFeedbackContextDecisionInvalidError();
  }
  const { receipt, status } = resolveCodexFeedbackActiveSelection(state, input.targetBindingId);
  if (status === 'legacy_ambiguous') {
    throw new CodexFeedbackContextDecisionInvalidError();
  }
  if (receipt === null) {
    return {
      selectionId: null,
      additionalLocalContexts: [],
      manifestCandidates: [],
    };
  }
  let verifiedRecords: Array<PersistedCodexRecord<CodexVisibleFeedbackSample>>;
  try {
    verifiedRecords = await verifiedFeedbackRecords(dependencies, state);
  } catch (error) {
    if (error instanceof CodexFeedbackVisibleRecordInvalidError) {
      throw new CodexFeedbackContextDecisionInvalidError();
    }
    throw error;
  }
  const byId = new Map(verifiedRecords.map((item) => [item.record.feedbackId, item]));
  const additionalLocalContexts: AdditionalLocalContext[] = [];
  const manifestCandidates: ContextCandidate[] = [];
  let selectedIndex = 0;
  for (const decision of receipt.decisions) {
    const item = byId.get(decision.feedbackId);
    if (
      item === undefined
      || item.record.status !== 'observing'
      || item.record.bindingId === input.targetBindingId
      || item.ref !== decision.documentRef
      || item.sha256 !== decision.documentSha256
    ) {
      throw new CodexFeedbackContextDecisionInvalidError();
    }
    const sourceRef = `codex-feedback://${decision.feedbackId}`;
    if (decision.decision === 'selected') {
      selectedIndex += 1;
      const blockLabel = `codex_feedback_${String(selectedIndex).padStart(3, '0')}`;
      additionalLocalContexts.push({
        label: blockLabel,
        kind: 'feedback',
        category: 'feedback',
        path: item.path,
        sourceRef,
        version: decision.documentSha256,
        expectedSha256: decision.documentSha256,
      });
      manifestCandidates.push({
        candidateId: decision.feedbackId,
        category: 'feedback',
        sourceRef,
        version: decision.documentSha256,
        expectedSha256: decision.documentSha256,
        selection: 'selected',
        selectionReason: decision.reason,
        blockLabel,
      });
    } else {
      manifestCandidates.push({
        candidateId: decision.feedbackId,
        category: 'feedback',
        sourceRef,
        version: decision.documentSha256,
        expectedSha256: decision.documentSha256,
        selection: 'excluded',
        selectionReason: decision.reason,
        exclusionReason: decision.reason,
      });
    }
  }
  return {
    selectionId: receipt.selectionId,
    additionalLocalContexts,
    manifestCandidates,
  };
}

export async function selectCodexFeedbackContext(
  dependencies: SelectCodexFeedbackContextDependencies,
  input: SelectCodexFeedbackContextInput,
): Promise<{
  receipt: CodexFeedbackContextSelection;
  additionalLocalContexts: AdditionalLocalContext[];
  manifestCandidates: ContextCandidate[];
  created: boolean;
}> {
  const validated = inputSchema.safeParse(input);
  if (!validated.success) throw new CodexFeedbackContextDecisionInvalidError();
  const parsed = inputSchema.safeParse({
    ...validated.data,
    decisions: validated.data.decisions.map((decision) => ({
      ...decision,
      reason: redactSecrets(decision.reason).trim(),
    })),
  });
  if (!parsed.success) throw new CodexFeedbackContextDecisionInvalidError();
  return dependencies.stateRepository.withLock(async () => {
    const state = await dependencies.stateRepository.read();
    if (!state.bindings.some((binding) => (
      binding.bindingId === parsed.data.targetBindingId
    ))) throw new CodexFeedbackContextDecisionInvalidError();
    let verifiedRecords: Array<PersistedCodexRecord<CodexVisibleFeedbackSample>>;
    try {
      verifiedRecords = await verifiedFeedbackRecords(dependencies, state);
    } catch (error) {
      if (error instanceof CodexFeedbackVisibleRecordInvalidError) {
        throw new CodexFeedbackContextDecisionInvalidError();
      }
      throw error;
    }
    const persistedCandidates = verifiedRecords
      .filter((item) => (
        item.record.status === 'observing'
        && item.record.bindingId !== parsed.data.targetBindingId
      ))
      .sort((left, right) => left.record.feedbackId.localeCompare(
        right.record.feedbackId,
      ));
    const byId = new Map(persistedCandidates.map((item) => [
      item.record.feedbackId,
      item,
    ]));
    const decisionsById = new Map<string, (typeof parsed.data.decisions)[number]>();
    for (const decision of parsed.data.decisions) {
      if (decisionsById.has(decision.feedbackId)) {
        throw new CodexFeedbackContextDecisionInvalidError();
      }
      decisionsById.set(decision.feedbackId, decision);
    }
    if (
      decisionsById.size !== byId.size
      || [...byId.keys()].some((feedbackId) => !decisionsById.has(feedbackId))
      || [...decisionsById.keys()].some((feedbackId) => !byId.has(feedbackId))
    ) throw new CodexFeedbackContextDecisionInvalidError();

    const decisions = persistedCandidates.map((item) => {
      const decision = decisionsById.get(item.record.feedbackId)!;
      if (decision.expectedDocumentSha256 !== item.sha256) {
        throw new CodexFeedbackContextDecisionInvalidError();
      }
      return {
        feedbackId: item.record.feedbackId,
        decision: decision.decision,
        reason: decision.reason,
        documentRef: item.ref,
        documentSha256: item.sha256,
      };
    });
    const identity = {
      targetBindingId: parsed.data.targetBindingId,
      decisions,
    };
    const selectionId = codexFeedbackSelectionId(identity);
    const existing = state.contextSelections.find((selection) => (
      selection.selectionId === selectionId
    ));
    let receipt: CodexFeedbackContextSelection;
    let created: boolean;
    if (existing !== undefined) {
      receipt = existing;
      created = false;
    } else {
      const createdAt = dependencies.clock().toISOString();
      if (!Number.isFinite(Date.parse(createdAt))) {
        throw new CodexFeedbackContextDecisionInvalidError();
      }
      receipt = {
        selectionId,
        targetBindingId: parsed.data.targetBindingId,
        decisions,
        selectedFeedbackIds: decisions
          .filter((decision) => decision.decision === 'selected')
          .map((decision) => decision.feedbackId),
        createdAt,
      };
      state.contextSelections.push(receipt);
      state.contextSelections.sort((left, right) => (
        left.selectionId.localeCompare(right.selectionId)
      ));
      created = true;
    }

    const active = state.activeContextSelections?.find((selection) => (
      selection.targetBindingId === parsed.data.targetBindingId
    ));
    if (created || active?.selectionId !== selectionId) {
      state.activeContextSelections = [
        ...(state.activeContextSelections ?? []).filter((selection) => (
          selection.targetBindingId !== parsed.data.targetBindingId
        )),
        { targetBindingId: parsed.data.targetBindingId, selectionId },
      ].sort((left, right) => left.targetBindingId.localeCompare(right.targetBindingId));
      await dependencies.stateRepository.save(state);
    }

    let selectedIndex = 0;
    const additionalLocalContexts: AdditionalLocalContext[] = [];
    const manifestCandidates: ContextCandidate[] = [];
    for (const decision of receipt.decisions) {
      const item = byId.get(decision.feedbackId)!;
      const sourceRef = `codex-feedback://${decision.feedbackId}`;
      if (decision.decision === 'selected') {
        selectedIndex += 1;
        const blockLabel = `codex_feedback_${String(selectedIndex).padStart(3, '0')}`;
        additionalLocalContexts.push({
          label: blockLabel,
          kind: 'feedback',
          category: 'feedback',
          path: item.path,
          sourceRef,
          version: decision.documentSha256,
          expectedSha256: decision.documentSha256,
        });
        manifestCandidates.push({
          candidateId: decision.feedbackId,
          category: 'feedback',
          sourceRef,
          version: decision.documentSha256,
          expectedSha256: decision.documentSha256,
          selection: 'selected',
          selectionReason: decision.reason,
          blockLabel,
        });
      } else {
        manifestCandidates.push({
          candidateId: decision.feedbackId,
          category: 'feedback',
          sourceRef,
          version: decision.documentSha256,
          expectedSha256: decision.documentSha256,
          selection: 'excluded',
          selectionReason: decision.reason,
          exclusionReason: decision.reason,
        });
      }
    }
    return { receipt, additionalLocalContexts, manifestCandidates, created };
  });
}
