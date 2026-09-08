import { describe, expect, it } from 'vitest';

import {
  executionLinkSchema,
  executionLinkIdempotencyKey,
  isExecutionLinkActivationComplete,
  isExecutionLinkBound,
} from '../../../src/domain/execution-link.js';
import {
  contextRefErrors,
  developmentDispatchErrors,
  isDecisionContinuationPending,
  isExternalExecutionTask,
  readinessErrors,
  taskSchema,
  type Task,
} from '../../../src/domain/task.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  schemaVersion: 1,
  taskId: 'task-20260820-abc00001',
  title: 'Ship the dispatch slice',
  body: '',
  status: 'agent_executable',
  reviewState: 'confirmed',
  projectId: PROJECT_ID,
  taskType: 'development',
  objective: 'Deliver the unique Multica dispatch',
  acceptanceCriteria: ['Only one remote issue per task'],
  autoExecutable: true,
  permissionProfile: 'repo_delivery',
  executionTarget: 'multica',
  contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
  origin: 'test',
  sourceDate: null,
  sourceNote: null,
  sourceQuote: null,
  sourceKey: 'test:task-1',
  possibleDuplicateIds: [],
  priority: 'normal',
  attempts: 0,
  claim: null,
  artifactRefs: [],
  reviewFeedback: null,
  readyAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

describe('developmentDispatchErrors', () => {
  it('fails closed with a field-level reason for every gap', () => {
    const incomplete = makeTask({
      status: 'ready',
      projectId: null,
      taskType: null,
      objective: null,
      acceptanceCriteria: [],
      permissionProfile: null,
      executionTarget: null,
      contextRefs: [],
    });

    expect(developmentDispatchErrors(incomplete)).toEqual([
      'status must be agent_executable',
      'taskType must be development',
      'projectId is required',
      'objective is required',
      'acceptanceCriteria requires at least one item',
      'permissionProfile must be repo_delivery',
      'executionTarget must be multica',
      'contextRefs requires at least one item',
    ]);
  });

  it('accepts a complete authorized development task', () => {
    expect(developmentDispatchErrors(makeTask())).toEqual([]);
  });

  it('rejects traversal and unlisted absolute context refs', () => {
    const task = makeTask({
      contextRefs: ['docs/ok.md', '../secrets/key', '/Users/elsewhere/notes.md'],
    });

    expect(developmentDispatchErrors(task)).toEqual([
      'contextRefs entry must not contain traversal segments: ../secrets/key',
      'contextRefs entry is outside the allowlist: /Users/elsewhere/notes.md',
    ]);
  });

  it('allows absolute context refs inside the explicit allowlist', () => {
    const refs = ['/Users/linctex/Desktop/vibe/personal-ai-workbench/docs/ok.md'];
    expect(contextRefErrors(refs, ['/Users/linctex/Desktop/vibe/personal-ai-workbench'])).toEqual([]);
  });
});

describe('contextRefErrors', () => {
  it('rejects control characters and over-long entries', () => {
    expect(contextRefErrors(['docs/bad.md\u0007'])).toEqual([
      'contextRefs entries must not contain control characters',
    ]);
    expect(contextRefErrors([`docs/${'a'.repeat(301)}.md`])).toEqual([
      'contextRefs entries must be at most 300 characters',
    ]);
  });

  it('rejects empty entries but accepts clean relative refs', () => {
    expect(contextRefErrors(['docs/ok.md', '   '])).toEqual([
      'contextRefs must not contain empty entries',
    ]);
    expect(contextRefErrors(['docs/a.md', 'docs/b/c.md'])).toEqual([]);
  });

  it('CR fix 2: absolute refs are contained by canonical path semantics, not string prefixes', () => {
    const root = '/Users/linctex/Desktop/vibe/personal-ai-workbench';
    expect(contextRefErrors([`${root}/docs/ok.md`], [root])).toEqual([]);
    // A trailing-slash root still contains its children.
    expect(contextRefErrors([`${root}/docs/ok.md`], [`${root}/`])).toEqual([]);
    // A `..` segment that lands back inside the root stays valid.
    expect(contextRefErrors([`${root}/docs/../docs/ok.md`], [root])).toEqual([]);
    // A `..` segment that escapes the root is rejected.
    expect(contextRefErrors([`${root}/../secrets/key.md`], [root])).toEqual([
      `contextRefs entry is outside the allowlist: ${root}/../secrets/key.md`,
    ]);
    // The root itself is not a dispatchable context ref.
    expect(contextRefErrors([root], [root])).toEqual([
      `contextRefs entry is outside the allowlist: ${root}`,
    ]);
    // Prefix-adjacent sibling directories must not be admitted.
    const sibling = '/Users/linctex/Desktop/vibe/personal-ai-workbench-evil/ok.md';
    expect(contextRefErrors([sibling], [root])).toEqual([
      `contextRefs entry is outside the allowlist: ${sibling}`,
    ]);
  });
});

describe('taskSchema', () => {
  it('accepts a development task with the execution extension', () => {
    const task = makeTask({
      executionLink: {
        schemaVersion: 1,
        provider: 'multica',
        idempotencyKey: executionLinkIdempotencyKey('task-20260820-abc00001'),
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-42',
        activationAssigneeId: 'acc15624-c025-4fa8-bc61-e74a1a7725c9',
        activationRunId: 'run-initial',
        dispatchState: 'linked',
        remoteState: 'active',
        lastCommentId: null,
        lastEventId: null,
        summary: null,
        artifactRefs: [],
        lastAttemptAt: '2026-08-20T00:00:00.000Z',
        lastSyncedAt: '2026-08-20T00:01:00.000Z',
      },
    });

    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(isExternalExecutionTask(task)).toBe(true);
    expect(isExecutionLinkBound(task.executionLink)).toBe(true);
    expect(isExecutionLinkActivationComplete(task.executionLink)).toBe(true);
  });

  it('keeps legacy research tasks parseable without the new fields', () => {
    const legacy = makeTask({
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionTarget: undefined,
      contextRefs: undefined,
      executionLink: undefined,
    });
    delete (legacy as Partial<Task>).executionTarget;
    delete (legacy as Partial<Task>).contextRefs;
    delete (legacy as Partial<Task>).executionLink;

    const parsed = taskSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(readinessErrors(legacy)).toEqual([]);
    expect(isExternalExecutionTask(legacy)).toBe(false);
  });

  it('excludes external execution tasks from decision continuation', () => {
    const task = makeTask({
      lastDecision: {
        schemaVersion: 1,
        requestId: 'decision-1',
        selectedOptionId: 'retry',
        selectedOptionLabel: 'Retry',
        responseText: null,
        responseEventId: 'event-1',
        respondedAt: '2026-08-20T00:00:00.000Z',
        continuationRunId: null,
        continuationOfRunId: 'run-1',
      },
    });
    // A research twin would be continuation-pending; the Multica task is not.
    expect(isDecisionContinuationPending(task)).toBe(false);
  });
});

describe('executionLinkSchema', () => {
  const baseLink = {
    schemaVersion: 1,
    provider: 'multica',
    idempotencyKey: 'atl:task-20260820-abc00001',
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    issueId: null,
    issueIdentifier: null,
    dispatchState: 'pending',
    remoteState: null,
    lastCommentId: null,
    lastEventId: null,
    summary: null,
    artifactRefs: [],
    lastAttemptAt: '2026-08-20T00:00:00.000Z',
    lastSyncedAt: null,
  };

  it('accepts a pending ledger entry', () => {
    expect(executionLinkSchema.safeParse(baseLink).success).toBe(true);
    expect(isExecutionLinkBound(executionLinkSchema.parse(baseLink))).toBe(false);
  });

  it('keeps a legacy issue-bound link loadable but not activation-complete', () => {
    const legacyBound = executionLinkSchema.parse({
      ...baseLink,
      issueId: '01234567-89ab-4cde-8f01-234567890abc',
      issueIdentifier: 'TEP-42',
      dispatchState: 'linked',
      remoteState: 'active',
    });

    expect(isExecutionLinkBound(legacyBound)).toBe(true);
    expect(isExecutionLinkActivationComplete(legacyBound)).toBe(false);
  });

  it('rejects unknown dispatch states, bad UUIDs, and unsafe keys', () => {
    expect(executionLinkSchema.safeParse({
      ...baseLink,
      dispatchState: 'probably_fine',
    }).success).toBe(false);
    expect(executionLinkSchema.safeParse({
      ...baseLink,
      workspaceId: 'not-a-uuid',
    }).success).toBe(false);
    expect(executionLinkSchema.safeParse({
      ...baseLink,
      idempotencyKey: 'rm -rf /',
    }).success).toBe(false);
  });

  it('accepts projected LF summaries and rejects unsafe controls', () => {
    const summary = [
      'Live verification is ready for a decision.',
      'The task has one Multica binding.',
      'The candidate SHA was read back.',
    ].join('\n');
    expect(executionLinkSchema.safeParse({ ...baseLink, summary }).success).toBe(true);

    for (const unsafeSummary of [
      'one\rtwo',
      'one\ttwo',
      'one\u0085two',
      'one\u2028two',
      'one\u202Etwo',
    ]) {
      expect(executionLinkSchema.safeParse({
        ...baseLink,
        summary: unsafeSummary,
      }).success).toBe(false);
    }
  });
});
