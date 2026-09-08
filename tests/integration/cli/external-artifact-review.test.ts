import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactResult } from '../../../src/domain/artifact.js';
import type { Task } from '../../../src/domain/task.js';
import { submitArtifact } from '../../../src/services/submit-artifact.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const contexts: Array<Awaited<ReturnType<typeof createTestServiceContext>>> = [];

async function setupReview(taskId: string): Promise<{
  context: Awaited<ReturnType<typeof createTestServiceContext>>;
  task: Task;
}> {
  const context = await createTestServiceContext();
  contexts.push(context);
  const task: Task = {
    schemaVersion: 1,
    taskId,
    title: 'Synthetic external review',
    body: '',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-synthetic',
    taskType: 'research',
    objective: 'Verify external review CLI.',
    acceptanceCriteria: ['Use synthetic evidence.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-08-13',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `synthetic:cli-external-review:${taskId}`,
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: `run-${taskId}`,
      agent: 'synthetic-agent',
      claimedAt: '2026-08-13T00:00:00.000Z',
      leaseExpiresAt: '2026-08-13T01:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-13T00:00:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
  await context.ctx.tasks.save(task);
  const result: ArtifactResult = {
    summary: 'Synthetic result.',
    findings: [],
    evidence: [{
      title: 'Synthetic evidence',
      url: 'https://example.com/evidence',
      accessedAt: '2026-08-13T00:00:00.000Z',
    }],
    uncertainties: [],
    recommendedActions: [],
    acceptance: [{
      criterion: 'Use synthetic evidence.',
      status: 'met',
      note: 'Synthetic evidence used.',
    }],
  };
  await submitArtifact(context.ctx, task.taskId, {
    runId: task.claim?.runId ?? '',
    result,
  });
  return { context, task };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('CLI external Artifact review', () => {
  it('accepts a version-bound DingTalk Stream review through the service boundary', async () => {
    const { context, task } = await setupReview('task-cli-external-review');

    const response = await execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'review-external',
      '--task-id', task.taskId,
      '--artifact-version', '1',
      '--response-event-id', 'dingtalk-cli-event-001',
      '--sender-user-id', 'trusted-user-001',
      '--conversation-id', 'trusted-conversation-001',
      '--approve',
      '--json',
    ], {
      cwd: repositoryRoot,
      env: { ATL_VAULT_ROOT: context.root },
      reject: false,
    });

    expect(response.exitCode, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      accepted: true,
      task: { taskId: task.taskId, status: 'done' },
    });
  }, 30_000);

  it('reads private Artifact feedback from stdin instead of argv', async () => {
    const { context, task } = await setupReview('task-cli-private-feedback');
    const feedback = 'PRIVATE_FEEDBACK_SENTINEL';

    const response = await execa('pnpm', [
      'exec', 'tsx', cli,
      'task', 'review-external',
      '--task-id', task.taskId,
      '--artifact-version', '1',
      '--response-event-id', 'dingtalk-cli-event-private-feedback',
      '--sender-user-id', 'trusted-user-001',
      '--conversation-id', 'trusted-conversation-001',
      '--request-changes',
      '--private-input-stdin-json',
      '--json',
    ], {
      cwd: repositoryRoot,
      env: { ATL_VAULT_ROOT: context.root },
      input: JSON.stringify({ feedback }),
      reject: false,
    });

    expect(response.exitCode, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout)).toMatchObject({
      accepted: true,
      task: {
        taskId: task.taskId,
        status: 'agent_executable',
        reviewFeedback: feedback,
      },
    });
    expect(response.command).not.toContain(feedback);
  }, 30_000);
});
