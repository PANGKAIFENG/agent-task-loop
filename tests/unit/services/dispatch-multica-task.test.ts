import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MulticaDispatchConnector } from '../../../src/connectors/multica-cli-connector.js';
import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { dispatchMulticaTask } from '../../../src/services/dispatch-multica-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T07:00:00.000Z';
const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const MULTICA_PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const RESEARCH_AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const contexts: TestServiceContext[] = [];

const project: Project = {
  projectId: 'project-dispatch-router',
  name: 'Dispatch Router',
  description: 'Synthetic project only.',
  resources: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const researchTask: Task = {
  schemaVersion: 1,
  taskId: 'task-20260901-router01',
  title: 'Route this Research task',
  body: '',
  status: 'agent_executable',
  reviewState: 'confirmed',
  projectId: project.projectId,
  taskType: 'research',
  objective: 'Use the Research Agent path.',
  acceptanceCriteria: ['Start one bound run.'],
  autoExecutable: true,
  permissionProfile: 'read_only_research',
  executionTarget: 'multica',
  origin: 'synthetic_test',
  sourceDate: null,
  sourceNote: null,
  sourceQuote: null,
  sourceKey: 'synthetic:dispatch-router',
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

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('dispatchMulticaTask', () => {
  it('routes a Research task to the Agent connector and never the Squad connector', async () => {
    const context = await createTestServiceContext({ now: new Date(NOW) });
    contexts.push(context);
    await context.ctx.projects.create(project);
    await context.ctx.tasks.createIfSourceKeyAbsent(researchTask);
    const researchEnsure = vi.fn<MulticaDispatchConnector['ensureIssue']>(async () => ({
      status: 'linked',
      ref: {
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-998',
      },
      recovered: false,
      activation: {
        assigneeId: RESEARCH_AGENT_ID,
        runId: 'run-router-1',
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
    const developmentEnsure = vi.fn<MulticaDispatchConnector['ensureIssue']>();

    const outcome = await dispatchMulticaTask(context.ctx, {
      development: {
        connector: {
          ensureIssue: developmentEnsure,
          inspect: async () => { throw new Error('not called'); },
        },
        target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
      },
      research: {
        connector: {
          ensureIssue: researchEnsure,
          inspect: async () => { throw new Error('not called'); },
        },
        target: { workspaceId: WORKSPACE_ID, projectId: MULTICA_PROJECT_ID },
        runtimeRoot: join(context.root, '.atl-runtime'),
        allowedContextRoots: [context.root],
        contextBaseRoot: context.root,
        discoverContext: async ({ task, project }) => ({
          additionalLocalContexts: [],
          includeSourceNote: false,
          selectedProjectResourceIndexes: [],
          candidates: [
            {
              candidateId: 'task-current',
              category: 'task',
              sourceRef: `task://${task.taskId}`,
              version: task.updatedAt,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'The Task is required.',
              blockLabel: 'task',
            },
            {
              candidateId: 'project-current',
              category: 'project',
              sourceRef: `atl-project://${project.projectId}`,
              version: project.updatedAt,
              expectedSha256: null,
              selection: 'selected',
              selectionReason: 'The Project is required.',
              blockLabel: 'project',
            },
          ],
        }),
      },
    }, researchTask.taskId);

    expect(outcome).toMatchObject({ status: 'linked', runId: 'run-router-1' });
    expect(researchEnsure).toHaveBeenCalledOnce();
    expect(developmentEnsure).not.toHaveBeenCalled();
  });
});
