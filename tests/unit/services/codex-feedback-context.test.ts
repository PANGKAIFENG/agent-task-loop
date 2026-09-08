import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { buildContextBundle } from '../../../src/runner/context-bundle.js';
import { bindCodexTask } from '../../../src/services/bind-codex-task.js';
import {
  loadSelectedCodexFeedbackContext,
  queryCodexFeedbackCandidates,
  selectCodexFeedbackContext,
} from '../../../src/services/select-codex-feedback-context.js';
import { settleCodexFeedback } from '../../../src/services/settle-codex-feedback.js';
import { snapshotCodexArtifact } from '../../../src/services/snapshot-codex-artifact.js';
import { FileCodexFeedbackStateRepository } from '../../../src/storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../../../src/storage/markdown-codex-feedback-repository.js';

const NOW = new Date('2026-09-07T04:00:00.000Z');
const roots: string[] = [];

type FileHandlePrototype = {
  readFile: (...args: unknown[]) => Promise<unknown>;
};

async function beforeNextFileHandleRead(
  probePath: string,
  action: () => Promise<void>,
): Promise<() => void> {
  const probe = await open(probePath, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
  const original = prototype.readFile;
  await probe.close();
  let pending = true;
  prototype.readFile = async function interceptedReadFile(...args: unknown[]) {
    if (pending) {
      pending = false;
      prototype.readFile = original;
      await action();
    }
    return original.apply(this, args);
  };
  return () => {
    prototype.readFile = original;
  };
}

async function fixture(): Promise<{
  root: string;
  state: FileCodexFeedbackStateRepository;
  visible: MarkdownCodexFeedbackRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-context-'));
  roots.push(root);
  return {
    root,
    state: new FileCodexFeedbackStateRepository(join(root, '.atl-runtime', 'codex-feedback')),
    visible: new MarkdownCodexFeedbackRepository(root),
  };
}

async function bind(
  context: Awaited<ReturnType<typeof fixture>>,
  suffix: string,
): Promise<string> {
  const sourceContent = `# Synthetic source ${suffix}\n`;
  const sourceRef = `笔记同步助手/2026-09-07/synthetic-${suffix}.md#${suffix}`;
  const sourcePath = join(
    context.root,
    '笔记同步助手',
    '2026-09-07',
    `synthetic-${suffix}.md`,
  );
  const artifactRoot = join(context.root, 'artifacts');
  const artifactPath = join(artifactRoot, `task-${suffix}`, 'report.md');
  await mkdir(join(sourcePath, '..'), { recursive: true });
  await writeFile(sourcePath, sourceContent, 'utf8');
  await mkdir(join(artifactPath, '..'), { recursive: true });
  await writeFile(artifactPath, `# Artifact ${suffix}\n`, 'utf8');
  return (await bindCodexTask({ repository: context.state, clock: () => NOW }, {
    threadId: `thread-${suffix}`,
    taskId: `task-${suffix}`,
    sourceRef,
    sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
    artifactRoot,
    artifactPath,
    experimentId: 'experiment-synthetic-001',
  })).binding.bindingId;
}

async function createFeedback(
  context: Awaited<ReturnType<typeof fixture>>,
  suffix: string,
  labels: string[],
): Promise<string> {
  const bindingId = await bind(context, suffix);
  await snapshotCodexArtifact({ repository: context.state, clock: () => NOW }, {
    bindingId,
    artifactVersion: 1,
  });
  const settled = await settleCodexFeedback({
    stateRepository: context.state,
    visibleRepository: context.visible,
    clock: () => NOW,
  }, {
    bindingId,
    messageId: `message-${suffix}`,
    messageContent: `Synthetic reusable correction ${suffix}.`,
    artifactVersion: 1,
    classification: 'reusable_correction',
    summary: `Reusable correction ${suffix}.`,
    applicabilityLabels: labels,
    guidance: `Apply guidance ${suffix} when relevant.`,
    captureMode: 'automatic',
  });
  return settled.feedback!.feedbackId;
}

function task(targetTaskId: string): Task {
  return {
    schemaVersion: 1,
    taskId: targetTaskId,
    title: 'Synthetic target',
    body: 'Prepare a decision-oriented research report.',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'research',
    objective: 'Create a report that supports a user decision.',
    acceptanceCriteria: ['Make the recommendation and trade-offs visible.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-09-07',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `synthetic:${targetTaskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function project(): Project {
  return {
    projectId: 'project-synthetic',
    name: 'Synthetic project',
    description: 'Synthetic research context.',
    resources: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Codex feedback context selection', () => {
  it.each([
    [0, 1_000, 2_000],
    [0, 0, 0],
    [2_000, 1_000, 0],
  ])('reactivates an immutable selection independently of clock order %j', async (...offsets) => {
    const context = await fixture();
    const feedbackId = await createFeedback(context, 'reactivation', ['research_report']);
    const targetBindingId = await bind(context, 'reactivation-target');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    const select = (decision: 'selected' | 'excluded', offset: number) => (
      selectCodexFeedbackContext({
        stateRepository: context.state,
        visibleRepository: context.visible,
        clock: () => new Date(NOW.getTime() + offset),
      }, {
        targetBindingId,
        decisions: [{
          feedbackId,
          expectedDocumentSha256: candidates[0]!.documentSha256,
          decision,
          reason: decision === 'selected' ? 'Relevant to this report.' : 'Not relevant now.',
        }],
      })
    );
    const readAfterRestart = () => loadSelectedCodexFeedbackContext({
      stateRepository: new FileCodexFeedbackStateRepository(
        join(context.root, '.atl-runtime', 'codex-feedback'),
      ),
      visibleRepository: new MarkdownCodexFeedbackRepository(context.root),
    }, { targetBindingId });

    const excluded = await select('excluded', offsets[0]!);
    const selected = await select('selected', offsets[1]!);
    expect(await readAfterRestart()).toMatchObject({
      selectionId: selected.receipt.selectionId,
      additionalLocalContexts: [expect.objectContaining({ kind: 'feedback' })],
    });
    const reactivated = await select('excluded', offsets[2]!);
    expect(reactivated).toMatchObject({ receipt: excluded.receipt, created: false });
    expect(await readAfterRestart()).toMatchObject({
      selectionId: excluded.receipt.selectionId,
      additionalLocalContexts: [],
      manifestCandidates: [expect.objectContaining({ selection: 'excluded' })],
    });
    expect((await context.state.read()).contextSelections).toHaveLength(2);
  });

  it('requires explicit re-selection for ambiguous legacy history', async () => {
    const context = await fixture();
    await createFeedback(context, 'legacy', ['research_report']);
    const targetBindingId = await bind(context, 'legacy-target');
    const dependencies = {
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    };
    const candidates = await queryCodexFeedbackCandidates(dependencies, { targetBindingId });
    const decisions = candidates.map((candidate) => ({
      feedbackId: candidate.feedbackId,
      expectedDocumentSha256: candidate.documentSha256,
      decision: 'selected' as const,
      reason: 'Relevant to this report.',
    }));
    const selected = await selectCodexFeedbackContext(dependencies, { targetBindingId, decisions });
    const singleState = await context.state.read();
    delete singleState.activeContextSelections;
    await context.state.save(singleState);
    expect(await loadSelectedCodexFeedbackContext(dependencies, { targetBindingId }))
      .toMatchObject({ selectionId: selected.receipt.selectionId });

    await selectCodexFeedbackContext(dependencies, {
      targetBindingId,
      decisions: decisions.map((decision) => ({ ...decision, decision: 'excluded' })),
    });
    const ambiguousState = await context.state.read();
    delete ambiguousState.activeContextSelections;
    await context.state.save(ambiguousState);
    await expect(loadSelectedCodexFeedbackContext(dependencies, { targetBindingId }))
      .rejects.toMatchObject({ code: 'codex_feedback_context_decision_invalid' });
    expect(await selectCodexFeedbackContext(dependencies, { targetBindingId, decisions }))
      .toMatchObject({ receipt: selected.receipt, created: false });
    expect(await loadSelectedCodexFeedbackContext(dependencies, { targetBindingId }))
      .toMatchObject({ selectionId: selected.receipt.selectionId });
  });

  it('requires a reason for every candidate and injects only selected feedback', async () => {
    const context = await fixture();
    const selectedId = await createFeedback(context, 'source-a', ['research_report']);
    const excludedId = await createFeedback(context, 'source-b', ['coding_task']);
    const targetBindingId = await bind(context, 'target');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    expect(candidates.map((candidate) => candidate.feedbackId).sort()).toEqual([
      excludedId,
      selectedId,
    ].sort());

    const decisions = [
      {
        feedbackId: selectedId,
        expectedDocumentSha256: candidates.find(
          (candidate) => candidate.feedbackId === selectedId,
        )!.documentSha256,
        decision: 'selected' as const,
        reason: 'The target is another decision-oriented research report.',
      },
      {
        feedbackId: excludedId,
        expectedDocumentSha256: candidates.find(
          (candidate) => candidate.feedbackId === excludedId,
        )!.documentSha256,
        decision: 'excluded' as const,
        reason: 'The coding-only display rule is not applicable to this report.',
      },
    ];

    await expect(selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions: [{
        feedbackId: selectedId,
        expectedDocumentSha256: candidates.find(
          (candidate) => candidate.feedbackId === selectedId,
        )!.documentSha256,
        decision: 'selected',
        reason: 'The target is another decision-oriented research report.',
      }],
    })).rejects.toMatchObject({ code: 'codex_feedback_context_decision_invalid' });

    await expect(selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions: [decisions[0]!, decisions[0]!, decisions[1]!],
    })).rejects.toMatchObject({ code: 'codex_feedback_context_decision_invalid' });

    await expect(selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions: [
        ...decisions,
        {
          feedbackId: `cfeedback_${'f'.repeat(24)}`,
          expectedDocumentSha256: 'f'.repeat(64),
          decision: 'excluded',
          reason: 'This candidate does not exist.',
        },
      ],
    })).rejects.toMatchObject({ code: 'codex_feedback_context_decision_invalid' });

    const selection = await selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions,
    });
    expect(selection.receipt.decisions).toHaveLength(2);
    expect(selection.additionalLocalContexts).toHaveLength(1);
    expect(selection.manifestCandidates).toHaveLength(2);

    const targetTaskId = (await context.state.listBindings())
      .find((binding) => binding.bindingId === targetBindingId)!.taskId;
    const bundle = await buildContextBundle(task(targetTaskId), project(), {
      allowedLocalRoots: [context.root],
      additionalLocalContexts: selection.additionalLocalContexts,
    });
    const feedbackBlocks = bundle.blocks.filter((block) => block.kind === 'feedback');
    expect(feedbackBlocks).toHaveLength(1);
    expect(feedbackBlocks[0]).toMatchObject({
      category: 'feedback',
      sourceRef: expect.stringContaining(selectedId),
      sha256: selection.receipt.decisions.find(
        (decision) => decision.feedbackId === selectedId,
      )!.documentSha256,
    });
    expect(JSON.stringify(bundle)).not.toContain(excludedId);

    const selectedCandidate = candidates.find(
      (candidate) => candidate.feedbackId === selectedId,
    )!;
    const selectedRaw = await readFile(selectedCandidate.documentPath, 'utf8');
    await writeFile(
      selectedCandidate.documentPath,
      `${selectedRaw}\nChanged after selection.\n`,
      'utf8',
    );
    await expect(buildContextBundle(task(targetTaskId), project(), {
      allowedLocalRoots: [context.root],
      additionalLocalContexts: selection.additionalLocalContexts,
    })).rejects.toMatchObject({ code: 'invalid_additional_context' });
    await writeFile(selectedCandidate.documentPath, selectedRaw, 'utf8');

    await expect(selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, { targetBindingId, decisions })).resolves.toMatchObject({ created: false });

    const staleCandidate = candidates.find((candidate) => candidate.feedbackId === selectedId)!;
    await writeFile(
      staleCandidate.documentPath,
      `${await readFile(staleCandidate.documentPath, 'utf8')}\nExternal edit.\n`,
      'utf8',
    );
    await expect(selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, { targetBindingId, decisions })).rejects.toMatchObject({
      code: 'codex_feedback_context_decision_invalid',
    });
  });

  it('redacts selection reasons and rejects duplicate visible Feedback ids', async () => {
    const context = await fixture();
    const sourceId = await createFeedback(context, 'source-secret', ['research_report']);
    const targetBindingId = await bind(context, 'target-secret');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    const secret = 'codex-context-secret-value';
    const selection = await selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions: [{
        feedbackId: sourceId,
        expectedDocumentSha256: candidates[0]!.documentSha256,
        decision: 'selected',
        reason: `Relevant report; api_key=${secret}`,
      }],
    });
    const stateRaw = await readFile(
      join(context.root, '.atl-runtime', 'codex-feedback', 'state.json'),
      'utf8',
    );
    expect(selection.receipt.decisions[0]!.reason).toContain('[REDACTED]');
    expect(stateRaw).not.toContain(secret);

    const original = candidates[0]!;
    const duplicatePath = join(
      context.root,
      '07_System',
      'Task_Intake',
      'Feedback',
      '2026',
      '10',
      `${sourceId}.md`,
    );
    await mkdir(join(duplicatePath, '..'), { recursive: true });
    await writeFile(duplicatePath, await readFile(original.documentPath, 'utf8'), 'utf8');
    await expect(queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId })).rejects.toMatchObject({
      code: 'codex_feedback_visible_record_conflict',
    });
  });

  it('rejects a selected Feedback path replaced while its open file is being read', async () => {
    const context = await fixture();
    const feedbackId = await createFeedback(context, 'source-read-race', ['research_report']);
    const targetBindingId = await bind(context, 'target-read-race');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    const candidate = candidates.find((item) => item.feedbackId === feedbackId)!;
    const selection = await selectCodexFeedbackContext({
      stateRepository: context.state,
      visibleRepository: context.visible,
      clock: () => NOW,
    }, {
      targetBindingId,
      decisions: [{
        feedbackId,
        expectedDocumentSha256: candidate.documentSha256,
        decision: 'selected',
        reason: 'The correction applies to this synthetic research report.',
      }],
    });
    const movedPath = `${candidate.documentPath}.original`;
    const original = await readFile(candidate.documentPath, 'utf8');
    const targetTaskId = (await context.state.listBindings())
      .find((binding) => binding.bindingId === targetBindingId)!.taskId;
    const restore = await beforeNextFileHandleRead(candidate.documentPath, async () => {
      await rename(candidate.documentPath, movedPath);
      await writeFile(
        candidate.documentPath,
        `${original}\nChanged after the file handle was opened.\n`,
        'utf8',
      );
    });

    try {
      await expect(buildContextBundle(task(targetTaskId), project(), {
        allowedLocalRoots: [context.root],
        includeSourceNote: false,
        additionalLocalContexts: selection.additionalLocalContexts,
      })).rejects.toMatchObject({ code: 'invalid_local_file' });
    } finally {
      restore();
    }
  });

  it('fails closed when state-backed Feedback is missing from the visible store', async () => {
    const context = await fixture();
    await createFeedback(context, 'missing-visible', ['research_report']);
    const targetBindingId = await bind(context, 'target-missing-visible');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    expect(candidates).toHaveLength(1);
    await rm(candidates[0]!.documentPath);

    await expect(queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId })).rejects.toMatchObject({
      code: 'codex_feedback_visible_record_invalid',
    });
  });

  it('fails closed instead of silently skipping a malformed Feedback document', async () => {
    const context = await fixture();
    await createFeedback(context, 'malformed-visible', ['research_report']);
    const targetBindingId = await bind(context, 'target-malformed-visible');
    const candidates = await queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId });
    expect(candidates).toHaveLength(1);
    await writeFile(candidates[0]!.documentPath, 'not valid feedback markdown\n', 'utf8');

    await expect(queryCodexFeedbackCandidates({
      stateRepository: context.state,
      visibleRepository: context.visible,
    }, { targetBindingId })).rejects.toMatchObject({
      code: 'codex_feedback_visible_record_invalid',
    });
  });
});
