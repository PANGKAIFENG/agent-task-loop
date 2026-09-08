import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { developmentAuthorizationGaps } from '../../../src/services/authorize-development-task.js';

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260822-dev00001',
    title: 'One-click Multica dispatch entry',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-agent-task-loop',
    taskType: 'development',
    objective: 'Dispatch a development task from Obsidian',
    acceptanceCriteria: ['Exactly one Multica issue per confirmation'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:dev-gaps-1',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-22T00:00:00.000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('developmentAuthorizationGaps', () => {
  it('returns no gaps for a complete confirmed development task in ready', () => {
    expect(developmentAuthorizationGaps(developmentTask())).toEqual([]);
  });

  it('surfaces every missing dispatch field from the shared admission', () => {
    const gaps = developmentAuthorizationGaps(developmentTask({
      projectId: null,
      objective: null,
      acceptanceCriteria: [],
      permissionProfile: null,
      contextRefs: [],
    }));
    expect(gaps).toContain('projectId is required');
    expect(gaps).toContain('objective is required');
    expect(gaps).toContain('acceptanceCriteria requires at least one item');
    expect(gaps).toContain('permissionProfile must be repo_delivery');
    expect(gaps).toContain('contextRefs requires at least one item');
  });

  it('reports a non-confirmed review state as a gap', () => {
    expect(developmentAuthorizationGaps(developmentTask({
      reviewState: 'ready_for_confirm',
    }))).toEqual(['reviewState must be confirmed']);
  });

  it('fails closed for a task without the multica execution target', () => {
    expect(developmentAuthorizationGaps(developmentTask({
      executionTarget: null,
    }))).toEqual(['executionTarget must be multica']);
  });

  it('reuses contextRefErrors wording for out-of-bounds refs', () => {
    const gaps = developmentAuthorizationGaps(developmentTask({
      contextRefs: ['/Users/linctex/private/notes.md', 'docs/ok.md'],
    }));
    expect(gaps).toEqual([
      'contextRefs entry is outside the allowlist: /Users/linctex/private/notes.md',
    ]);
  });

  it('keeps the post-authorization status substitution invisible to callers', () => {
    // A ready task must not be reported as a status gap: the admission
    // evaluates the post-authorization (agent_executable) shape.
    expect(developmentAuthorizationGaps(developmentTask())).not.toContain(
      'status must be agent_executable',
    );
  });
});
