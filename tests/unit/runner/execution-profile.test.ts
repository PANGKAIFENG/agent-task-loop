import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import type { ContextBundle } from '../../../src/runner/context-bundle.js';
import {
  resolveExecutionProfile,
  validateExecutionProfileContext,
} from '../../../src/runner/execution-profile.js';

const NOW = '2026-07-15T00:00:00.000Z';

function claimedResearchTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-profile-001',
    title: 'Compare public product limits',
    body: '',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-profile',
    taskType: 'research',
    objective: 'Compare public product limits.',
    acceptanceCriteria: ['Cite one official HTTPS source.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_profile_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:profile-001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-profile-001',
      agent: 'test-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-15T01:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function context(kinds: ContextBundle['blocks'][number]['kind'][]): ContextBundle {
  return {
    taskId: 'task-profile-001',
    blocks: kinds.map((kind, index) => ({
      label: `${kind}-${index}`,
      kind,
      content: `${kind} content`,
      sha256: String(index).padStart(64, '0'),
    })),
  };
}

describe('resolveExecutionProfile', () => {
  it('selects the versioned research capability package deterministically', () => {
    const profile = resolveExecutionProfile(claimedResearchTask());

    expect(profile).toMatchObject({
      schemaVersion: 1,
      profileId: 'research_v1',
      profileVersion: 1,
      selectionStrategy: 'deterministic_v1',
      role: {
        id: 'bounded_public_researcher',
        selectionReason: expect.stringContaining('research'),
      },
      permissionProfile: 'read_only_research',
      allowedTools: ['WebSearch', 'WebFetch', 'Read'],
      requiredContextKinds: ['task', 'project'],
      outputContract: 'research_result_v1',
      acceptancePolicy: {
        taskCriteriaRequired: true,
        httpsEvidenceRequired: true,
        humanReviewRequired: true,
      },
    });
    expect(profile.skills.map(({ id }) => id)).toEqual([
      'decision-research',
      'evidence-collection',
    ]);
    expect(profile.skills.every(({ instructions }) => instructions.length > 0)).toBe(true);
  });

  it.each([
    ['task type', { taskType: null }],
    ['permission profile', { permissionProfile: null }],
    ['execution authorization', { autoExecutable: false }],
    ['claim identity', { claim: null }],
  ] satisfies [string, Partial<Task>][])('fails closed for an unsupported %s', (_label, overrides) => {
    expect(() => resolveExecutionProfile(claimedResearchTask(overrides)))
      .toThrow(expect.objectContaining({ code: 'execution_profile_not_supported' }));
  });
});

describe('validateExecutionProfileContext', () => {
  it('accepts the task and project context required by research_v1', () => {
    const profile = resolveExecutionProfile(claimedResearchTask());

    expect(() => validateExecutionProfileContext(
      profile,
      context(['task', 'project', 'url_reference']),
    )).not.toThrow();
  });

  it('rejects a context bundle missing a required context kind', () => {
    const profile = resolveExecutionProfile(claimedResearchTask());

    expect(() => validateExecutionProfileContext(profile, context(['task'])))
      .toThrow(expect.objectContaining({ code: 'execution_profile_context_missing' }));
  });
});
