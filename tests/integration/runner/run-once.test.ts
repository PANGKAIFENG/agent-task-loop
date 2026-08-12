import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import type { AcceptanceObject } from '../../../src/domain/acceptance-object.js';
import { ClaudeDriverError } from '../../../src/runner/claude-driver.js';
import type { ResearchDriver } from '../../../src/runner/research-driver.js';
import {
  createRunnerController,
  getRunnerStatus,
  RunnerBusyError,
} from '../../../src/runner/runner-controller.js';
import type { ResearchResult } from '../../../src/runner/result-contract.js';
import { recordDecision } from '../../../src/services/record-decision.js';
import { reviewArtifactFromExternalReply } from '../../../src/services/review-artifact-from-external-reply.js';
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

function agentExecutableTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-runner-default',
    title: 'Synthetic public research task',
    body: '\nPRIVATE_BODY_SENTINEL_MUST_NOT_ENTER_AUDIT\n',
    status: 'agent_executable',
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
  tasks: Task[] = [agentExecutableTask()],
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

    await expect(getRunnerStatus(context.ctx)).resolves.toEqual({
      latestRun: null,
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
      profile: {
        profileId: 'research_v1',
        profileVersion: 1,
        allowedTools: ['WebSearch', 'WebFetch', 'Read'],
      },
      timeoutMs: 30 * 60 * 1000,
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
      claim: null,
      artifactRefs: ['Artifacts/task-runner-default/attempt-001.md'],
    });
    await expect(getRunnerStatus(context.ctx)).resolves
      .toMatchObject({
        latestRun: {
          event: 'artifact.submitted',
          taskId: 'task-runner-default',
          runId: 'run-runner-001',
        },
      });
    await expect(stat(join(context.root, '.atl-runtime', 'runner.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('freezes one Runtime Pack before execution and binds it to the Artifact and audit', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockImplementation(async ({ context: bundle }) => {
      const files = await readdir(join(context.root, '.atl-runtime', 'context-packs'));
      expect(files).toEqual([`${bundle.packId}.json`]);
      return result();
    });

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({ status: 'submitted' });

    const bundle = execute.mock.calls[0]?.[0].context;
    expect(bundle?.packId).toMatch(/^pack-[0-9a-f]{24}$/);
    const artifact = await readFile(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      'task-runner-default',
      'attempt-001.md',
    ), 'utf8');
    expect(artifact).toContain(`pack_id: ${bundle?.packId}`);
    await expect(context.ctx.audit.listForTask('task-runner-default')).resolves
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'context_pack.frozen',
          runId: 'run-runner-001',
          details: expect.objectContaining({
            packId: bundle?.packId,
            blockCount: 2,
            permissionProfile: 'read_only_research',
            executionProfileId: 'research_v1',
            executionProfileVersion: 1,
          }),
        }),
        expect.objectContaining({
          event: 'artifact.submitted',
          details: expect.objectContaining({ packId: bundle?.packId }),
        }),
      ]));
  });

  it('reworks a DingTalk-reviewed Artifact into a new version and sends it for acceptance again', async () => {
    const context = await setup();
    const notifications: AcceptanceObject[] = [];
    context.ctx.notifyAcceptance = async (object) => {
      notifications.push(object);
    };
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async ({ context: bundle }) => {
        expect(bundle.blocks[0]?.content).toContain('补充真实用户证据');
        expect(bundle.blocks).toContainEqual(expect.objectContaining({
          label: 'previous_artifact',
          kind: 'artifact_review',
          content: expect.stringContaining('Summary: The public limit was verified.'),
        }));
        return {
          ...result(),
          summary: 'The public limit and user evidence were verified.',
        };
      });
    const runner = controller(context, fakeDriver(execute), [
      'run-artifact-v1',
      'run-artifact-v2',
    ]);

    await runner.runAndWait({ mode: 'automatic' });
    await reviewArtifactFromExternalReply(context.ctx, 'task-runner-default', {
      artifactVersion: 1,
      responseEventId: 'dingtalk-artifact-rework-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      decision: 'request_changes',
      feedback: '补充真实用户证据。',
    });
    await expect(runner.runAndWait({
      mode: 'manual',
      taskId: 'task-runner-default',
    })).resolves.toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-artifact-v2',
      artifactRef: 'Artifacts/task-runner-default/attempt-002.md',
    });

    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 2,
      artifactRefs: [
        'Artifacts/task-runner-default/attempt-001.md',
        'Artifacts/task-runner-default/attempt-002.md',
      ],
      reviewFeedback: null,
    });
    const reworkPackIds = execute.mock.calls.map((call) => call[0].context.packId);
    expect(reworkPackIds[0]).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(reworkPackIds[1]).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(reworkPackIds[1]).not.toBe(reworkPackIds[0]);
    const secondArtifact = await readFile(join(
      context.root,
      '10_Tasks',
      'Artifacts',
      'task-runner-default',
      'attempt-002.md',
    ), 'utf8');
    expect(secondArtifact).toContain(`pack_id: ${reworkPackIds[1]}`);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({
      artifact: {
        reference: 'task-runner-default@v2',
        summary: 'The public limit and user evidence were verified.',
        evidenceCount: 1,
      },
    });
  });

  it('returns no_task without calling the driver when nothing is eligible', async () => {
    const context = await setup([]);
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'no_task' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps claiming eligible tasks regardless of earlier claims that day', async () => {
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
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue(result());

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toMatchObject({
      status: 'submitted',
      taskId: 'task-runner-default',
    });
    expect(execute).toHaveBeenCalledOnce();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'review',
      attempts: 1,
      claim: null,
    });
  });

  it('pauses a task when the driver requests a user decision', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue({
      kind: 'decision_request',
      decisionRequestId: 'decision-runner-001',
      question: 'Which direction should continue?',
      options: [
        { id: 'option-a', label: 'Option A' },
        { id: 'option-b', label: 'Option B' },
      ],
    } as never);

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'waiting_for_decision',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      decisionRequestId: 'decision-runner-001',
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves
      .toMatchObject({
        status: 'waiting_for_decision',
        claim: null,
        pendingDecision: { requestId: 'decision-runner-001' },
      });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claimed',
      'context_pack.frozen',
      'decision.requested',
    ]);
  });

  it('continues the same task with a new run after one exact decision event', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-continuation-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockResolvedValueOnce(result());
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-continuation',
    ]);

    await expect(runner.runAndWait({ mode: 'automatic' })).resolves.toMatchObject({
      status: 'waiting_for_decision',
      runId: 'run-initial',
    });
    const decisionEvent = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-continuation-001',
      responseEventId: 'dingtalk-message-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use option B and continue.',
    };

    await expect(runner.continueAfterDecision(decisionEvent)).resolves.toEqual({
      status: 'submitted',
      taskId: 'task-runner-default',
      runId: 'run-continuation',
      artifactRef: 'Artifacts/task-runner-default/attempt-002.md',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const initialPackId = execute.mock.calls[0]?.[0].context.packId;
    const continuationPackId = execute.mock.calls[1]?.[0].context.packId;
    expect(initialPackId).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(continuationPackId).toMatch(/^pack-[0-9a-f]{24}$/);
    expect(continuationPackId).not.toBe(initialPackId);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      task: {
        taskId: 'task-runner-default',
        attempts: 2,
        claim: { runId: 'run-continuation' },
        lastDecision: {
          requestId: 'decision-continuation-001',
          responseEventId: 'dingtalk-message-001',
          senderUserId: 'trusted-user-001',
          conversationId: 'trusted-conversation-001',
        },
      },
      context: {
        blocks: [expect.objectContaining({
          content: expect.stringContaining('Use option B and continue.'),
        }), expect.anything()],
      },
    });

    await expect(runner.continueAfterDecision(decisionEvent)).resolves.toEqual({
      status: 'duplicate_decision',
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-continuation-001',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resumes an exact event replay when the decision committed before a crash', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-recovery-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockResolvedValueOnce(result());
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-recovered',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-recovery-001',
      responseEventId: 'dingtalk-message-recovery-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-b',
      responseText: 'Use option B and continue.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    const { taskId, ...decision } = event;
    await expect(recordDecision(context.ctx, taskId, decision))
      .resolves.toMatchObject({ accepted: true });
    await expect(runner.continueAfterDecision(event)).resolves.toMatchObject({
      status: 'submitted',
      runId: 'run-recovered',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('starts only one continuation when the same reply arrives concurrently', async () => {
    const context = await setup();
    let releaseContinuation: (() => void) | undefined;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-concurrent-001',
        question: 'Which direction should continue?',
        options: [
          { id: 'option-a', label: 'Option A' },
          { id: 'option-b', label: 'Option B' },
        ],
      })
      .mockImplementationOnce(async () => {
        await continuationGate;
        return result();
      });
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-continuation',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-concurrent-001',
      responseEventId: 'dingtalk-message-concurrent-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    const first = runner.continueAfterDecision(event);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const second = runner.continueAfterDecision(event);
    releaseContinuation?.();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.filter(({ status }) => status === 'submitted')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.filter(({ event: name }) => name === 'decision.continuation_started'))
      .toHaveLength(1);
  });

  it('does not execute a failed continuation again when its reply event is replayed', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>()
      .mockResolvedValueOnce({
        kind: 'decision_request',
        decisionRequestId: 'decision-failed-continuation-001',
        question: 'Which direction should continue?',
        options: [{ id: 'option-a', label: 'Option A' }],
      })
      .mockRejectedValueOnce(new ClaudeDriverError('claude_timeout'));
    const runner = controller(context, fakeDriver(execute), [
      'run-initial',
      'run-failed-continuation',
    ]);
    const event = {
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-failed-continuation-001',
      responseEventId: 'dingtalk-message-failed-continuation-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    };
    await runner.runAndWait({ mode: 'automatic' });

    await expect(runner.continueAfterDecision(event)).resolves.toMatchObject({
      status: 'blocked',
      runId: 'run-failed-continuation',
    });
    await expect(runner.continueAfterDecision(event)).resolves.toEqual({
      status: 'duplicate_decision',
      taskId: 'task-runner-default',
      decisionRequestId: 'decision-failed-continuation-001',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not let the automatic runner steal a recorded decision awaiting continuation', async () => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockResolvedValue({
      kind: 'decision_request',
      decisionRequestId: 'decision-awaiting-continuation-001',
      question: 'Which direction should continue?',
      options: [{ id: 'option-a', label: 'Option A' }],
    } as never);
    const runner = controller(context, fakeDriver(execute), ['run-initial']);
    await runner.runAndWait({ mode: 'automatic' });
    await recordDecision(context.ctx, 'task-runner-default', {
      decisionRequestId: 'decision-awaiting-continuation-001',
      responseEventId: 'dingtalk-message-awaiting-continuation-001',
      senderUserId: 'trusted-user-001',
      conversationId: 'trusted-conversation-001',
      selectedOptionId: 'option-a',
      responseText: 'Use option A.',
    });

    await expect(controller(
      context,
      fakeDriver(vi.fn<ResearchDriver['execute']>()),
    ).runAndWait({ mode: 'automatic' })).resolves.toEqual({ status: 'no_task' });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'agent_executable',
      attempts: 1,
      lastDecision: { continuationRunId: null },
    });
  });

  it('does not rerun a continuation whose expired claim was recovered', async () => {
    const context = await setup([agentExecutableTask({
      status: 'in_progress',
      attempts: 2,
      claim: {
        runId: 'run-expired-continuation',
        agent: 'synthetic-runner',
        claimedAt: '2026-07-14T22:00:00.000Z',
        leaseExpiresAt: '2026-07-14T23:00:00.000Z',
      },
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-recovered-continuation-001',
        selectedOptionId: 'option-a',
        selectedOptionLabel: 'Option A',
        responseText: 'Use option A.',
        responseEventId: 'dingtalk-message-recovered-continuation-001',
        senderUserId: 'trusted-user-001',
        conversationId: 'trusted-conversation-001',
        respondedAt: NOW,
        continuationRunId: 'run-expired-continuation',
        continuationOfRunId: 'run-initial',
        continuationStartedAt: NOW,
      },
    })]);
    const execute = vi.fn<ResearchDriver['execute']>();

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({ status: 'no_task' });
    expect(execute).not.toHaveBeenCalled();
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 2,
      claim: null,
      lastDecision: { continuationRunId: 'run-expired-continuation' },
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
      status: 'agent_executable',
      attempts: 1,
      claim: null,
    });
    const audit = await context.ctx.audit.listForTask('task-runner-default');
    expect(audit.map(({ event }) => event)).toEqual([
      'task.claimed',
      'context_pack.frozen',
      'runner.failed',
    ]);
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
    const context = await setup([agentExecutableTask({ attempts: 1 })]);
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

  it.each([
    'execution_profile_not_supported',
    'execution_profile_context_missing',
  ])('blocks deterministic Profile failure %s without retrying', async (code) => {
    const context = await setup();
    const execute = vi.fn<ResearchDriver['execute']>().mockRejectedValue(
      Object.assign(new Error('sanitized deterministic failure'), { code }),
    );

    await expect(controller(context, fakeDriver(execute)).runAndWait({
      mode: 'automatic',
    })).resolves.toEqual({
      status: 'blocked',
      taskId: 'task-runner-default',
      runId: 'run-runner-001',
      errorCode: code,
    });
    await expect(context.ctx.tasks.get('task-runner-default')).resolves.toMatchObject({
      status: 'blocked',
      attempts: 1,
      claim: null,
    });
    await expect(context.ctx.audit.listForTask('task-runner-default')).resolves
      .toContainEqual(expect.objectContaining({
        event: 'runner.failed',
        details: expect.objectContaining({ errorCode: code, outcome: 'blocked' }),
      }));
  });

  it('lets a named manual run proceed regardless of earlier automatic claims', async () => {
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
    const context = await setup([agentExecutableTask({
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
      'context_pack.frozen',
      'artifact.submitted',
    ]);
  });

  it('returns runner_busy to a second controller without claiming its waiting task', async () => {
    let releaseDriver!: (value: ResearchResult) => void;
    const waitingDriver = new Promise<ResearchResult>((resolve) => {
      releaseDriver = resolve;
    });
    const context = await setup([
      agentExecutableTask({ taskId: 'task-running', sourceKey: 'synthetic:running' }),
      agentExecutableTask({ taskId: 'task-waiting', sourceKey: 'synthetic:waiting' }),
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
      status: 'agent_executable',
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
