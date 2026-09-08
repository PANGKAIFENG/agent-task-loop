import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const roots: string[] = [];

interface Inspection {
  binding: { taskId: string };
  contextSelections: unknown[];
  activeSelectionId: string | null;
  activeSelectionState: string;
  activeContextSelection: { selectionId: string } | null;
  activeOutcomes: unknown[];
  outcomes: unknown[];
}

async function runCli(
  root: string,
  args: string[],
  input?: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa('pnpm', ['exec', 'tsx', cli, ...args], {
    cwd: repositoryRoot,
    env: {
      ATL_VAULT_ROOT: root,
      ATL_ALLOW_REAL_WRITES: '1',
    },
    ...(input === undefined ? {} : { input: `${JSON.stringify(input)}\n` }),
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function json<T>(result: Awaited<ReturnType<typeof runCli>>): T {
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atl codex-feedback', () => {
  it('runs the synthetic binding, settlement, context and outcome loop through CLI contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-cli-'));
    roots.push(root);
    const artifactRoot = join(root, 'artifacts');

    async function createBinding(suffix: string): Promise<{
      binding: { bindingId: string; artifactPath: string };
    }> {
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
      return json(await runCli(root, [
        'codex-feedback', 'bind', '--stdin-json', '--json',
      ], {
        threadId: `thread-${suffix}`,
        taskId: `task-${suffix}`,
        sourceRef,
        sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
        artifactRoot,
        artifactPath,
        experimentId: 'experiment-synthetic-001',
      }));
    }

    const source = await createBinding('source');
    json(await runCli(root, [
      'codex-feedback', 'snapshot',
      '--binding-id', source.binding.bindingId,
      '--artifact-version', '1',
      '--json',
    ]));
    const settlement = json<{
      feedback: { feedbackId: string };
    }>(await runCli(root, [
      'codex-feedback', 'settle', '--private-input-stdin-json', '--json',
    ], {
      bindingId: source.binding.bindingId,
      messageId: 'message-synthetic-source',
      messageContent: 'Use a decision-oriented report.',
      artifactVersion: 1,
      classification: 'reusable_correction',
      summary: 'The primary report should support a user decision.',
      applicabilityLabels: ['research_report'],
      guidance: 'Lead with the conclusion and trade-offs.',
      captureMode: 'automatic',
    }));

    const target = await createBinding('target');
    const inspect = async (): Promise<Inspection> => json(await runCli(root, [
      'codex-feedback', 'inspect', '--thread-id', 'thread-target', '--json',
    ]));
    expect(await inspect()).toMatchObject({
      activeSelectionId: null,
      activeSelectionState: 'none',
      activeContextSelection: null,
      activeOutcomes: [],
    });
    const candidates = json<Array<{
      feedbackId: string;
      documentSha256: string;
    }>>(await runCli(root, [
      'codex-feedback', 'context-candidates',
      '--target-binding-id', target.binding.bindingId,
      '--json',
    ]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.feedbackId).toBe(settlement.feedback.feedbackId);

    const excludedInput = {
      targetBindingId: target.binding.bindingId,
      decisions: [{
        feedbackId: candidates[0]!.feedbackId,
        expectedDocumentSha256: candidates[0]!.documentSha256,
        decision: 'excluded',
        reason: 'This task currently needs only the source evidence.',
      }],
    };
    const excluded = json<{ receipt: { selectionId: string } }>(await runCli(root, [
      'codex-feedback', 'select-context', '--stdin-json', '--json',
    ], excludedInput));

    const selected = json<{
      receipt: { selectionId: string };
      additionalLocalContexts: Array<{ kind: string }>;
    }>(await runCli(root, [
      'codex-feedback', 'select-context', '--stdin-json', '--json',
    ], {
      targetBindingId: target.binding.bindingId,
      decisions: [{
        feedbackId: candidates[0]!.feedbackId,
        expectedDocumentSha256: candidates[0]!.documentSha256,
        decision: 'selected',
        reason: 'The target is another decision-oriented research report.',
      }],
    }));
    expect(selected.additionalLocalContexts).toEqual([
      expect.objectContaining({ kind: 'feedback' }),
    ]);

    const outcome = json<{
      outcome: { outcome: string };
    }>(await runCli(root, [
      'codex-feedback', 'record-outcome', '--stdin-json', '--json',
    ], {
      selectionId: selected.receipt.selectionId,
      targetBindingId: target.binding.bindingId,
      outcome: 'hit',
      evidenceSummary: 'The target Artifact applied the selected correction.',
      artifactRef: target.binding.artifactPath,
    }));
    expect(outcome.outcome.outcome).toBe('hit');

    const inspected = await inspect();
    expect(inspected.binding.taskId).toBe('task-target');
    expect(inspected.contextSelections).toHaveLength(2);
    expect(inspected.activeSelectionState).toBe('active');
    expect(inspected.activeSelectionId).toBe(selected.receipt.selectionId);
    expect(inspected.activeContextSelection?.selectionId).toBe(selected.receipt.selectionId);
    expect(inspected.outcomes).toHaveLength(1);
    expect(inspected.activeOutcomes).toHaveLength(1);

    json(await runCli(root, [
      'codex-feedback', 'select-context', '--stdin-json', '--json',
    ], excludedInput));
    const replayed = await inspect();
    expect(replayed.activeSelectionId).toBe(excluded.receipt.selectionId);
    expect(replayed.activeContextSelection?.selectionId).toBe(excluded.receipt.selectionId);
    expect(replayed.activeSelectionState).toBe('active');
    expect(replayed.activeOutcomes).toEqual([]);
    expect(replayed.outcomes).toHaveLength(1);
    expect(replayed.contextSelections).toHaveLength(2);

    const statePath = join(root, '.atl-runtime', 'codex-feedback', 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      activeContextSelections?: unknown[];
      contextSelections: Array<{ selectionId: string }>;
    };
    delete state.activeContextSelections;
    await writeFile(statePath, JSON.stringify(state), 'utf8');
    const legacyBytes = await readFile(statePath, 'utf8');
    expect(await inspect()).toMatchObject({
      activeSelectionId: null,
      activeContextSelection: null,
      activeSelectionState: 'legacy_ambiguous',
      activeOutcomes: [],
    });
    expect(await readFile(statePath, 'utf8')).toBe(legacyBytes);
    state.contextSelections = state.contextSelections.filter((selection) => (
      selection.selectionId === selected.receipt.selectionId
    ));
    await writeFile(statePath, JSON.stringify(state), 'utf8');
    expect(await inspect()).toMatchObject({
      activeSelectionId: selected.receipt.selectionId,
      activeSelectionState: 'legacy_single',
    });
  }, 30_000);

  it('does not create Vault paths when a read command finds no state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-read-only-'));
    roots.push(parent);
    const absentRoot = join(parent, 'missing-vault');
    const result = await runCli(absentRoot, [
      'codex-feedback', 'inspect', '--thread-id', 'thread-missing', '--json',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('Codex task binding was not found');
    await expect(access(absentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
