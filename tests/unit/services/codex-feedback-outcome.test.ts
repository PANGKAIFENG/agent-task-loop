import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bindCodexTask } from '../../../src/services/bind-codex-task.js';
import { recordCodexFeedbackOutcome } from '../../../src/services/record-codex-feedback-outcome.js';
import {
  queryCodexFeedbackCandidates,
  selectCodexFeedbackContext,
} from '../../../src/services/select-codex-feedback-context.js';
import { settleCodexFeedback } from '../../../src/services/settle-codex-feedback.js';
import { snapshotCodexArtifact } from '../../../src/services/snapshot-codex-artifact.js';
import { FileCodexFeedbackStateRepository } from '../../../src/storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../../../src/storage/markdown-codex-feedback-repository.js';

const NOW = new Date('2026-09-07T05:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Codex feedback migration outcome', () => {
  it('records a selection-bound outcome without promoting the observing sample', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-outcome-'));
    roots.push(root);
    const state = new FileCodexFeedbackStateRepository(
      join(root, '.atl-runtime', 'codex-feedback'),
    );
    const visible = new MarkdownCodexFeedbackRepository(root);
    const artifactRoot = join(root, 'artifacts');

    async function binding(suffix: string): Promise<{ bindingId: string; artifactPath: string }> {
      const sourceContent = `# Synthetic source ${suffix}\n`;
      const sourceRef = `笔记同步助手/2026-09-07/synthetic-${suffix}.md#${suffix}`;
      const sourcePath = join(
        root,
        '笔记同步助手',
        '2026-09-07',
        `synthetic-${suffix}.md`,
      );
      const artifactPath = join(artifactRoot, `task-${suffix}`, 'report.md');
      await mkdir(join(sourcePath, '..'), { recursive: true });
      await writeFile(sourcePath, sourceContent, 'utf8');
      await mkdir(join(artifactPath, '..'), { recursive: true });
      await writeFile(artifactPath, `# Artifact ${suffix}\n`, 'utf8');
      const result = await bindCodexTask({ repository: state, clock: () => NOW }, {
        threadId: `thread-${suffix}`,
        taskId: `task-${suffix}`,
        sourceRef,
        sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
        artifactRoot,
        artifactPath,
        experimentId: 'experiment-synthetic-001',
      });
      return {
        bindingId: result.binding.bindingId,
        artifactPath: result.binding.artifactPath,
      };
    }

    const source = await binding('source');
    await snapshotCodexArtifact({ repository: state, clock: () => NOW }, {
      bindingId: source.bindingId,
      artifactVersion: 1,
    });
    const feedback = (await settleCodexFeedback({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      bindingId: source.bindingId,
      messageId: 'message-source',
      messageContent: 'Use a decision-oriented report.',
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'The primary report should support the decision.',
      applicabilityLabels: ['research_report'],
      guidance: 'Lead with conclusions and trade-offs.',
      captureMode: 'automatic',
    })).feedback!;
    const target = await binding('target');
    await snapshotCodexArtifact({ repository: state, clock: () => NOW }, {
      bindingId: target.bindingId,
      artifactVersion: 1,
    });
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: state,
      visibleRepository: visible,
    }, { targetBindingId: target.bindingId });
    const selection = await selectCodexFeedbackContext({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      targetBindingId: target.bindingId,
      decisions: candidates.map((candidate) => ({
        feedbackId: candidate.feedbackId,
        expectedDocumentSha256: candidate.documentSha256,
        decision: 'selected' as const,
        reason: 'Relevant to the target research report.',
      })),
    });

    await expect(recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: target.bindingId,
      outcome: 'unsupported' as never,
      evidenceSummary: 'This enum value must fail.',
      artifactRef: target.artifactPath,
    })).rejects.toMatchObject({ code: 'codex_feedback_outcome_invalid' });

    const wrongTarget = await binding('wrong-target');
    await expect(recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: wrongTarget.bindingId,
      outcome: 'hit',
      evidenceSummary: 'The selection belongs to another target.',
      artifactRef: wrongTarget.artifactPath,
    })).rejects.toMatchObject({ code: 'codex_feedback_outcome_invalid' });
    await expect(access(join(
      root,
      '07_System',
      'Task_Intake',
      'Feedback_Outcomes',
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: target.bindingId,
      outcome: 'hit',
      evidenceSummary: 'The target report led with the requested decision and trade-offs.',
      artifactRef: target.artifactPath,
    });
    expect(result).toMatchObject({
      created: true,
      outcome: {
        selectionId: selection.receipt.selectionId,
        targetBindingId: target.bindingId,
        outcome: 'hit',
        visibleRecord: {
          ref: expect.stringContaining('07_System/Task_Intake/Feedback_Outcomes/2026/09/'),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      },
      visibleOutcome: {
        selectedFeedbackIds: [feedback.feedbackId],
      },
    });
    await expect(recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: target.bindingId,
      outcome: 'hit',
      evidenceSummary: 'The target report led with the requested decision and trade-offs.',
      artifactRef: target.artifactPath,
    })).resolves.toEqual({ ...result, created: false });

    const outcomePath = join(root, result.outcome.visibleRecord.ref);
    await writeFile(
      outcomePath,
      `${await readFile(outcomePath, 'utf8')}\nExternal edit.\n`,
      'utf8',
    );
    await expect(recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: target.bindingId,
      outcome: 'hit',
      evidenceSummary: 'The target report led with the requested decision and trade-offs.',
      artifactRef: target.artifactPath,
    })).rejects.toMatchObject({ code: 'codex_feedback_visible_record_invalid' });

    const feedbackRaw = await readFile(join(root, candidates[0]!.documentRef), 'utf8');
    expect(feedbackRaw).toContain('status: observing');
    await expect(access(join(root, '07_System', 'Rules'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, '.codex', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('redacts credentials from persisted migration evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-outcome-secret-'));
    roots.push(root);
    const state = new FileCodexFeedbackStateRepository(
      join(root, '.atl-runtime', 'codex-feedback'),
    );
    const visible = new MarkdownCodexFeedbackRepository(root);
    const artifactRoot = join(root, 'artifacts');
    const artifactPath = join(artifactRoot, 'target', 'report.md');
    const sourceContent = '# Synthetic target source\n';
    const sourcePath = join(root, '笔记同步助手', '2026-09-07', 'synthetic.md');
    await mkdir(join(sourcePath, '..'), { recursive: true });
    await writeFile(sourcePath, sourceContent, 'utf8');
    await mkdir(join(artifactPath, '..'), { recursive: true });
    await writeFile(artifactPath, '# Target\n', 'utf8');
    const target = await bindCodexTask({ repository: state, clock: () => NOW }, {
      threadId: 'thread-target-secret',
      taskId: 'task-target-secret',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#target-secret',
      sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
      artifactRoot,
      artifactPath,
      experimentId: 'experiment-synthetic-001',
    });
    const selection = await selectCodexFeedbackContext({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      targetBindingId: target.binding.bindingId,
      decisions: [],
    });
    const secret = 'codex-outcome-secret-value';
    const result = await recordCodexFeedbackOutcome({
      stateRepository: state,
      visibleRepository: visible,
      clock: () => NOW,
    }, {
      selectionId: selection.receipt.selectionId,
      targetBindingId: target.binding.bindingId,
      outcome: 'not_applicable',
      evidenceSummary: `No candidate applied; api_key=${secret}`,
      artifactRef: target.binding.artifactPath,
    });
    const persisted = [
      await readFile(join(root, result.outcome.visibleRecord.ref), 'utf8'),
      await readFile(join(root, '.atl-runtime', 'codex-feedback', 'state.json'), 'utf8'),
    ].join('\n');
    expect(result.outcome.evidenceSummary).toContain('[REDACTED]');
    expect(persisted).not.toContain(secret);
  });
});
