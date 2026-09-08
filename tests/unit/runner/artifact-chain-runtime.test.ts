import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { createArtifactChainContextPlanner } from '../../../src/runner/artifact-chain-runtime.js';
import type { ResearchDriver } from '../../../src/runner/research-driver.js';
import { createRunnerController } from '../../../src/runner/runner-controller.js';
import type { ServiceContext } from '../../../src/services/service-context.js';

const NOW = '2026-09-01T00:00:00.000Z';

const project: Project = {
  projectId: 'project-production-composition',
  name: 'Synthetic Production Composition',
  description: 'A persisted ATL Project used as the Phase 0 local projection.',
  resources: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const task = {
  schemaVersion: 1,
  taskId: 'task-production-composition',
  title: 'Exercise the production runner composition',
  body: '',
  status: 'in_progress',
  reviewState: 'confirmed',
  projectId: project.projectId,
  taskType: 'research',
  objective: 'Prove that production composition freezes Artifact Chain evidence.',
  acceptanceCriteria: ['Freeze a Context Manifest before driver execution.'],
  autoExecutable: true,
  permissionProfile: 'read_only_research',
  origin: 'synthetic',
  sourceDate: null,
  sourceNote: null,
  sourceQuote: null,
  sourceKey: 'synthetic:production-composition',
  possibleDuplicateIds: [],
  priority: 'normal',
  attempts: 1,
  claim: {
    runId: 'run-production-composition',
    agent: 'synthetic',
    claimedAt: NOW,
    leaseExpiresAt: '2026-09-01T01:00:00.000Z',
  },
  artifactRefs: [],
  reviewFeedback: null,
  readyAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
} satisfies Task;

describe('production Artifact Chain runtime composition', () => {
  it('exposes a shared planner that covers every block in the local ATL projection', async () => {
    const plan = await createArtifactChainContextPlanner()({ task, project });

    expect(plan.additionalLocalContexts).toEqual([]);
    expect(plan.projectContext).toMatchObject({
      requestedProjectId: project.projectId,
      registry: [expect.objectContaining({
        projectId: project.projectId,
        verification: 'verified',
      })],
      canonicalProjects: [expect.objectContaining({ projectId: project.projectId })],
      atlProjects: [expect.objectContaining({ project })],
    });
    expect(plan.candidates).toEqual([
      expect.objectContaining({ blockLabel: 'task', category: 'task' }),
      expect.objectContaining({ blockLabel: 'project', category: 'project' }),
    ]);
  });

  it('requires the shared planner when constructing a production Runner', () => {
    const ctx = {} as ServiceContext;
    const driver = { name: 'synthetic', execute: vi.fn() } as ResearchDriver;

    expect(() => createRunnerController({
      ctx,
      driver,
      runtimeRoot: '/synthetic/.atl-runtime',
      allowedLocalRoots: [],
      leaseMinutes: 60,
      timeoutMs: 60_000,
      agent: driver.name,
      runId: () => 'run-production-composition',
    }, { production: true })).toThrowError(/Artifact Chain context planner/u);
    expect(() => createRunnerController({
      ctx,
      driver,
      runtimeRoot: '/synthetic/.atl-runtime',
      allowedLocalRoots: [],
      leaseMinutes: 60,
      timeoutMs: 60_000,
      agent: driver.name,
      runId: () => 'run-production-composition',
      artifactChainContextPlanner: createArtifactChainContextPlanner(),
    }, { production: true })).not.toThrow();
  });
});
