import { createHash } from 'node:crypto';

import { z } from 'zod';

import { redactSecrets } from '../security/redact-secrets.js';
import {
  CODEX_FEEDBACK_CLASSIFICATIONS,
  codexAcceptanceVisibleId,
  codexFeedbackSettlementId,
  codexFeedbackVisibleId,
  type CodexAcceptanceReceipt,
  type CodexArtifactSnapshot,
  type CodexFeedbackSettlement,
  type CodexTaskBinding,
  type CodexVisibleFeedbackSample,
} from '../domain/codex-feedback.js';
import type { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';
import {
  CodexFeedbackVisibleRecordInvalidError,
  type MarkdownCodexFeedbackRepository,
} from '../storage/markdown-codex-feedback-repository.js';
import { readBoundCodexArtifact } from './snapshot-codex-artifact.js';

const inputSchema = z.object({
  bindingId: z.string().regex(/^cb_[0-9a-f]{24}$/u),
  messageId: z.string().trim().min(1).max(200),
  messageContent: z.string().min(1).max(1024 * 1024),
  artifactVersion: z.number().int().positive(),
  classification: z.enum(CODEX_FEEDBACK_CLASSIFICATIONS),
  summary: z.string().trim().min(1).max(2_000),
  applicabilityLabels: z.array(z.string().trim().min(1).max(100)).max(20),
  guidance: z.string().trim().min(1).max(2_000).nullable(),
  captureMode: z.enum(['automatic', 'backfilled_by_v0']),
}).strict();

export type SettleCodexFeedbackInput = z.input<typeof inputSchema>;

export class CodexFeedbackSettlementInvalidError extends Error {
  readonly code = 'codex_feedback_settlement_invalid';

  constructor() {
    super('Codex feedback settlement input or binding is invalid');
    this.name = 'CodexFeedbackSettlementInvalidError';
  }
}

export class CodexFeedbackArtifactDriftError extends Error {
  readonly code = 'codex_feedback_artifact_drift';

  constructor() {
    super('Current Codex Artifact differs from its frozen version');
    this.name = 'CodexFeedbackArtifactDriftError';
  }
}

export class CodexFeedbackMessageConflictError extends Error {
  readonly code = 'codex_feedback_message_conflict';

  constructor() {
    super('Codex message id is already settled with a different identity or judgment');
    this.name = 'CodexFeedbackMessageConflictError';
  }
}

export interface SettleCodexFeedbackDependencies {
  stateRepository: FileCodexFeedbackStateRepository;
  visibleRepository: MarkdownCodexFeedbackRepository;
  clock: () => Date;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function assertArtifactMatchesSnapshot(
  binding: CodexTaskBinding,
  snapshot: CodexArtifactSnapshot,
): Promise<void> {
  const currentArtifact = await readBoundCodexArtifact(binding);
  if (currentArtifact.sha256 !== snapshot.artifactSha256) {
    throw new CodexFeedbackArtifactDriftError();
  }
}

function isExactReplay(
  settlement: CodexFeedbackSettlement,
  input: z.infer<typeof inputSchema>,
  messageSha256: string,
): boolean {
  return settlement.bindingId === input.bindingId
    && settlement.messageId === input.messageId
    && settlement.messageSha256 === messageSha256
    && settlement.artifactVersion === input.artifactVersion
    && settlement.classification === input.classification
    && settlement.summary === input.summary
    && JSON.stringify(settlement.applicabilityLabels) === JSON.stringify(input.applicabilityLabels)
    && settlement.guidance === input.guidance
    && settlement.captureMode === input.captureMode;
}

function assertSameVisibleRecord(
  actual: CodexVisibleFeedbackSample | CodexAcceptanceReceipt,
  expected: CodexVisibleFeedbackSample | CodexAcceptanceReceipt,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CodexFeedbackVisibleRecordInvalidError();
  }
}

function isExactVisibleClaim(
  claim: CodexVisibleFeedbackSample | CodexAcceptanceReceipt,
  binding: {
    bindingId: string;
    threadId: string;
    taskId: string;
    sourceRef: string;
    artifactPath: string;
  },
  snapshot: { artifactVersion: number; artifactSha256: string },
  input: z.infer<typeof inputSchema>,
  messageSha256: string,
): boolean {
  const commonMatches = claim.bindingId === binding.bindingId
    && claim.threadId === binding.threadId
    && claim.taskId === binding.taskId
    && claim.sourceRef === binding.sourceRef
    && claim.artifactRef === binding.artifactPath
    && claim.artifactVersion === snapshot.artifactVersion
    && claim.artifactSha256 === snapshot.artifactSha256
    && claim.messageId === input.messageId
    && claim.messageSha256 === messageSha256
    && claim.summary === input.summary
    && claim.captureMode === input.captureMode;
  if (!commonMatches) return false;
  if ('feedbackId' in claim) {
    return input.classification === 'reusable_correction'
      && claim.feedbackId === codexFeedbackVisibleId(input.messageId)
      && JSON.stringify(claim.applicabilityLabels) === JSON.stringify(input.applicabilityLabels)
      && claim.guidance === input.guidance;
  }
  return input.classification === 'acceptance'
    && claim.acceptanceId === codexAcceptanceVisibleId(input.messageId);
}

export async function settleCodexFeedback(
  dependencies: SettleCodexFeedbackDependencies,
  input: SettleCodexFeedbackInput,
): Promise<{
  settlement: CodexFeedbackSettlement;
  feedback: CodexVisibleFeedbackSample | null;
  created: boolean;
}> {
  const validated = inputSchema.safeParse(input);
  if (!validated.success) throw new CodexFeedbackSettlementInvalidError();
  const parsed = inputSchema.safeParse({
    ...validated.data,
    summary: redactSecrets(validated.data.summary).trim(),
    applicabilityLabels: validated.data.applicabilityLabels.map((label) => (
      redactSecrets(label).trim()
    )),
    guidance: validated.data.guidance === null
      ? null
      : redactSecrets(validated.data.guidance).trim(),
  });
  if (!parsed.success) throw new CodexFeedbackSettlementInvalidError();
  const messageSha256 = sha256(validated.data.messageContent);
  return dependencies.stateRepository.withLock(async () => {
    const state = await dependencies.stateRepository.read();
    const existing = state.settlements.find((candidate) => (
      candidate.messageId === parsed.data.messageId
    ));
    if (existing !== undefined) {
      if (!isExactReplay(existing, parsed.data, messageSha256)) {
        throw new CodexFeedbackMessageConflictError();
      }
    }
    const bindingId = existing?.bindingId ?? parsed.data.bindingId;
    const artifactVersion = existing?.artifactVersion ?? parsed.data.artifactVersion;
    const binding = state.bindings.find((candidate) => (
      candidate.bindingId === bindingId
    ));
    const snapshot = state.artifactSnapshots.find((candidate) => (
      candidate.bindingId === bindingId
      && candidate.artifactVersion === artifactVersion
    ));
    if (binding === undefined || snapshot === undefined) {
      throw new CodexFeedbackSettlementInvalidError();
    }
    return dependencies.stateRepository.withArtifactLock(binding.artifactPath, async () => {
      if (existing !== undefined) {
      let feedback: CodexVisibleFeedbackSample | null = null;
      if (existing.classification === 'reusable_correction') {
        if (existing.visibleRecord === null) {
          throw new CodexFeedbackVisibleRecordInvalidError();
        }
        const persisted = await dependencies.visibleRepository.readFeedback(
          existing.visibleRecord.ref,
          existing.visibleRecord.sha256,
        );
        const expected: CodexVisibleFeedbackSample = {
          schemaVersion: 1,
          feedbackId: codexFeedbackVisibleId(existing.messageId),
          status: 'observing',
          bindingId: binding.bindingId,
          threadId: binding.threadId,
          taskId: binding.taskId,
          sourceRef: binding.sourceRef,
          artifactRef: binding.artifactPath,
          artifactVersion: snapshot.artifactVersion,
          artifactSha256: snapshot.artifactSha256,
          messageId: existing.messageId,
          messageSha256: existing.messageSha256,
          summary: existing.summary,
          applicabilityLabels: existing.applicabilityLabels,
          guidance: existing.guidance,
          captureMode: existing.captureMode,
          createdAt: existing.settledAt,
        };
        assertSameVisibleRecord(persisted.record, expected);
        feedback = persisted.record;
      } else if (existing.classification === 'acceptance') {
        if (existing.visibleRecord === null) {
          throw new CodexFeedbackVisibleRecordInvalidError();
        }
        const persisted = await dependencies.visibleRepository.readAcceptance(
          existing.visibleRecord.ref,
          existing.visibleRecord.sha256,
        );
        const expected: CodexAcceptanceReceipt = {
          schemaVersion: 1,
          acceptanceId: codexAcceptanceVisibleId(existing.messageId),
          bindingId: binding.bindingId,
          threadId: binding.threadId,
          taskId: binding.taskId,
          sourceRef: binding.sourceRef,
          artifactRef: binding.artifactPath,
          artifactVersion: snapshot.artifactVersion,
          artifactSha256: snapshot.artifactSha256,
          messageId: existing.messageId,
          messageSha256: existing.messageSha256,
          summary: existing.summary,
          captureMode: existing.captureMode,
          acceptedAt: existing.settledAt,
        };
        assertSameVisibleRecord(persisted.record, expected);
      } else if (existing.visibleRecord !== null) {
        throw new CodexFeedbackVisibleRecordInvalidError();
      }
      return { settlement: existing, feedback, created: false };
      }
    const visibleClaims = await dependencies.visibleRepository.findMessageClaims(
      parsed.data.messageId,
    );
    if (
      visibleClaims.length > 1
      || (visibleClaims.length === 1 && !isExactVisibleClaim(
        visibleClaims[0]!.record,
        binding,
        snapshot,
        parsed.data,
        messageSha256,
      ))
    ) {
      throw new CodexFeedbackMessageConflictError();
    }
    await assertArtifactMatchesSnapshot(binding, snapshot);
    const settledAt = dependencies.clock().toISOString();
    if (!Number.isFinite(Date.parse(settledAt))) {
      throw new CodexFeedbackSettlementInvalidError();
    }
    let feedback: CodexVisibleFeedbackSample | null = null;
    let visibleRecord: CodexFeedbackSettlement['visibleRecord'] = null;
    let visibleTimestamp = settledAt;
    if (parsed.data.classification === 'reusable_correction') {
      const persisted = await dependencies.visibleRepository.createFeedbackOrGet({
        schemaVersion: 1,
        feedbackId: codexFeedbackVisibleId(parsed.data.messageId),
        status: 'observing',
        bindingId: binding.bindingId,
        threadId: binding.threadId,
        taskId: binding.taskId,
        sourceRef: binding.sourceRef,
        artifactRef: binding.artifactPath,
        artifactVersion: snapshot.artifactVersion,
        artifactSha256: snapshot.artifactSha256,
        messageId: parsed.data.messageId,
        messageSha256,
        summary: parsed.data.summary,
        applicabilityLabels: parsed.data.applicabilityLabels,
        guidance: parsed.data.guidance,
        captureMode: parsed.data.captureMode,
        createdAt: settledAt,
      });
      feedback = persisted.record;
      visibleTimestamp = persisted.record.createdAt;
      visibleRecord = { ref: persisted.ref, sha256: persisted.sha256 };
    } else if (parsed.data.classification === 'acceptance') {
      const persisted = await dependencies.visibleRepository.createAcceptanceOrGet({
        schemaVersion: 1,
        acceptanceId: codexAcceptanceVisibleId(parsed.data.messageId),
        bindingId: binding.bindingId,
        threadId: binding.threadId,
        taskId: binding.taskId,
        sourceRef: binding.sourceRef,
        artifactRef: binding.artifactPath,
        artifactVersion: snapshot.artifactVersion,
        artifactSha256: snapshot.artifactSha256,
        messageId: parsed.data.messageId,
        messageSha256,
        summary: parsed.data.summary,
        captureMode: parsed.data.captureMode,
        acceptedAt: settledAt,
      });
      visibleTimestamp = persisted.record.acceptedAt;
      visibleRecord = { ref: persisted.ref, sha256: persisted.sha256 };
    }
    await assertArtifactMatchesSnapshot(binding, snapshot);
    const settlement: CodexFeedbackSettlement = {
      settlementId: codexFeedbackSettlementId(parsed.data.messageId),
      bindingId: binding.bindingId,
      messageId: parsed.data.messageId,
      messageSha256,
      artifactVersion: parsed.data.artifactVersion,
      classification: parsed.data.classification,
      summary: parsed.data.summary,
      applicabilityLabels: parsed.data.applicabilityLabels,
      guidance: parsed.data.guidance,
      captureMode: parsed.data.captureMode,
      action: parsed.data.classification === 'reusable_correction'
        ? 'feedback_created'
        : parsed.data.classification === 'acceptance'
          ? 'acceptance_created'
          : 'recorded_without_cross_task_asset',
      visibleRecord,
      settledAt: visibleTimestamp,
    };
    state.settlements.push(settlement);
    state.settlements.sort((left, right) => left.settlementId.localeCompare(right.settlementId));
    await dependencies.stateRepository.save(state, {
      beforeCommit: () => assertArtifactMatchesSnapshot(binding, snapshot),
    });
    return { settlement, feedback, created: true };
    });
  });
}
