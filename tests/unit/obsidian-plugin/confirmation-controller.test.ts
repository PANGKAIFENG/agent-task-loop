import { afterEach, describe, expect, it } from 'vitest';

import { captureTask } from '../../../src/services/capture-task.js';
import { createProject } from '../../../src/services/create-project.js';
import {
  ConfirmationController,
} from '../../../src/obsidian-plugin/confirmation-controller.js';
import type { ConfirmationFormInput } from '../../../src/obsidian-plugin/confirmation-form.js';
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

async function captureTaskFixture(
  context: TestServiceContext,
  sourceKey: string,
  title = 'Rebuild the Multica binding from the board',
) {
  return captureTask(context.ctx, {
    title,
    body: 'Synthetic body.',
    origin: 'synthetic_test',
    sourceDate: '2026-08-22',
    sourceNote: '/synthetic/source.md',
    sourceQuote: 'Synthetic quote.',
    sourceKey,
    priority: 'normal',
  });
}

function developmentForm(): ConfirmationFormInput {
  return {
    project: { mode: 'existing', projectId: 'project-agent-task-loop' },
    objective: 'Rebuild the binding.',
    acceptanceCriteria: ['The board restores the TEP identifier.'],
    priority: 'high',
    taskKind: 'development',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    repoDeliveryAcknowledged: true,
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('ConfirmationController development mapping (PAW-GOAL-003-V0.5 D1)', () => {
  it('persists the four development contract fields through confirmTask', async () => {
    const context = await makeContext();
    await createProject(context.ctx, {
      projectId: 'project-agent-task-loop',
      name: 'Agent Task Loop',
      description: 'Synthetic fixture project.',
      resources: [],
    });
    const task = await captureTaskFixture(context, 'synthetic:controller-dev-1');
    const controller = new ConfirmationController(context.ctx);

    const confirmed = await controller.confirm(task.taskId, developmentForm());

    expect(confirmed).toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      projectId: 'project-agent-task-loop',
      taskType: 'development',
      permissionProfile: 'repo_delivery',
      executionTarget: 'multica',
      contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
      autoExecutable: false,
    });
  });

  it('creates a new project before persisting the development declaration', async () => {
    const context = await makeContext();
    const task = await captureTaskFixture(context, 'synthetic:controller-dev-2');
    const controller = new ConfirmationController(context.ctx);

    const confirmed = await controller.confirm(task.taskId, {
      ...developmentForm(),
      project: {
        mode: 'new',
        name: 'Multica Bridge',
        description: 'Everything around the dispatch bridge.',
      },
    });

    expect(confirmed).toMatchObject({
      status: 'ready',
      projectId: 'multica-bridge',
      taskType: 'development',
      executionTarget: 'multica',
    });
    await expect(context.ctx.projects.get('multica-bridge')).resolves.toMatchObject({
      name: 'Multica Bridge',
    });
  });

  it('routes only a complete research declaration to Multica', async () => {
    const context = await makeContext();
    const task = await captureTaskFixture(context, 'synthetic:controller-research-1');
    const controller = new ConfirmationController(context.ctx);

    const lightweight = await controller.confirm(task.taskId, {
      project: { mode: 'none' },
      objective: ' ',
      acceptanceCriteria: [' '],
      priority: 'normal',
      taskKind: 'research',
    });
    expect(lightweight).toMatchObject({
      status: 'ready',
      taskType: null,
      permissionProfile: null,
    });
    expect(lightweight.executionTarget).toBeUndefined();

    const second = await captureTaskFixture(
      context,
      'synthetic:controller-research-2',
      'Compare public product pricing',
    );
    const detailed = await controller.confirm(second.taskId, {
      project: { mode: 'none' },
      objective: 'Compare public pricing.',
      acceptanceCriteria: ['Cite two official sources.'],
      priority: 'high',
      taskKind: 'research',
    });
    expect(detailed).toMatchObject({
      status: 'ready',
      taskType: 'research',
      permissionProfile: 'read_only_research',
    });
    expect(detailed.executionTarget).toBeUndefined();

    await createProject(context.ctx, {
      projectId: 'project-research-artifact-chain',
      name: 'Research Artifact Chain',
      description: 'Synthetic fixture project.',
      resources: [],
    });
    const third = await captureTaskFixture(
      context,
      'synthetic:controller-research-3',
      'Compare public research systems',
    );
    const complete = await controller.confirm(third.taskId, {
      project: { mode: 'existing', projectId: 'project-research-artifact-chain' },
      objective: 'Compare public research systems.',
      acceptanceCriteria: ['Cite two official sources.'],
      priority: 'high',
      taskKind: 'research',
    });
    expect(complete).toMatchObject({
      status: 'ready',
      projectId: 'project-research-artifact-chain',
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
    });
  });

  it('rejects an invalid development form before any write', async () => {
    const context = await makeContext();
    const task = await captureTaskFixture(context, 'synthetic:controller-dev-3');
    const controller = new ConfirmationController(context.ctx);

    await expect(controller.confirm(task.taskId, {
      ...developmentForm(),
      contextRefs: ['/private/absolute.md'],
    })).rejects.toMatchObject({ code: 'invalid_confirmation_form' });

    const unchanged = await context.ctx.tasks.get(task.taskId);
    expect(unchanged.status).toBe('inbox');
  });
});
