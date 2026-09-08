import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MulticaDispatchConnector } from '../../../src/connectors/multica-cli-connector.js';
import type { Task } from '../../../src/domain/task.js';
import { AgentAuthorizationInvalidStateError } from '../../../src/services/authorize-agent-execution.js';
import {
  authorizeDevelopmentTask,
  DevelopmentAuthorizationNotReadyError,
} from '../../../src/services/authorize-development-task.js';
import type { DispatchDevelopmentTaskDependencies } from '../../../src/services/dispatch-development-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';

function readyDevelopmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260820-dev00001',
    title: 'Ship the dispatch slice',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Deliver the unique Multica dispatch',
    acceptanceCriteria: ['Exactly one remote issue per authorized task'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:authorize-dev-1',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-20T00:00:00.000Z',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function linkedConnector(): MulticaDispatchConnector {
  return {
    ensureIssue: async () => ({
      status: 'linked' as const,
      ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
      recovered: false,
      activation: { assigneeId: SQUAD_ID, runId: 'run-initial', recovered: false },
    }),
    inspect: async () => {
      throw new Error('inspect is not used by authorization');
    },
  };
}

describe('authorizeDevelopmentTask', () => {
  let harness: TestServiceContext;
  let dependencies: DispatchDevelopmentTaskDependencies;

  beforeEach(async () => {
    harness = await createTestServiceContext();
    dependencies = {
      connector: linkedConnector(),
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('fails closed with field-level reasons when the task is incomplete', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(readyDevelopmentTask({
      reviewState: 'candidate',
      contextRefs: [],
    }));

    const error = await authorizeDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-dev00001',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DevelopmentAuthorizationNotReadyError);
    expect((error as DevelopmentAuthorizationNotReadyError).errors).toEqual([
      'reviewState must be confirmed',
      'contextRefs requires at least one item',
    ]);
    const task = await harness.ctx.tasks.get('task-20260820-dev00001');
    expect(task.status).toBe('ready');
  });

  it('rejects a task that is not ready', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(readyDevelopmentTask({
      status: 'in_progress',
    }));

    await expect(authorizeDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-dev00001',
    )).rejects.toThrowError(AgentAuthorizationInvalidStateError);
  });

  it('rejects a research task that is not externally executed', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(readyDevelopmentTask({
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionTarget: null,
    }));

    const error = await authorizeDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-dev00001',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DevelopmentAuthorizationNotReadyError);
    expect((error as DevelopmentAuthorizationNotReadyError).errors).toContain(
      'executionTarget must be multica',
    );
  });

  it('authorizes and immediately dispatches the unique issue', async () => {
    await harness.ctx.tasks.createIfSourceKeyAbsent(readyDevelopmentTask());

    const result = await authorizeDevelopmentTask(
      harness.ctx,
      dependencies,
      'task-20260820-dev00001',
    );

    expect(result.task.status).toBe('agent_executable');
    expect(result.dispatch).toMatchObject({
      status: 'linked',
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
    });
    const stored = await harness.ctx.tasks.get('task-20260820-dev00001');
    expect(stored.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId: ISSUE_ID,
    });
  });

  it('keeps the authorization when the immediate dispatch fails remotely', async () => {
    const failing: MulticaDispatchConnector = {
      ensureIssue: async () => ({
        status: 'remote_write_unknown' as const,
        reason: 'issue create: multica_call_timed_out',
      }),
      inspect: async () => {
        throw new Error('not used');
      },
    };
    await harness.ctx.tasks.createIfSourceKeyAbsent(readyDevelopmentTask());

    const result = await authorizeDevelopmentTask(
      harness.ctx,
      { ...dependencies, connector: failing },
      'task-20260820-dev00001',
    );

    expect(result.task.status).toBe('agent_executable');
    expect(result.dispatch).toMatchObject({ status: 'remote_write_unknown' });
    const stored = await harness.ctx.tasks.get('task-20260820-dev00001');
    expect(stored.status).toBe('agent_executable');
    expect(stored.executionLink?.dispatchState).toBe('remote_write_unknown');
  });
});
