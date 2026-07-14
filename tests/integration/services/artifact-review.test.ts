import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactResult } from '../../../src/domain/artifact.js';
import type { Task } from '../../../src/domain/task.js';
import {
  ReviewTaskAuditFailedError,
  ReviewTaskArtifactInvalidError,
  ReviewTaskInvalidInputError,
  type ReviewTaskInput,
  reviewTask,
} from '../../../src/services/review-task.js';
import {
  ReopenTaskInvalidInputError,
  reopenTask,
} from '../../../src/services/reopen-task.js';
import {
  ArtifactSubmissionAuditFailedError,
  ArtifactSubmissionInvalidStateError,
  ArtifactSubmissionTaskSaveFailedError,
  submitArtifact,
} from '../../../src/services/submit-artifact.js';
import {
  StopTaskInvalidStateError,
  stopTask,
} from '../../../src/services/stop-task.js';
import {
  UnblockTaskInvalidInputError,
  unblockTask,
} from '../../../src/services/unblock-task.js';
import { ArtifactAlreadyExistsError } from '../../../src/storage/markdown-artifact-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-07-14T00:00:00.000Z';
const contexts: TestServiceContext[] = [];

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: new Date(NOW) });
  contexts.push(context);
  return context;
}

function inProgressTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260714-artifact1',
    title: 'Review public pricing',
    body: '\nSynthetic task body.\n',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-public-research',
    taskType: 'research',
    objective: 'Compare public pricing.',
    acceptanceCriteria: ['Use official public evidence.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-07-14',
    sourceNote: '/synthetic/source.md',
    sourceQuote: 'Synthetic source quote.',
    sourceKey: 'synthetic:artifact-review',
    possibleDuplicateIds: [],
    priority: 'high',
    attempts: 1,
    claim: {
      runId: 'run-artifact-001',
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-14T00:15:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function artifactResult(overrides: Partial<ArtifactResult> = {}): ArtifactResult {
  return {
    summary: 'Public pricing evidence was reviewed.',
    findings: ['Free tier exists.', 'Pro tier is public.', 'Enterprise is quoted.'],
    evidence: [{
      title: 'Official pricing | public',
      url: 'https://example.com',
      accessedAt: NOW,
    }],
    uncertainties: ['Enterprise price is not public.'],
    recommendedActions: ['Request an enterprise quote.'],
    acceptance: [{
      criterion: 'Use official | public evidence.',
      status: 'met',
      note: 'Official page cited | checked.',
    }],
    ...overrides,
  };
}

const reviewInputs: Array<{
  decision: ReviewTaskInput['decision'];
  input: ReviewTaskInput;
}> = [
  { decision: 'approve', input: { decision: 'approve' } },
  {
    decision: 'request_changes',
    input: {
      decision: 'request_changes',
      feedback: 'Synthetic reviewer feedback.',
    },
  },
  {
    decision: 'block',
    input: { decision: 'block', feedback: 'Synthetic reviewer feedback.' },
  },
  {
    decision: 'cancel',
    input: { decision: 'cancel', feedback: 'Synthetic reviewer feedback.' },
  },
];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('artifact review loop', () => {
  it('submits a deterministic Artifact to Review and archives it only after approval', async () => {
    const context = await makeContext();
    const task = inProgressTask();
    await context.ctx.tasks.save(task);

    const submitted = await submitArtifact(context.ctx, task.taskId, {
      runId: 'run-artifact-001',
      result: artifactResult(),
    });

    const ref = `Artifacts/${task.taskId}/attempt-001.md`;
    const artifactPath = join(context.root, '10_Tasks', ref);
    expect(submitted).toMatchObject({
      status: 'review',
      claim: null,
      artifactRefs: [ref],
    });
    expect((await stat(artifactPath)).isFile()).toBe(true);
    const markdown = await readFile(artifactPath, 'utf8');
    expect(markdown).toContain(`task_id: ${task.taskId}`);
    expect(markdown).toContain('run_id: run-artifact-001');
    expect(markdown).toContain('attempt: 1');
    expect(markdown).toContain('agent: synthetic-agent');
    expect(markdown).toContain(`created_at: ${NOW}`);
    expect(markdown).toContain(`updated_at: ${NOW}`);
    expect(markdown).toMatch(/input_digest: [0-9a-f]{64}/);
    for (const heading of [
      '## Summary',
      '## Findings',
      '## Evidence',
      '## Uncertainties',
      '## Recommended Actions',
      '## Acceptance Criteria',
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain('Official pricing \\| public');
    expect(markdown).toContain('Use official \\| public evidence.');
    await expect(context.ctx.artifacts.readSummary(ref)).resolves.toEqual({
      summary: 'Public pricing evidence was reviewed.',
      evidenceCount: 1,
    });
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'artifact.submitted',
      at: NOW,
      taskId: task.taskId,
      runId: 'run-artifact-001',
      details: { artifactRef: ref, attempt: 1 },
    });

    const approved = await reviewTask(context.ctx, task.taskId, {
      decision: 'approve',
    });

    expect(approved).toMatchObject({
      status: 'done',
      artifactRefs: [ref],
      reviewFeedback: null,
    });
    const archivePath = join(
      context.root,
      '10_Tasks',
      'Archive',
      '2026',
      `${task.taskId}.md`,
    );
    expect((await stat(archivePath)).isFile()).toBe(true);
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'task.reviewed',
      at: NOW,
      taskId: task.taskId,
      details: { decision: 'approve' },
    });

    const auditText = JSON.stringify(await context.ctx.audit.listForTask(task.taskId));
    expect(auditText).not.toContain(artifactResult().summary);
    expect(auditText).not.toContain(artifactResult().findings[0]);
  });

  it('requires matching ownership and HTTPS evidence before writing an Artifact', async () => {
    const context = await makeContext();
    const task = inProgressTask({ taskId: 'task-20260714-validation' });
    await context.ctx.tasks.save(task);

    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: 'run-wrong-owner',
      result: artifactResult(),
    })).rejects.toBeInstanceOf(ArtifactSubmissionInvalidStateError);
    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult({
        evidence: [{
          title: 'Insecure synthetic evidence',
          url: 'http://example.com',
          accessedAt: NOW,
        }],
      }),
    })).rejects.toMatchObject({
      code: 'invalid_artifact_input',
      message: 'Invalid Artifact input',
    });

    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(stat(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      task.taskId,
      'attempt-001.md',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts slash-containing claim metadata but rejects metadata controls', async () => {
    const context = await makeContext();
    const runId = 'run/001';
    const agent = 'team/research';
    const task = inProgressTask({
      taskId: 'task-20260714-metadata',
      claim: {
        runId,
        agent,
        claimedAt: NOW,
        leaseExpiresAt: '2026-07-14T00:15:00.000Z',
      },
    });
    await context.ctx.tasks.save(task);

    const submitted = await submitArtifact(context.ctx, task.taskId, {
      runId,
      result: artifactResult(),
    });

    expect(submitted).toMatchObject({
      status: 'review',
      claim: null,
    });
    const markdown = await readFile(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      task.taskId,
      'attempt-001.md',
    ), 'utf8');
    expect(markdown).toContain(`run_id: ${runId}`);
    expect(markdown).toContain(`agent: ${agent}`);

    const invalidTask = inProgressTask({
      taskId: 'task-20260714-invalid-metadata',
      claim: {
        runId: 'run-control\n001',
        agent: 'team/research',
        claimedAt: NOW,
        leaseExpiresAt: '2026-07-14T00:15:00.000Z',
      },
    });
    await context.ctx.tasks.save(invalidTask);
    await expect(submitArtifact(context.ctx, invalidTask.taskId, {
      runId: invalidTask.claim?.runId ?? '',
      result: artifactResult(),
    })).rejects.toMatchObject({ code: 'invalid_artifact_input' });
  });

  it('escapes every Artifact table cell without breaking rows', async () => {
    const context = await makeContext();
    const task = inProgressTask({ taskId: 'task-20260714-table-cells' });
    await context.ctx.tasks.save(task);

    const submitted = await submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult({
        evidence: [{
          title: 'Official \\ pricing | first\rsecond\nthird',
          url: 'https://example.com/a|b',
          accessedAt: NOW,
        }],
        acceptance: [{
          criterion: 'Criterion \\ | one\r\ntwo',
          status: 'partial',
          note: 'Note \\ | alpha\nbeta',
        }],
      }),
    });

    const markdown = await readFile(
      join(context.root, '10_Tasks', submitted.artifactRefs[0] ?? ''),
      'utf8',
    );
    expect(markdown).toContain(
      `| Official \\\\ pricing \\| first second third | https://example.com/a\\|b | ${NOW} |`,
    );
    expect(markdown).toContain(
      '| Criterion \\\\ \\| one  two | partial | Note \\\\ \\| alpha beta |',
    );
  });

  it('allows only one concurrent submission for the same task transition', async () => {
    const context = await makeContext();
    const independent = context.createIndependentContext();
    const task = inProgressTask({ taskId: 'task-20260714-concurrent' });
    await context.ctx.tasks.save(task);

    const settled = await Promise.allSettled([
      submitArtifact(context.ctx, task.taskId, {
        runId: task.claim?.runId ?? '',
        result: artifactResult(),
      }),
      submitArtifact(independent, task.taskId, {
        runId: task.claim?.runId ?? '',
        result: artifactResult(),
      }),
    ]);

    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ArtifactSubmissionInvalidStateError),
    });
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      status: 'review',
      artifactRefs: [`Artifacts/${task.taskId}/attempt-001.md`],
    });
  });

  it('reports an orphan Artifact when task save fails and never overwrites that attempt', async () => {
    const context = await makeContext();
    const task = inProgressTask({ taskId: 'task-20260714-orphan' });
    await context.ctx.tasks.save(task);
    const saveTask = context.ctx.tasks.save.bind(context.ctx.tasks);
    context.ctx.tasks.save = async (candidate) => {
      if (candidate.status === 'review') {
        throw new Error('synthetic private save failure');
      }
      return saveTask(candidate);
    };

    const error = await submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    }).catch((caught: unknown) => caught);

    const ref = `Artifacts/${task.taskId}/attempt-001.md`;
    expect(error).toBeInstanceOf(ArtifactSubmissionTaskSaveFailedError);
    expect(error).toMatchObject({
      code: 'artifact_submission_task_save_failed',
      message: 'Artifact written but task save failed',
      artifactRef: ref,
      partialCommit: true,
      recoveryRequired: true,
    });
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(context.ctx.artifacts.readSummary(ref)).resolves.toEqual({
      summary: artifactResult().summary,
      evidenceCount: 1,
    });
    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult({ summary: 'Must not overwrite the orphan.' }),
    })).rejects.toBeInstanceOf(ArtifactAlreadyExistsError);
    expect(await context.ctx.artifacts.readSummary(ref)).toEqual({
      summary: artifactResult().summary,
      evidenceCount: 1,
    });
  });

  it('reuses an orphan Artifact when an identical submission retries after audit failure', async () => {
    const context = await makeContext();
    const task = inProgressTask({ taskId: 'task-20260714-audit-retry' });
    await context.ctx.tasks.save(task);
    const appendAudit = context.ctx.audit.append.bind(context.ctx.audit);
    let failSubmissionAudit = true;
    context.ctx.audit.append = async (event) => {
      if (event.event === 'artifact.submitted' && failSubmissionAudit) {
        failSubmissionAudit = false;
        throw new Error('synthetic private audit failure');
      }
      await appendAudit(event);
    };

    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    })).rejects.toBeInstanceOf(ArtifactSubmissionAuditFailedError);

    const ref = `Artifacts/${task.taskId}/attempt-001.md`;
    const artifactPath = join(context.root, '10_Tasks', ref);
    const orphanBytes = await readFile(artifactPath, 'utf8');
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    expect((await stat(artifactPath)).isFile()).toBe(true);

    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult({ summary: 'Different orphan content.' }),
    })).rejects.toBeInstanceOf(ArtifactAlreadyExistsError);

    context.ctx.clock = () => new Date('2026-07-14T01:00:00.000Z');
    const retried = await submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    });

    expect(retried).toMatchObject({
      status: 'review',
      claim: null,
      artifactRefs: [ref],
    });
    expect(await readFile(artifactPath, 'utf8')).toBe(orphanBytes);
    const submittedEvents = (await context.ctx.audit.listForTask(task.taskId))
      .filter(({ event }) => event === 'artifact.submitted');
    expect(submittedEvents).toEqual([{
      event: 'artifact.submitted',
      at: '2026-07-14T01:00:00.000Z',
      taskId: task.taskId,
      runId: task.claim?.runId,
      details: { artifactRef: ref, attempt: 1 },
    }]);
  });

  it('rejects a corrupt orphan Artifact even when its input digest remains', async () => {
    const context = await makeContext();
    const task = inProgressTask({ taskId: 'task-20260714-corrupt-orphan' });
    await context.ctx.tasks.save(task);
    const appendAudit = context.ctx.audit.append.bind(context.ctx.audit);
    context.ctx.audit.append = async () => {
      throw new Error('synthetic private audit failure');
    };

    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    })).rejects.toBeInstanceOf(ArtifactSubmissionAuditFailedError);

    const ref = `Artifacts/${task.taskId}/attempt-001.md`;
    const artifactPath = join(context.root, '10_Tasks', ref);
    const original = await readFile(artifactPath, 'utf8');
    const corrupt = original.replace(/^summary:.*\n/m, '');
    expect(corrupt).not.toBe(original);
    await writeFile(artifactPath, corrupt, 'utf8');
    context.ctx.audit.append = appendAudit;

    await expect(submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    })).rejects.toBeInstanceOf(ArtifactAlreadyExistsError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toEqual([]);
    expect(await readFile(artifactPath, 'utf8')).toBe(corrupt);
  });

  it.each([
    ['request_changes', 'ready'],
    ['block', 'blocked'],
    ['cancel', 'cancelled'],
  ] as const)('applies %s review feedback and preserves Artifact refs', async (
    decision,
    expectedStatus,
  ) => {
    const context = await makeContext();
    const task = inProgressTask({
      taskId: `task-review-${decision}`,
    });
    await context.ctx.tasks.save(task);
    const submitted = await submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    });
    const ref = `Artifacts/${task.taskId}/attempt-001.md`;

    const reviewed = await reviewTask(context.ctx, task.taskId, {
      decision,
      feedback: 'Synthetic reviewer feedback.',
    });

    expect(reviewed).toMatchObject({
      status: expectedStatus,
      artifactRefs: [ref],
      reviewFeedback: 'Synthetic reviewer feedback.',
    });
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'task.reviewed',
      at: NOW,
      taskId: task.taskId,
      details: { decision },
    });
    expect(submitted.artifactRefs).toEqual([ref]);
  });

  describe.each([
    ['empty Artifact refs', 'task-review-empty-artifacts', []],
    [
      'a cross-task Artifact ref',
      'task-review-cross-artifact',
      ['Artifacts/task-review-other/attempt-001.md'],
    ],
    [
      'a missing same-task Artifact ref',
      'task-review-missing-artifact',
      ['Artifacts/task-review-missing-artifact/attempt-001.md'],
    ],
  ] as const)('rejects %s', (_label, taskId, artifactRefs) => {
    it.each(reviewInputs)('before the $decision decision', async ({ input }) => {
      const context = await makeContext();
      const task = inProgressTask({
        taskId,
        status: 'review',
        claim: null,
        artifactRefs: [...artifactRefs],
      });
      await context.ctx.tasks.save(task);

      const error = await reviewTask(context.ctx, task.taskId, input)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReviewTaskArtifactInvalidError);
      expect(error).toMatchObject({
        code: 'task_review_artifact_invalid',
        message: 'Task Review Artifact is invalid',
      });
      await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
      await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toEqual([]);
    });
  });

  it.each(['request_changes', 'block', 'cancel'] as const)(
    'requires non-empty feedback for %s',
    async (decision) => {
      const context = await makeContext();
      const task = inProgressTask({
        taskId: `task-review-empty-${decision}`,
        status: 'review',
        claim: null,
        artifactRefs: [`Artifacts/task-review-empty-${decision}/attempt-001.md`],
      });
      await context.ctx.tasks.save(task);

      await expect(reviewTask(context.ctx, task.taskId, {
        decision,
        feedback: '   ',
      })).rejects.toBeInstanceOf(ReviewTaskInvalidInputError);
      await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(task);
    },
  );

  it('restores Review when review audit append fails', async () => {
    const context = await makeContext();
    const task = inProgressTask({
      taskId: 'task-review-audit-failure',
    });
    await context.ctx.tasks.save(task);
    const submitted = await submitArtifact(context.ctx, task.taskId, {
      runId: task.claim?.runId ?? '',
      result: artifactResult(),
    });
    context.ctx.audit.append = async () => {
      throw new Error('synthetic private audit failure');
    };

    await expect(reviewTask(context.ctx, task.taskId, {
      decision: 'approve',
    })).rejects.toBeInstanceOf(ReviewTaskAuditFailedError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(submitted);
  });

  it('manually stops only an In Progress task without deleting partial evidence', async () => {
    const context = await makeContext();
    const ref = 'Artifacts/task-stop/attempt-001.md';
    const task = inProgressTask({
      taskId: 'task-stop',
      artifactRefs: [ref],
      attempts: 2,
    });
    await context.ctx.tasks.save(task);

    const stopped = await stopTask(context.ctx, task.taskId);

    expect(stopped).toMatchObject({
      status: 'ready',
      claim: null,
      attempts: 2,
      artifactRefs: [ref],
      readyAt: NOW,
    });
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'task.stopped',
      at: NOW,
      taskId: task.taskId,
      runId: 'run-artifact-001',
    });
    await expect(stopTask(context.ctx, task.taskId))
      .rejects.toBeInstanceOf(StopTaskInvalidStateError);
  });

  it('unblocks a Blocked task only with a non-empty recovery note', async () => {
    const context = await makeContext();
    const ref = 'Artifacts/task-unblock/attempt-001.md';
    const task = inProgressTask({
      taskId: 'task-unblock',
      status: 'blocked',
      claim: null,
      artifactRefs: [ref],
      reviewFeedback: 'Original blocking feedback.',
    });
    await context.ctx.tasks.save(task);

    await expect(unblockTask(context.ctx, task.taskId, {
      recoveryNote: '   ',
    })).rejects.toBeInstanceOf(UnblockTaskInvalidInputError);

    const unblocked = await unblockTask(context.ctx, task.taskId, {
      recoveryNote: 'Synthetic recovery is ready.',
    });

    expect(unblocked).toMatchObject({
      status: 'ready',
      artifactRefs: [ref],
      reviewFeedback: 'Synthetic recovery is ready.',
      readyAt: NOW,
    });
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'task.unblocked',
      at: NOW,
      taskId: task.taskId,
    });
  });

  it('reopens a Done task from Archive while preserving every Artifact ref', async () => {
    const context = await makeContext();
    const refs = [
      'Artifacts/task-reopen/attempt-001.md',
      'Artifacts/task-reopen/attempt-002.md',
    ];
    const task = inProgressTask({
      taskId: 'task-reopen',
      status: 'done',
      claim: null,
      artifactRefs: refs,
      attempts: 2,
      updatedAt: NOW,
    });
    await context.ctx.tasks.save(task);

    await expect(reopenTask(context.ctx, task.taskId, {
      reason: '\t',
    })).rejects.toBeInstanceOf(ReopenTaskInvalidInputError);

    const reopened = await reopenTask(context.ctx, task.taskId, {
      reason: 'New public evidence must be checked.',
    });

    expect(reopened).toMatchObject({
      status: 'ready',
      artifactRefs: refs,
      attempts: 2,
      reviewFeedback: 'New public evidence must be checked.',
      readyAt: NOW,
    });
    expect((await stat(join(
      context.root,
      '10_Tasks',
      'Active',
      'project-public-research',
      `${task.taskId}.md`,
    ))).isFile()).toBe(true);
    await expect(stat(join(
      context.root,
      '10_Tasks',
      'Archive',
      '2026',
      `${task.taskId}.md`,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await context.ctx.audit.listForTask(task.taskId)).toContainEqual({
      event: 'task.reopened',
      at: NOW,
      taskId: task.taskId,
    });
    expect(JSON.stringify(await context.ctx.audit.listForTask(task.taskId)))
      .not.toContain('New public evidence');
  });
});
