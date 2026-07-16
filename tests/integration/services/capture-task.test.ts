import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { captureTask, type CaptureTaskInput } from '../../../src/services/capture-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { createTaskId } from '../../../src/services/service-context.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext();
  contexts.push(context);
  return context;
}

function captureInput(overrides: Partial<CaptureTaskInput> = {}): CaptureTaskInput {
  return {
    title: 'Review public product pricing',
    body: 'Sensitive synthetic task body.',
    origin: 'synthetic_test',
    sourceDate: '2026-07-14',
    sourceNote: '/synthetic/private-source.md',
    sourceQuote: 'Sensitive synthetic source quote.',
    sourceKey: 'synthetic:source-1',
    priority: 'high',
    ...overrides,
  };
}

function sourceLockPath(root: string, sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex');
  return join(
    root,
    '10_Tasks',
    '.atl',
    'source-key-locks',
    `${digest}.lock`,
  );
}

async function writeSyntheticSourceLock(
  root: string,
  sourceKey: string,
  metadata: {
    ownerToken: string;
    ownerPid: number;
    acquiredAt: string;
    leaseExpiresAt: string;
  },
): Promise<string> {
  const path = sourceLockPath(root, sourceKey);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  return path;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('createTaskId', () => {
  it('uses the local business date and lowercase ULID entropy', () => {
    const date = new Date(2026, 6, 14, 23, 59, 59);

    expect(createTaskId(date)).toMatch(/^task-20260714-[0-9a-z]{8}$/);
  });
});

describe('captureTask', () => {
  it('returns the existing task for the same source key without another write or audit event', async () => {
    const { ctx } = await makeContext();
    const input = captureInput();

    const first = await captureTask(ctx, input);
    const duplicate = await captureTask(ctx, input);

    expect(duplicate.taskId).toBe(first.taskId);
    expect(await ctx.tasks.list()).toHaveLength(1);
    await expect(ctx.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
  });

  it('atomically captures one task and audit event across independent repositories', async () => {
    const context = await makeContext();
    const second = context.createIndependentContext({
      ids: ['task-20260714-00000002'],
    });
    const input = captureInput();

    const [left, right] = await Promise.all([
      captureTask(context.ctx, input),
      captureTask(second, input),
    ]);

    expect(right.taskId).toBe(left.taskId);
    expect(await context.ctx.tasks.list()).toHaveLength(1);
    await expect(context.ctx.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
  });

  it('does not reclaim an expired source lock while its owner process is alive', async () => {
    const context = await makeContext();
    const input = captureInput({
      sourceKey: 'synthetic:live-expired-source-lock',
    });
    const owner = context.createIndependentContext({
      ids: ['task-20260714-owner'],
      taskRepository: {
        sourceClaim: {
          leaseMs: 1,
          clock: () => new Date('2026-07-14T00:00:00.000Z'),
        },
      },
    });
    const contender = context.createIndependentContext({
      ids: ['task-20260714-contender'],
      taskRepository: {
        sourceClaim: {
          attempts: 1_000,
          retryMs: 1,
          leaseMs: 30_000,
          clock: () => new Date('2026-07-14T00:01:00.000Z'),
        },
      },
    });
    const lockHeld = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const findBySourceKey = owner.tasks.findBySourceKey.bind(owner.tasks);
    let findCalls = 0;
    owner.tasks.findBySourceKey = async (sourceKey) => {
      const existing = await findBySourceKey(sourceKey);
      findCalls += 1;
      if (findCalls === 2) {
        lockHeld.resolve();
        await proceed.promise;
      }
      return existing;
    };

    const ownerCapture = captureTask(owner, input);
    await lockHeld.promise;
    const contenderCapture = captureTask(contender, input);
    const contenderSettledWhileOwnerPaused = await Promise.race([
      contenderCapture.then(() => true),
      delay(250, false),
    ]);
    proceed.resolve();
    const [ownerTask, contenderTask] = await Promise.all([
      ownerCapture,
      contenderCapture,
    ]);

    expect(contenderSettledWhileOwnerPaused).toBe(false);
    expect(contenderTask.taskId).toBe(ownerTask.taskId);
    expect(await owner.tasks.list()).toHaveLength(1);
    await expect(owner.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
  });

  it('reclaims an expired source lock and captures exactly once', async () => {
    const context = await makeContext();
    const input = captureInput({
      sourceKey: 'synthetic:expired-source-lock',
    });
    const absentOwnerPid = 2_147_483_647;
    expect(() => process.kill(absentOwnerPid, 0)).toThrowError(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    const lockPath = await writeSyntheticSourceLock(
      context.root,
      input.sourceKey,
      {
        ownerToken: '00000000-0000-4000-8000-000000000001',
        ownerPid: absentOwnerPid,
        acquiredAt: '2026-07-13T23:58:00.000Z',
        leaseExpiresAt: '2026-07-13T23:59:00.000Z',
      },
    );
    const expired = new Date('2026-07-13T23:59:00.000Z');
    await utimes(lockPath, expired, expired);
    const independent = context.createIndependentContext({
      ids: ['task-20260714-00000002'],
      taskRepository: {
        sourceClaim: {
          attempts: 3,
          retryMs: 1,
          leaseMs: 30_000,
          clock: () => new Date('2026-07-14T00:00:00.000Z'),
        },
      },
    });

    const task = await captureTask(independent, input);

    expect(task.taskId).toBe('task-20260714-00000002');
    expect(await independent.tasks.list()).toHaveLength(1);
    await expect(independent.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reclaim a fresh source lock and times out without sensitive data', async () => {
    const context = await makeContext();
    const input = captureInput({
      body: 'fresh-lock-private-body',
      sourceKey: 'synthetic:fresh-source-lock-private',
    });
    const metadata = {
      ownerToken: '00000000-0000-4000-8000-000000000002',
      ownerPid: process.pid,
      acquiredAt: '2026-07-14T00:00:00.000Z',
      leaseExpiresAt: '2026-07-14T00:01:00.000Z',
    };
    const lockPath = await writeSyntheticSourceLock(
      context.root,
      input.sourceKey,
      metadata,
    );
    const independent = context.createIndependentContext({
      taskRepository: {
        sourceClaim: {
          attempts: 2,
          retryMs: 1,
          leaseMs: 30_000,
          clock: () => new Date('2026-07-14T00:00:30.000Z'),
        },
      },
    });

    const error = await captureTask(independent, input).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: 'task_source_claim_timeout',
      message: 'Task source claim timed out',
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(input.sourceKey);
    expect((error as Error).message).not.toContain(input.body);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(metadata)}\n`,
    );
    expect(await independent.tasks.list()).toEqual([]);
    await expect(independent.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(0);
  });

  it('creates separate tasks for different source evidence', async () => {
    const { ctx } = await makeContext();

    const first = await captureTask(ctx, captureInput());
    const second = await captureTask(ctx, captureInput({
      sourceKey: 'synthetic:source-2',
      sourceNote: '/synthetic/different-private-source.md',
      sourceQuote: 'A different synthetic source quote.',
    }));

    expect(second.taskId).not.toBe(first.taskId);
    expect(await ctx.tasks.list()).toHaveLength(2);
  });

  it.each([
    ['daily review first', 'explicit_wechat_todo', 'obsidian_sync'],
    ['real-time scan first', 'obsidian_sync', 'explicit_wechat_todo'],
  ])('deduplicates the same action when %s', async (
    _label,
    firstOrigin,
    secondOrigin,
  ) => {
    const { ctx } = await makeContext();
    const first = await captureTask(ctx, captureInput({
      title: '调研实时同步助手待办方案',
      origin: firstOrigin,
      sourceKey: `${firstOrigin}:source`,
      sourceNote: '/vault/笔记同步助手/2026-07-17/同步助手_2026-07-17.md',
      sourceQuote: '我想实时从同步助手获取待办，然后让 AI 在下午先跑掉。',
    }));

    const duplicate = await captureTask(ctx, captureInput({
      title: '实时获取同步助手里的待办方案调研',
      origin: secondOrigin,
      sourceKey: `${secondOrigin}:source`,
      sourceNote: '/vault/笔记同步助手/2026-07-17/同步助手_2026-07-17.md',
      sourceQuote: '我想实时从同步助手获取待办，然后让 AI 在下午先跑掉',
    }));

    expect(duplicate.taskId).toBe(first.taskId);
    expect(await ctx.tasks.list()).toHaveLength(1);
    await expect(ctx.audit.count({
      event: 'task.captured',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
  });

  it('always creates a non-executable candidate in the inbox', async () => {
    const { ctx } = await makeContext();

    const first = await captureTask(ctx, captureInput());

    expect(first.status).toBe('inbox');
    expect(first.reviewState).toBe('candidate');
    expect(first.autoExecutable).toBe(false);
    expect(first).toMatchObject({
      projectId: null,
      taskType: null,
      objective: null,
      permissionProfile: null,
      acceptanceCriteria: [],
      attempts: 0,
      claim: null,
      artifactRefs: [],
      reviewFeedback: null,
      readyAt: null,
    });
  });

  it('preserves highly similar titles from different sources and records a duplicate hint', async () => {
    const { ctx } = await makeContext();
    const first = await captureTask(ctx, captureInput());

    const similar = await captureTask(ctx, captureInput({
      title: 'REVIEW public product pricing!',
      sourceKey: 'synthetic:source-2',
      sourceNote: '/synthetic/second-private-source.md',
      sourceQuote: 'A second source independently requests a pricing review.',
    }));

    expect(await ctx.tasks.list()).toHaveLength(2);
    expect(similar.possibleDuplicateIds).toEqual([first.taskId]);
  });

  it('does not hint at dissimilar titles', async () => {
    const { ctx } = await makeContext();
    await captureTask(ctx, captureInput());

    const dissimilar = await captureTask(ctx, captureInput({
      title: 'Draft quarterly hiring plan',
      sourceKey: 'synthetic:source-2',
    }));

    expect(dissimilar.possibleDuplicateIds).toEqual([]);
  });

  it('appends a sanitized audit event without body or source text', async () => {
    const { ctx, root } = await makeContext();
    const task = await captureTask(ctx, captureInput());

    const events = await ctx.audit.listForTask(task.taskId);
    const serialized = JSON.stringify(events);
    expect(events).toEqual([{
      event: 'task.captured',
      at: '2026-07-14T00:00:00.000Z',
      taskId: task.taskId,
      details: {
        origin: 'synthetic_test',
        priority: 'high',
      },
    }]);
    expect(serialized).not.toContain('Sensitive synthetic task body.');
    expect(serialized).not.toContain('Sensitive synthetic source quote.');
    expect(serialized).not.toContain('/synthetic/private-source.md');
    expect(await readFile(
      join(root, '10_Tasks', 'Audit', '2026-07-14.jsonl'),
      'utf8',
    )).not.toContain('Sensitive synthetic');
  });

  it('rejects invalid input without exposing sensitive values', async () => {
    const { ctx } = await makeContext();
    const error = await captureTask(ctx, captureInput({
      title: '',
      body: 'body-that-must-stay-private',
      sourceQuote: 'quote-that-must-stay-private',
      priority: 'invalid' as CaptureTaskInput['priority'],
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Invalid capture task input');
    expect((error as Error).message).not.toContain('body-that-must-stay-private');
    expect((error as Error).message).not.toContain('quote-that-must-stay-private');
  });
});

describe('createProject', () => {
  it('persists a user-readable description and explicit resources', async () => {
    const { ctx } = await makeContext();
    const input = {
      projectId: 'project-public-research',
      name: 'Public research',
      description: 'Track evidence-backed public research work.',
      resources: [
        {
          kind: 'url' as const,
          value: 'https://example.com/public',
          label: 'Public reference',
        },
        {
          kind: 'local_path' as const,
          value: '/synthetic/reference-only',
          label: 'Reference metadata',
        },
        {
          kind: 'github_repo' as const,
          value: 'example/public-research',
          label: 'Repository',
        },
      ],
    };

    const project = await createProject(ctx, input);

    await expect(ctx.projects.get(project.projectId)).resolves.toEqual({
      ...input,
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
  });

  it('rejects a duplicate project ID with a sanitized error', async () => {
    const { ctx } = await makeContext();
    const input = {
      projectId: 'project-public-research',
      name: 'Public research',
      description: 'Synthetic project description.',
      resources: [],
    };
    await createProject(ctx, input);

    await expect(createProject(ctx, {
      ...input,
      description: 'duplicate-description-that-must-stay-private',
    })).rejects.toMatchObject({
      code: 'project_already_exists',
      message: 'Project already exists: project-public-research',
    });
  });

  it('atomically rejects one concurrent same-ID creation without replacing the winner', async () => {
    const context = await makeContext();
    const second = context.createIndependentContext();
    const base = {
      projectId: 'project-concurrent-research',
      name: 'Concurrent research',
      resources: [],
    };

    const results = await Promise.allSettled([
      createProject(context.ctx, {
        ...base,
        description: 'First contender content.',
      }),
      createProject(second, {
        ...base,
        description: 'Second contender content.',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: 'project_already_exists',
        message: 'Project already exists: project-concurrent-research',
      },
    });
    const winner = fulfilled[0];
    expect(winner?.status).toBe('fulfilled');
    if (winner?.status !== 'fulfilled') {
      throw new Error('Expected one project creation to succeed');
    }
    await expect(context.ctx.projects.get(base.projectId)).resolves.toEqual(
      winner.value,
    );
    await expect(context.ctx.audit.count({
      event: 'project.created',
      localDate: '2026-07-14',
    })).resolves.toBe(1);
  });

  it('appends a sanitized project audit event', async () => {
    const { ctx, root } = await makeContext();
    await createProject(ctx, {
      projectId: 'project-public-research',
      name: 'Private synthetic project name',
      description: 'description-that-must-stay-private',
      resources: [{
        kind: 'local_path',
        value: '/path-that-must-stay-private',
        label: 'label-that-must-stay-private',
      }],
    });

    const audit = await readFile(
      join(root, '10_Tasks', 'Audit', '2026-07-14.jsonl'),
      'utf8',
    );
    expect(JSON.parse(audit.trim())).toEqual({
      event: 'project.created',
      at: '2026-07-14T00:00:00.000Z',
      projectId: 'project-public-research',
      details: { resourceCount: 1 },
    });
    expect(audit).not.toContain('description-that-must-stay-private');
    expect(audit).not.toContain('/path-that-must-stay-private');
    expect(audit).not.toContain('label-that-must-stay-private');
  });
});
