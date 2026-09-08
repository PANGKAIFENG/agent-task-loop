import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { createProject } from '../../../src/services/create-project.js';
import { createResearchTaskDispatcher } from '../../../src/obsidian-plugin/research-dispatcher.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('Obsidian Research dispatcher', () => {
  it('authorizes through the shared production composition and attempts dispatch immediately', async () => {
    const context = await createTestServiceContext();
    contexts.push(context);
    await createProject(context.ctx, {
      projectId: 'project-obsidian-research-dispatch',
      name: 'Obsidian Research Dispatch',
      description: 'Synthetic project only.',
      resources: [],
    });
    const captured = await captureTask(context.ctx, {
      title: 'Dispatch one Obsidian Research task',
      body: 'Synthetic task only.',
      origin: 'synthetic_test',
      sourceDate: '2026-09-01',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:obsidian-research-dispatch',
      priority: 'normal',
    });
    await context.ctx.tasks.save({
      ...captured,
      status: 'ready',
      reviewState: 'confirmed',
      projectId: 'project-obsidian-research-dispatch',
      taskType: 'research',
      objective: 'Produce a decision-ready comparison.',
      acceptanceCriteria: ['Bind the result to cited evidence.'],
      permissionProfile: 'read_only_research',
      executionTarget: 'multica',
      readyAt: '2026-09-01T00:00:00.000Z',
    });
    const config = loadConfig({
      ATL_VAULT_ROOT: context.root,
      ATL_MULTICA_BINARY: '/usr/bin/false',
    });

    const dispatch = createResearchTaskDispatcher(
      context.ctx,
      config,
      [],
    );
    const result = await dispatch(captured.taskId);

    expect(result).toMatchObject({
      task: { status: 'agent_executable', executionTarget: 'multica' },
      dispatch: { status: 'remote_write_unknown', taskId: captured.taskId },
    });
    expect(config.vaultRoot).toBe(context.root);
    expect(join(config.vaultRoot, '.atl-runtime')).toContain(context.root);
  });
});
