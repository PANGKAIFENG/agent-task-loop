import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MulticaDispatchConnector } from '../../../src/connectors/multica-cli-connector.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { authorizeResearchTask } from '../../../src/services/authorize-research-task.js';
import type { DispatchResearchTaskDependencies } from '../../../src/services/dispatch-research-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T06:00:00.000Z';
const ATL_PROJECT_ID = 'project-research-authorization';
const MULTICA_PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const RESEARCH_AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const contexts: TestServiceContext[] = [];

function project(): Project {
  return {
    projectId: ATL_PROJECT_ID,
    name: 'Synthetic research authorization',
    description: 'Synthetic project context only.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function readyTask(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260901-auth0001',
    title: 'Authorize one synthetic Research task',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: ATL_PROJECT_ID,
    taskType: 'research',
    objective: 'Start one trusted Multica research run.',
    acceptanceCriteria: ['Persist the exact Agent and Run binding.'],
    autoExecutable: false,
    permissionProfile: 'read_only_research',
    executionTarget: 'multica',
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:research-authorization',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('authorizeResearchTask', () => {
  it('authorizes and immediately dispatches through the Research Agent path', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project());
    await context.ctx.tasks.createIfSourceKeyAbsent(readyTask());
    const ensureIssue = vi.fn<MulticaDispatchConnector['ensureIssue']>(async () => ({
      status: 'linked',
      ref: {
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-999',
      },
      recovered: false,
      activation: {
        assigneeId: RESEARCH_AGENT_ID,
        runId: 'run-research-auth-1',
        runStatus: 'running',
        runAgentId: RESEARCH_AGENT_ID,
        runRuntimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
        recovered: false,
        agent: {
          agentId: RESEARCH_AGENT_ID,
          workspaceId: WORKSPACE_ID,
          model: 'gpt-5.6-sol',
          maxConcurrentTasks: 10,
          runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        },
      },
    }));
    const dependencies: DispatchResearchTaskDependencies = {
      connector: {
        ensureIssue,
        inspect: async () => { throw new Error('not called'); },
      },
      target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      runtimeRoot: join(context.root, '.atl-runtime'),
      allowedContextRoots: [context.root],
      contextBaseRoot: context.root,
      discoverContext: async ({ task, project }) => ({
        additionalLocalContexts: [],
        candidates: [
          {
            candidateId: 'task-current',
            category: 'task',
            sourceRef: `task://${task.taskId}`,
            version: task.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The current Task defines the objective.',
            blockLabel: 'task',
          },
          {
            candidateId: 'project-current',
            category: 'project',
            sourceRef: `atl-project://${project.projectId}`,
            version: project.updatedAt,
            expectedSha256: null,
            selection: 'selected',
            selectionReason: 'The owning Project defines durable context.',
            blockLabel: 'project',
          },
        ],
        includeSourceNote: false,
        selectedProjectResourceIndexes: [],
      }),
    };

    const result = await authorizeResearchTask(
      context.ctx,
      dependencies,
      'task-20260901-auth0001',
    );

    expect(ensureIssue).toHaveBeenCalledOnce();
    expect(result.task.status).toBe('agent_executable');
    expect(result.dispatch).toMatchObject({
      status: 'linked',
      issueIdentifier: 'TEP-999',
      runId: 'run-research-auth-1',
    });
    await expect(context.ctx.tasks.get('task-20260901-auth0001')).resolves.toMatchObject({
      status: 'agent_executable',
      executionTarget: 'multica',
      executionLink: {
        dispatchState: 'linked',
        activationAssigneeId: RESEARCH_AGENT_ID,
        activationRunId: 'run-research-auth-1',
      },
    });
  });
});
