import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { ClaudeDriverError } from '../../../src/runner/claude-driver.js';
import type { ResearchDriver } from '../../../src/runner/research-driver.js';
import {
  createRunnerController,
  getRunnerStatus,
  RunnerBusyError,
} from '../../../src/runner/runner-controller.js';
import type { ResearchResult } from '../../../src/runner/result-contract.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-07-15T00:00:00.000Z';
const contexts: TestServiceContext[] = [];

function project(): Project {
  return {
    projectId: 'project-runner',
    name: 'Synthetic runner project',
    description: 'Research only public sources.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function readyTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-runner-default',
    title: 'Synthetic public research task',
    body: '\nPRIVATE_BODY_SENTINEL_MUST_NOT_ENTER_AUDIT\n',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-runner',
    taskType: 'research',
    objective: 'Compare public product limits.',
    acceptanceCriteria: ['Cite one official HTTPS source.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_runner_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:runner-default',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function result(status: 'met' | 'partial' = 'met'): ResearchResult {
  return {
    summary: 'The public limit was verified.',
    findings: ['The documented limit is synthetic.'],
    evidence: [{
      title: 'Official documentation',
      url: 'https://example.com/docs',
      accessedAt: NOW,
    }],
    uncertainties: status === 'partial' ? ['One secondary detail is unclear.'] : [],
    recommendedActions: [],
    acceptance: [{
      criterion: 'Cite one official HTTPS source.',
      status,
      note: status === 'partial' ? 'Partially supported.' : 'Supported.',
    }],
  };
}

function fakeDriver(execute: ResearchDriver['execute']): ResearchDriver {
  return { name: 'synthetic-driver', execute };
}

async function setup(
  tasks: Task[] = [readyTask()],
): Promise<TestServiceContext> {
  const context = await createTestServiceContext({
    now: new Date(NOW),
  });
  contexts.push(context);
  await context.ctx.projects.create(project());
  for (const task of tasks) {
    await context.ctx.tasks.save(task);
  }
  return context;
}

function controller(
  context: TestServiceContext,
  driver: ResearchDriver,
  runIds: string[] = ['run-runner-001'],
) {
  let nextRun = 0;
  return createRunnerController({
    ctx: context.ctx,
    driver,
    runtimeRoot: join(context.root, '.atl-runtime'),
    allowedLocalRoots: [],
    dailyLimit: 3,
    leaseMinutes: 60,
    timeoutMs: 30 * 60 * 1000,
    agent: 'synthetic-runner',
    runId: () => {
      const runId = runIds[nextRun];
      if (runId === undefined) throw new Error('Run ID sequence exhausted');
      nextRun += 1;
      return runId;
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('bounded run-once orchestration', () => {
  it('reports empty runner status without initializing or changing storage', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);

    await expect(getRunnerStatus(context.ctx, { dailyLimit: 3 })).resolves.toEqual({
      latestRun: null,
      automaticClaimsToday: 0,
      dailyLimit: 3,
      blockedTasks: [],
      nextEligibleTask: null,
    });
    await expect(stat(join(context.root, '10_Tasks')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('claims, builds context, executes and submits one eligible task', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    const outcome = await controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    });

    expect(outcome).toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      artifactRef: 'Artifacts/task-runner-default/attempt-001.md',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      task: { taskId: 'task-runner-default', status: 'in_progress', attempts: 1 },
      context: { taskId: 'task-runner-default' },
      timeoutMs: 30 * 60 * 1000,
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
      claim: null,
      artifactRefs: ['Artifacts/task-runner-default/attempt-001.md'],
    });
    await expect(getRunnerStatus(context.ctx, { dailyLimit: 3 })).resolves
      .toMatchObject({
        latestRun: {
          event: 'artifact.submitted',
          taskId: 'task-runner-default',
          runId: 'run-runner-001',
        },
        automaticClaimsToday: 1,
      });
    await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns no_task without calling the driver when nothing is eligible', async () => {
    const context = await setup([]);
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'no_task' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports the daily limit separately and does not claim a task', async () => {
    const context = await setup();
    for (let index = 0; index < 3; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-15T00:00:0${index}.000Z`,
        taskId: `task-already-${index}`,
        runId: `run-already-${index}`,
        details: { mode: 'automatic' },
      });
    }
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'daily_limit' });
    expect(execute).not.toHaveBeenCalled();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'ready',
      attempts: 0,
      claim: null,
    });
  });

  it('requeues the first typed driver failure with only a sanitized audit code', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockRejectedValue(new ClaudeDriverError('claude_timeout'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'requeued',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: 'claude_timeout',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'ready',
      attempts: 1,
      claim: null,
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit).toContainEqual(expect.objectContaining({
      event: 'runner.failed',
      runId: 'run-runner-001',
      details: {
        errorCode: 'claude_timeout',
        attempt: 1,
        mode: 'automatic',
        outcome: 'requeued',
      },
    }));
    expect(JSON.stringify(audit)).not.toContain('PRIVATE_BODY_SENTINEL');
  });

  it('blocks the second typed driver failure', async () => {
    const context = await setup([readyTask({ attempts: 1 })]);
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockRejectedValue(new ClaudeDriverError('claude_timeout'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({
      status: 'blocked',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: 'claude_timeout',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 2,
      claim: null,
    });
  });

  it('lets a named manual run bypass the automatic daily limit', async () => {
    const context = await setup();
    for (let index = 0; index < 3; index += 1) {
      await context.ctx.audit.append({
        event: 'task.claimed',
        at: `2026-07-15T00:00:0${index}.000Z`,
        taskId: `task-already-${index}`,
        details: { mode: 'automatic' },
      });
    }

    await expect(controller(
      context,
      fakeDriver(async () => result()),
    ).runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
    });
  });

  it('submits a partial result to Review without retrying', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValue(result('partial'));

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({ status: 'submitted' });
    expect(execute).toHaveBeenCalledOnce();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
    });
  });

  it('recovers an expired claim before selecting and running the task', async () => {
    const context = await setup([readyTask({
      status: 'in_progress',
      attempts: 1,
      claim: {
        runId: 'run-expired',
        agent: 'old-runner',
        claimedAt: '2026-07-14T22:00:00.000Z',
        leaseExpiresAt: '2026-07-14T23:00:00.000Z',
      },
    })]);
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 2,
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claim_expired',
      'task.claimed',
      'artifact.submitted',
    ]);
  });

  it('returns runner_busy to a second controller without claiming its waiting task', async () => {
    let releaseDriver!: (value: ResearchResult) => void;
    const waitingDriver = new Promise<ResearchResult>((resolve) => {
      releaseDriver = resolve;
    });
    const context = await setup([
      readyTask({ taskId: 'task-running', sourceKey: 'synthetic:running' }),
      readyTask({ taskId: 'task-waiting', sourceKey: 'synthetic:waiting' }),
    ]);
    const first = controller(
      context,
      fakeDriver(() => waitingDriver),
      ['run-first'],
    );
    const firstRun = first.runAndWait({ mode: 'automatic' });
    await vi.waitFor(async () => {
      await expect(context.ctx.tasks.get('task-running')).resolves.toMatchObject({
        status: 'in_progress',
      });
    });
    const second = controller(
      context,
      fakeDriver(async () => result()),
      ['run-second'],
    );

    await expect(second.runAndWait({ mode: 'automatic' })).resolves.toEqual({
      status: 'runner_busy',
    });
    await expect(context.ctx.tasks.get('task-waiting')).resolves.toMatchObject({
      status: 'ready',
      attempts: 0,
      claim: null,
    });
    await expect(context.ctx.audit.count({
      event: 'runner.busy',
      localDate: '2026-07-15',
      mode: 'automatic',
    })).resolves.toBe(1);

    releaseDriver(result());
    await expect(firstRun).resolves.toMatchObject({ status: 'submitted' });
  });

  it('acquires the lock before start returns and rejects a competing start', async () => {
    let releaseDriver!: (value: ResearchResult) => void;
    const waitingDriver = new Promise<ResearchResult>((resolve) => {
      releaseDriver = resolve;
    });
    const context = await setup();
    const runner = controller(
      context,
      fakeDriver(() => waitingDriver),
      ['run-background', 'run-competing'],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({ runId: 'run-background' });
    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).rejects.toBeInstanceOf(RunnerBusyError);

    releaseDriver(result());
    await vi.waitFor(async () => {
      await expect(context.ctx.tasks.get('task-runner-default')).resolves
        .toMatchObject({ status: 'review' });
      await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('releases the lock when start fails before launching the background pipeline', async () => {
    const context = await setup();
    const runner = controller(
      context,
      fakeDriver(async () => result()),
      [],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).rejects.toThrow('Run ID sequence exhausted');
    await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sanitizes a terminal background failure and releases the lock', async () => {
    const context = await setup([]);
    const runner = controller(
      context,
      fakeDriver(async () => result()),
      ['run-terminal'],
    );

    await expect(runner.start({
      mode: 'manual',
      taskId: 'PRIVATE_TERMINAL_SENTINEL\ninvalid',
    })).resolves.toEqual({ runId: 'run-terminal' });
    await vi.waitFor(async () => {
      await expect(context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      })).resolves.toMatchObject({
        event: 'runner.terminal_failure',
        runId: 'run-terminal',
        details: {
          errorCode: 'invalid_task_data',
          mode: 'manual',
        },
      });
      expect(await context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      })).not.toHaveProperty('taskId');
      expect(JSON.stringify(await context.ctx.audit.latest({
        events: ['runner.terminal_failure'],
      }))).not.toContain('PRIVATE_TERMINAL_SENTINEL');
      await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
