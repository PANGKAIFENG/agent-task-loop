import { describe, expect, it } from 'vitest';

import {
  codexArtifactSnapshotId,
  codexFeedbackOutcomeId,
  codexFeedbackSelectionId,
  codexFeedbackSettlementId,
  codexFeedbackStateSchema,
  codexFeedbackVisibleId,
  codexTaskBindingId,
  type CodexFeedbackState,
} from '../../../src/domain/codex-feedback.js';

function validState(): CodexFeedbackState {
  const bindingInput = {
    threadId: 'thread-synthetic-state-001',
    taskId: 'task-synthetic-state-001',
    sourceRef: '笔记同步助手/2026-09-07/synthetic.md#state',
    sourceSha256: 'a'.repeat(64),
    artifactRoot: '/tmp/synthetic-artifacts',
    artifactPath: '/tmp/synthetic-artifacts/task/report.md',
    experimentId: 'experiment-synthetic-state-001',
  };
  const bindingId = codexTaskBindingId(bindingInput);
  const messageId = 'message-synthetic-state-001';
  const feedbackId = codexFeedbackVisibleId(messageId);
  const decisions = [{
    feedbackId,
    decision: 'selected' as const,
    reason: 'This synthetic feedback is relevant.',
    documentRef: `07_System/Task_Intake/Feedback/2026/09/${feedbackId}.md`,
    documentSha256: 'd'.repeat(64),
  }];
  const selectionId = codexFeedbackSelectionId({ targetBindingId: bindingId, decisions });
  return {
    schemaVersion: 1,
    bindings: [{
      ...bindingInput,
      bindingId,
      createdAt: '2026-09-07T02:00:00.000Z',
    }],
    artifactSnapshots: [{
      snapshotId: codexArtifactSnapshotId(bindingId, 1),
      bindingId,
      artifactVersion: 1,
      artifactSha256: 'b'.repeat(64),
      capturedAt: '2026-09-07T02:01:00.000Z',
    }],
    settlements: [{
      settlementId: codexFeedbackSettlementId(messageId),
      bindingId,
      messageId,
      messageSha256: 'c'.repeat(64),
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Synthetic correction.',
      applicabilityLabels: ['synthetic'],
      guidance: 'Apply only in synthetic tests.',
      captureMode: 'automatic',
      action: 'feedback_created',
      visibleRecord: {
        ref: decisions[0]!.documentRef,
        sha256: decisions[0]!.documentSha256,
      },
      settledAt: '2026-09-07T02:02:00.000Z',
    }],
    contextSelections: [{
      selectionId,
      targetBindingId: bindingId,
      decisions,
      selectedFeedbackIds: [feedbackId],
      createdAt: '2026-09-07T02:03:00.000Z',
    }],
    outcomes: [{
      outcomeId: codexFeedbackOutcomeId(selectionId),
      selectionId,
      targetBindingId: bindingId,
      outcome: 'hit',
      evidenceSummary: 'Synthetic evidence.',
      artifactRef: bindingInput.artifactPath,
      visibleRecord: {
        ref: `07_System/Task_Intake/Feedback_Outcomes/2026/09/${codexFeedbackOutcomeId(selectionId)}.md`,
        sha256: 'e'.repeat(64),
      },
      recordedAt: '2026-09-07T02:04:00.000Z',
    }],
  };
}

describe('codexFeedbackStateSchema', () => {
  it('validates active pointers without requiring them in legacy state', () => {
    const state = validState();
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(true);
    const active = {
      targetBindingId: state.bindings[0]!.bindingId,
      selectionId: state.contextSelections[0]!.selectionId,
    };
    state.activeContextSelections = [active];
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(true);
    state.activeContextSelections = [active, active];
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(false);
    state.activeContextSelections = [{ ...active, selectionId: `cfcs_${'f'.repeat(24)}` }];
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(false);
    state.activeContextSelections = [{ ...active, targetBindingId: `cb_${'f'.repeat(24)}` }];
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(false);
  });

  it('accepts a coherent state graph', () => {
    expect(codexFeedbackStateSchema.safeParse(validState()).success).toBe(true);
  });

  it.each([
    ['binding id', (state: CodexFeedbackState) => {
      state.bindings.push(structuredClone(state.bindings[0]!));
    }],
    ['thread id', (state: CodexFeedbackState) => {
      state.bindings.push({
        ...structuredClone(state.bindings[0]!),
        bindingId: `cb_${'1'.repeat(24)}`,
        taskId: 'task-synthetic-state-002',
      });
    }],
    ['task id', (state: CodexFeedbackState) => {
      state.bindings.push({
        ...structuredClone(state.bindings[0]!),
        bindingId: `cb_${'2'.repeat(24)}`,
        threadId: 'thread-synthetic-state-002',
      });
    }],
    ['Artifact snapshot pair', (state: CodexFeedbackState) => {
      state.artifactSnapshots.push({
        ...structuredClone(state.artifactSnapshots[0]!),
        snapshotId: `cas_${'3'.repeat(24)}`,
      });
    }],
    ['message id', (state: CodexFeedbackState) => {
      state.settlements.push({
        ...structuredClone(state.settlements[0]!),
        settlementId: `cfs_${'4'.repeat(24)}`,
      });
    }],
    ['selection id', (state: CodexFeedbackState) => {
      state.contextSelections.push(structuredClone(state.contextSelections[0]!));
    }],
    ['outcome selection', (state: CodexFeedbackState) => {
      state.outcomes.push({
        ...structuredClone(state.outcomes[0]!),
        outcomeId: `cfo_${'5'.repeat(24)}`,
      });
    }],
  ])('rejects a duplicate %s', (_label, mutate) => {
    const state = validState();
    mutate(state);
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(false);
  });

  it('rejects a selection whose selected ids disagree with its decisions', () => {
    const state = validState();
    state.contextSelections[0]!.selectedFeedbackIds = [];
    expect(codexFeedbackStateSchema.safeParse(state).success).toBe(false);
  });
});
