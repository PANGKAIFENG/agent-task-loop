import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  codexAcceptanceVisibleId,
  codexFeedbackVisibleId,
} from '../../../src/domain/codex-feedback.js';
import { bindCodexTask } from '../../../src/services/bind-codex-task.js';
import { settleCodexFeedback } from '../../../src/services/settle-codex-feedback.js';
import { snapshotCodexArtifact } from '../../../src/services/snapshot-codex-artifact.js';
import { withCodexArtifactLock } from '../../../src/storage/codex-artifact-lock.js';
import { FileCodexFeedbackStateRepository } from '../../../src/storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../../../src/storage/markdown-codex-feedback-repository.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const roots: string[] = [];
const NOW = new Date('2026-09-07T03:00:00.000Z');

async function fixture(): Promise<{
  root: string;
  artifactPath: string;
  bindingId: string;
  state: FileCodexFeedbackStateRepository;
  visible: MarkdownCodexFeedbackRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-settlement-'));
  roots.push(root);
  const artifactRoot = join(root, 'artifacts');
  const artifactPath = join(artifactRoot, 'task-synthetic-001', 'report.md');
  const sourceContent = '# Synthetic source\n';
  const sourcePath = join(root, '笔记同步助手', '2026-09-07', 'synthetic.md');
  await mkdir(join(sourcePath, '..'), { recursive: true });
  await writeFile(sourcePath, sourceContent, 'utf8');
  await mkdir(join(artifactRoot, 'task-synthetic-001'), { recursive: true });
  await writeFile(artifactPath, '# Reviewable result\n', 'utf8');
  const state = new FileCodexFeedbackStateRepository(
    join(root, '.atl-runtime', 'codex-feedback'),
  );
  const { binding } = await bindCodexTask({ repository: state, clock: () => NOW }, {
    threadId: 'thread-synthetic-001',
    taskId: 'task-synthetic-001',
    sourceRef: '笔记同步助手/2026-09-07/synthetic.md#todo-1',
    sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
    artifactRoot,
    artifactPath,
    experimentId: 'experiment-synthetic-001',
  });
  await snapshotCodexArtifact({ repository: state, clock: () => NOW }, {
    bindingId: binding.bindingId,
    artifactVersion: 1,
  });
  return {
    root,
    artifactPath: binding.artifactPath,
    bindingId: binding.bindingId,
    state,
    visible: new MarkdownCodexFeedbackRepository(root),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Codex feedback settlement', () => {
  it('creates one observing reusable correction without persisting the raw message', async () => {
    const context = await fixture();
    const rawMessage = 'RAW_MESSAGE_SENTINEL: make the conclusion actionable.';

    const result = await settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      bindingId: context.bindingId,
      messageId: 'message-synthetic-001',
      messageContent: rawMessage,
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Keep the analysis deep, but make the primary report decision-oriented.',
      applicabilityLabels: ['research_report', 'decision_support'],
      guidance: 'Lead with the conclusion and move process evidence to the run summary.',
      captureMode: 'automatic',
    });

    expect(result).toMatchObject({
      created: true,
      settlement: {
        bindingId: context.bindingId,
        messageId: 'message-synthetic-001',
        classification: 'reusable_correction',
        action: 'feedback_created',
        captureMode: 'automatic',
        visibleRecord: {
          ref: expect.stringContaining('07_System/Task_Intake/Feedback/2026/09/'),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
      feedback: {
        status: 'observing',
        bindingId: context.bindingId,
        taskId: 'task-synthetic-001',
        threadId: 'thread-synthetic-001',
        sourceRef: '笔记同步助手/2026-09-07/synthetic.md#todo-1',
        artifactRef: context.artifactPath,
      },
    });

    const visiblePath = join(context.root, result.settlement.visibleRecord!.ref);
    const [visibleRaw, stateRaw] = await Promise.all([
      readFile(visiblePath, 'utf8'),
      readFile(join(context.root, '.atl-runtime', 'codex-feedback', 'state.json'), 'utf8'),
    ]);
    expect(visibleRaw).toContain(`binding_id: ${context.bindingId}`);
    expect(visibleRaw).toContain('source_ref: 笔记同步助手/2026-09-07/synthetic.md#todo-1');
    expect(visibleRaw).toContain(`artifact_ref: ${context.artifactPath}`);
    expect(`${visibleRaw}\n${stateRaw}`).not.toContain(rawMessage);
  });

  it('creates only the visible asset allowed by the classification', async () => {
    const accepted = await fixture();
    const acceptance = await settleCodexFeedback({
      stateRepository: accepted.state,
      visibleRepository: accepted.visible,
      clock: () => NOW,
    }, {
      bindingId: accepted.bindingId,
      messageId: 'message-acceptance-001',
      messageContent: 'This result is accepted.',
      artifactVersion: 1,
      classification: 'acceptance',
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic',
    });
    expect(acceptance).toMatchObject({
      settlement: {
        action: 'acceptance_created',
        visibleRecord: {
          ref: expect.stringContaining('07_System/Task_Intake/Acceptance/2026/09/'),
        },
      },
      feedback: null,
    });

    for (const [index, classification] of ([
      'rejection',
      'clarification',
      'one_off_preference',
    ] as const).entries()) {
      const context = await fixture();
      const result = await settleCodexFeedback({
        stateRepository: context.state,
        visibleRepository: context.visible,
        clock: () => NOW,
      }, {
        bindingId: context.bindingId,
        messageId: `message-task-local-${index}`,
        messageContent: `Task-local response ${index}`,
        artifactVersion: 1,
        classification,
        summary: `Task-local settlement ${index}.`,
        applicabilityLabels: [],
        guidance: null,
        captureMode: 'automatic',
      });
      expect(result).toMatchObject({
        settlement: {
          action: 'recorded_without_cross_task_asset',
          visibleRecord: null,
        },
        feedback: null,
      });
      await expect(access(join(
        context.root,
        '07_System',
        'Task_Intake',
      ))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('replays exact messages and rejects conflicting reuse or Artifact drift before visible writes', async () => {
    const context = await fixture();
    const input = {
      bindingId: context.bindingId,
      messageId: 'message-replay-001',
      messageContent: 'Reusable display guidance.',
      artifactVersion: 1,
      classification: 'reusable_correction' as const,
      summary: 'Show the full decision surface in the primary report.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Keep process evidence in a secondary run summary.',
      captureMode: 'automatic' as const,
    };
    const dependencies = {
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    };

    const first = await settleCodexFeedback(dependencies, input);
    await expect(settleCodexFeedback(dependencies, input)).resolves.toEqual({
      ...first,
      created: false,
    });
    await expect(settleCodexFeedback(dependencies, {
      ...input,
      messageContent: 'Different content under the same message id.',
    })).rejects.toMatchObject({ code: 'codex_feedback_message_conflict' });

    const drifted = await fixture();
    await writeFile(drifted.artifactPath, '# Mutated after snapshot\n', 'utf8');
    await expect(settleCodexFeedback({
      stateRepository: drifted.state,
      visibleRepository: drifted.visible,
      clock: () => NOW,
    }, {
      ...input,
      bindingId: drifted.bindingId,
      messageId: 'message-drift-001',
    })).rejects.toMatchObject({ code: 'codex_feedback_artifact_drift' });
    await expect(access(join(
      drifted.root,
      '07_System',
      'Task_Intake',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a replayed Feedback or Acceptance document is missing or changed', async () => {
    const feedbackContext = await fixture();
    const feedbackInput = {
      bindingId: feedbackContext.bindingId,
      messageId: 'message-replay-feedback-readback-001',
      messageContent: 'Reusable feedback with durable readback.',
      artifactVersion: 1,
      classification: 'reusable_correction' as const,
      summary: 'Keep the decision visible.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Lead with the decision.',
      captureMode: 'automatic' as const,
    };
    const feedbackDependencies = {
      stateRepository: feedbackContext.state,
      visibleRepository: feedbackContext.visible,
      clock: () => NOW,
    };
    const feedback = await settleCodexFeedback(feedbackDependencies, feedbackInput);
    await rm(join(feedbackContext.root, feedback.settlement.visibleRecord!.ref));
    await expect(settleCodexFeedback(feedbackDependencies, feedbackInput)).rejects.toMatchObject({
      code: 'codex_feedback_visible_record_invalid',
    });

    const acceptanceContext = await fixture();
    const acceptanceInput = {
      bindingId: acceptanceContext.bindingId,
      messageId: 'message-replay-acceptance-readback-001',
      messageContent: 'Accepted.',
      artifactVersion: 1,
      classification: 'acceptance' as const,
      summary: 'The user accepted this version.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic' as const,
    };
    const acceptanceDependencies = {
      stateRepository: acceptanceContext.state,
      visibleRepository: acceptanceContext.visible,
      clock: () => NOW,
    };
    const acceptance = await settleCodexFeedback(acceptanceDependencies, acceptanceInput);
    const acceptancePath = join(
      acceptanceContext.root,
      acceptance.settlement.visibleRecord!.ref,
    );
    await writeFile(
      acceptancePath,
      `${await readFile(acceptancePath, 'utf8')}\nExternal edit.\n`,
      'utf8',
    );
    await expect(settleCodexFeedback(
      acceptanceDependencies,
      acceptanceInput,
    )).rejects.toMatchObject({ code: 'codex_feedback_visible_record_invalid' });
  });

  it('recovers an earlier visible write without creating a second monthly record', async () => {
    const context = await fixture();
    const messageId = 'message-crash-recovery-001';
    const messageContent = 'Make the result decision-oriented.';
    const state = await context.state.read();
    const binding = state.bindings.find((item) => item.bindingId === context.bindingId)!;
    const snapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === context.bindingId && item.artifactVersion === 1
    ))!;
    const visible = await context.visible.createFeedbackOrGet({
      schemaVersion: 1,
      feedbackId: codexFeedbackVisibleId(messageId),
      status: 'observing',
      bindingId: binding.bindingId,
      threadId: binding.threadId,
      taskId: binding.taskId,
      sourceRef: binding.sourceRef,
      artifactRef: binding.artifactPath,
      artifactVersion: snapshot.artifactVersion,
      artifactSha256: snapshot.artifactSha256,
      messageId,
      messageSha256: createHash('sha256').update(messageContent).digest('hex'),
      summary: 'Make the primary report decision-oriented.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Lead with the conclusion and trade-offs.',
      captureMode: 'automatic',
      createdAt: '2026-08-31T23:59:59.000Z',
    });
    const renamedPath = join(dirname(visible.path), 'renamed-crash-recovery-record.md');
    await rename(visible.path, renamedPath);
    const renamedRef = relative(context.root, renamedPath);

    const recovered = await settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => new Date('2026-09-01T00:00:01.000Z'),
    }, {
      bindingId: context.bindingId,
      messageId,
      messageContent,
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Make the primary report decision-oriented.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Lead with the conclusion and trade-offs.',
      captureMode: 'automatic',
    });

    expect(recovered).toMatchObject({
      created: true,
      feedback: { createdAt: visible.record.createdAt },
      settlement: {
        visibleRecord: { ref: renamedRef, sha256: visible.sha256 },
      },
    });
    expect(await context.visible.listFeedback()).toHaveLength(1);
    expect((await context.state.read()).settlements).toHaveLength(1);
  });

  it('rejects a crash-recovery Markdown record whose body changed after publication', async () => {
    const context = await fixture();
    const messageId = 'message-crash-recovery-body-tamper-001';
    const messageContent = 'Keep the primary result focused on the decision.';
    const state = await context.state.read();
    const binding = state.bindings.find((item) => item.bindingId === context.bindingId)!;
    const snapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === context.bindingId && item.artifactVersion === 1
    ))!;
    const visible = await context.visible.createFeedbackOrGet({
      schemaVersion: 1,
      feedbackId: codexFeedbackVisibleId(messageId),
      status: 'observing',
      bindingId: binding.bindingId,
      threadId: binding.threadId,
      taskId: binding.taskId,
      sourceRef: binding.sourceRef,
      artifactRef: binding.artifactPath,
      artifactVersion: snapshot.artifactVersion,
      artifactSha256: snapshot.artifactSha256,
      messageId,
      messageSha256: createHash('sha256').update(messageContent).digest('hex'),
      summary: 'Keep the primary result decision-oriented.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Lead with the conclusion and trade-offs.',
      captureMode: 'automatic',
      createdAt: '2026-09-07T03:00:00.000Z',
    });
    await writeFile(
      visible.path,
      `${await readFile(visible.path, 'utf8')}\nUnreviewed appended body.\n`,
      'utf8',
    );

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => new Date('2026-09-07T03:01:00.000Z'),
    }, {
      bindingId: context.bindingId,
      messageId,
      messageContent,
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Keep the primary result decision-oriented.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Lead with the conclusion and trade-offs.',
      captureMode: 'automatic',
    })).rejects.toMatchObject({ code: 'codex_feedback_visible_record_conflict' });
  });

  it('rejects cross-binding and cross-classification reuse of an orphaned message id', async () => {
    const context = await fixture();
    const messageId = 'message-orphaned-cross-binding-001';
    const messageContent = 'This message identity belongs to the first task.';
    const state = await context.state.read();
    const sourceBinding = state.bindings.find((item) => item.bindingId === context.bindingId)!;
    const sourceSnapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === context.bindingId && item.artifactVersion === 1
    ))!;
    const visible = await context.visible.createFeedbackOrGet({
      schemaVersion: 1,
      feedbackId: codexFeedbackVisibleId(messageId),
      status: 'observing',
      bindingId: sourceBinding.bindingId,
      threadId: sourceBinding.threadId,
      taskId: sourceBinding.taskId,
      sourceRef: sourceBinding.sourceRef,
      artifactRef: sourceBinding.artifactPath,
      artifactVersion: sourceSnapshot.artifactVersion,
      artifactSha256: sourceSnapshot.artifactSha256,
      messageId,
      messageSha256: createHash('sha256').update(messageContent).digest('hex'),
      summary: 'Keep this correction attached to the first task.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Do not reuse its message identity elsewhere.',
      captureMode: 'automatic',
      createdAt: NOW.toISOString(),
    });
    await rename(
      visible.path,
      join(dirname(visible.path), 'renamed-orphaned-feedback-record.md'),
    );

    const targetArtifactPath = join(context.root, 'artifacts', 'task-synthetic-002', 'report.md');
    await mkdir(join(targetArtifactPath, '..'), { recursive: true });
    await writeFile(targetArtifactPath, '# Second reviewable result\n', 'utf8');
    const target = await bindCodexTask({ repository: context.state, clock: () => NOW }, {
      threadId: 'thread-synthetic-002',
      taskId: 'task-synthetic-002',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#todo-2',
      sourceSha256: createHash('sha256').update('# Synthetic source\n').digest('hex'),
      artifactRoot: join(context.root, 'artifacts'),
      artifactPath: targetArtifactPath,
      experimentId: 'experiment-synthetic-001',
    });
    await snapshotCodexArtifact({ repository: context.state, clock: () => NOW }, {
      bindingId: target.binding.bindingId,
      artifactVersion: 1,
    });

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      bindingId: target.binding.bindingId,
      messageId,
      messageContent,
      artifactVersion: 1,
      classification: 'acceptance',
      summary: 'The user accepted the second task.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic',
    })).rejects.toMatchObject({ code: 'codex_feedback_message_conflict' });
    await expect(access(join(
      context.root,
      '07_System',
      'Task_Intake',
      'Acceptance',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a hidden orphaned Feedback claim before acceptance can reuse its message id', async () => {
    const context = await fixture();
    const messageId = 'message-hidden-orphaned-feedback-001';
    const messageContent = 'This message was already published as reusable feedback.';
    const state = await context.state.read();
    const binding = state.bindings.find((item) => item.bindingId === context.bindingId)!;
    const snapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === context.bindingId && item.artifactVersion === 1
    ))!;
    const visible = await context.visible.createFeedbackOrGet({
      schemaVersion: 1,
      feedbackId: codexFeedbackVisibleId(messageId),
      status: 'observing',
      bindingId: binding.bindingId,
      threadId: binding.threadId,
      taskId: binding.taskId,
      sourceRef: binding.sourceRef,
      artifactRef: binding.artifactPath,
      artifactVersion: snapshot.artifactVersion,
      artifactSha256: snapshot.artifactSha256,
      messageId,
      messageSha256: createHash('sha256').update(messageContent).digest('hex'),
      summary: 'Keep this correction classified as reusable feedback.',
      applicabilityLabels: ['decision_support'],
      guidance: 'Do not reuse its message identity for acceptance.',
      captureMode: 'automatic',
      createdAt: NOW.toISOString(),
    });
    await rename(
      visible.path,
      join(dirname(visible.path), '.renamed-orphaned-feedback-record.md'),
    );

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      bindingId: context.bindingId,
      messageId,
      messageContent,
      artifactVersion: 1,
      classification: 'acceptance',
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic',
    })).rejects.toMatchObject({ code: 'codex_feedback_message_conflict' });
    expect((await context.state.read()).settlements).toHaveLength(0);
  });

  it('rejects Artifact drift introduced while publishing an acceptance record', async () => {
    const context = await fixture();
    const originalCreate = context.visible.createAcceptanceOrGet.bind(context.visible);
    context.visible.createAcceptanceOrGet = async (record) => {
      const persisted = await originalCreate(record);
      await writeFile(context.artifactPath, '# Artifact changed during settlement\n', 'utf8');
      return persisted;
    };
    const input = {
      bindingId: context.bindingId,
      messageId: 'message-artifact-publish-race-001',
      messageContent: 'The frozen Artifact is accepted.',
      artifactVersion: 1,
      classification: 'acceptance' as const,
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic' as const,
    };

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, input)).rejects.toMatchObject({ code: 'codex_feedback_artifact_drift' });
    expect((await context.state.read()).settlements).toHaveLength(0);

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: new MarkdownCodexFeedbackRepository(context.root),
      clock: () => NOW,
    }, input)).rejects.toMatchObject({ code: 'codex_feedback_artifact_drift' });
    expect((await context.state.read()).settlements).toHaveLength(0);
  });

  it('rejects Artifact drift introduced after final validation and before state commit', async () => {
    const context = await fixture();
    const originalSave = context.state.save.bind(context.state);
    let mutated = false;
    context.state.save = async (state, options) => {
      if (!mutated && state.settlements.length === 1) {
        mutated = true;
        await writeFile(context.artifactPath, '# Artifact changed before state commit\n', 'utf8');
      }
      return originalSave(state, options);
    };
    const input = {
      bindingId: context.bindingId,
      messageId: 'message-artifact-save-race-001',
      messageContent: 'The frozen Artifact is accepted.',
      artifactVersion: 1,
      classification: 'acceptance' as const,
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic' as const,
    };

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, input)).rejects.toMatchObject({ code: 'codex_feedback_artifact_drift' });
    expect(mutated).toBe(true);
    expect((await context.state.read()).settlements).toHaveLength(0);
    await expect(access(join(
      context.root,
      '07_System',
      'Task_Intake',
      'Acceptance',
    ))).resolves.toBeUndefined();

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: new MarkdownCodexFeedbackRepository(context.root),
      clock: () => NOW,
    }, input)).rejects.toMatchObject({ code: 'codex_feedback_artifact_drift' });
    expect((await context.state.read()).settlements).toHaveLength(0);
  });

  it('holds the shared Artifact lock until settlement has committed state', async () => {
    const context = await fixture();
    const originalCreate = context.visible.createAcceptanceOrGet.bind(context.visible);
    const originalSave = context.state.save.bind(context.state);
    let writerStarted = false;
    let committedSettlementsAtWriterStart = -1;
    let checkedCommitBoundary = false;
    let writer: Promise<void> | undefined;
    context.state.save = async (state, options) => {
      await originalSave(state, options);
      if (state.settlements.length === 1) {
        expect(writerStarted).toBe(false);
        expect(await readFile(context.artifactPath, 'utf8')).toBe('# Reviewable result\n');
        checkedCommitBoundary = true;
      }
    };
    context.visible.createAcceptanceOrGet = async (record) => {
      const persisted = await originalCreate(record);
      writer = withCodexArtifactLock(context.root, context.artifactPath, async () => {
        writerStarted = true;
        committedSettlementsAtWriterStart = (await context.state.read()).settlements.length;
        await writeFile(context.artifactPath, '# Artifact changed after settlement\n', 'utf8');
      });
      // Give a competing internal writer a chance to acquire the lock. It must
      // remain blocked while settlement performs its final validation and save.
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      return persisted;
    };

    const result = await settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      bindingId: context.bindingId,
      messageId: 'message-artifact-lock-window-001',
      messageContent: 'The frozen Artifact is accepted.',
      artifactVersion: 1,
      classification: 'acceptance',
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic',
    });

    expect(result.created).toBe(true);
    expect(checkedCommitBoundary).toBe(true);
    expect((await context.state.read()).settlements).toHaveLength(1);
    await writer;
    expect(committedSettlementsAtWriterStart).toBe(1);
    expect(await readFile(context.artifactPath, 'utf8')).toBe(
      '# Artifact changed after settlement\n',
    );
  });

  it('preserves the original acceptance time across crash recovery and exact replay', async () => {
    const context = await fixture();
    const messageId = 'message-acceptance-crash-recovery-001';
    const messageContent = 'The first Artifact is accepted.';
    const acceptedAt = '2026-08-31T23:59:59.000Z';
    const state = await context.state.read();
    const binding = state.bindings.find((item) => item.bindingId === context.bindingId)!;
    const snapshot = state.artifactSnapshots.find((item) => (
      item.bindingId === context.bindingId && item.artifactVersion === 1
    ))!;
    const visible = await context.visible.createAcceptanceOrGet({
      schemaVersion: 1,
      acceptanceId: codexAcceptanceVisibleId(messageId),
      bindingId: binding.bindingId,
      threadId: binding.threadId,
      taskId: binding.taskId,
      sourceRef: binding.sourceRef,
      artifactRef: binding.artifactPath,
      artifactVersion: snapshot.artifactVersion,
      artifactSha256: snapshot.artifactSha256,
      messageId,
      messageSha256: createHash('sha256').update(messageContent).digest('hex'),
      summary: 'The user accepted Artifact version 1.',
      captureMode: 'automatic',
      acceptedAt,
    });
    const input = {
      bindingId: context.bindingId,
      messageId,
      messageContent,
      artifactVersion: 1,
      classification: 'acceptance' as const,
      summary: 'The user accepted Artifact version 1.',
      applicabilityLabels: [],
      guidance: null,
      captureMode: 'automatic' as const,
    };
    const dependencies = {
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => new Date('2026-09-01T00:00:01.000Z'),
    };

    const recovered = await settleCodexFeedback(dependencies, input);
    expect(recovered.settlement.settledAt).toBe(acceptedAt);
    await expect(settleCodexFeedback(dependencies, input)).resolves.toEqual({
      ...recovered,
      created: false,
    });
    expect(recovered.settlement.visibleRecord).toEqual({
      ref: visible.ref,
      sha256: visible.sha256,
    });
  });

  it('redacts credentials in persisted summaries and reusable guidance', async () => {
    const context = await fixture();
    const summarySecret = 'codex-private-summary-value';
    const guidanceSecret = 'codex-private-guidance-value';
    const result = await settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      bindingId: context.bindingId,
      messageId: 'message-secret-redaction-001',
      messageContent: 'The private reply is hashed only.',
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: `Keep the report concise; api_key=${summarySecret}`,
      applicabilityLabels: ['research_report'],
      guidance: `Use this rule with Bearer ${guidanceSecret}.`,
      captureMode: 'automatic',
    });

    const persisted = [
      await readFile(join(context.root, result.settlement.visibleRecord!.ref), 'utf8'),
      await readFile(join(context.root, '.atl-runtime', 'codex-feedback', 'state.json'), 'utf8'),
    ].join('\n');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).not.toContain(summarySecret);
    expect(persisted).not.toContain(guidanceSecret);
  });

  it('rejects visible writes authorized for another Vault without creating Task Intake paths', async () => {
    const context = await fixture();
    const otherRoot = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-other-vault-'));
    roots.push(otherRoot);
    const unauthorized = new MarkdownCodexFeedbackRepository(context.root, {
      writeAuthorization: createVaultWriteAuthorization(otherRoot),
    });

    await expect(settleCodexFeedback({
      stateRepository: context.state,
      visibleRepository: unauthorized,
      clock: () => NOW,
    }, {
      bindingId: context.bindingId,
      messageId: 'message-visible-unauthorized-001',
      messageContent: 'This must not be written.',
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'Synthetic correction.',
      applicabilityLabels: ['synthetic'],
      guidance: 'Synthetic guidance.',
      captureMode: 'automatic',
    })).rejects.toThrow('Vault writes are disabled');
    await expect(access(join(
      context.root,
      '07_System',
      'Task_Intake',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
