import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import type { DispatchOutcome } from '../../../src/services/dispatch-development-task.js';
import {
  DISPATCH_EXPECTATION_MINUTES,
  executionLinkEntryView,
  outcomeView,
} from '../../../src/obsidian-plugin/dispatch-outcome-view.js';

const TASK_ID = 'task-20260822-dev00001';

function outcome(status: DispatchOutcome['status'], extra: Record<string, unknown> = {}): DispatchOutcome {
  return { status, taskId: TASK_ID, ...extra } as DispatchOutcome;
}

function developmentTask(executionLink: Record<string, unknown> | null): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'One-click Multica dispatch entry',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: 'project-agent-task-loop',
    taskType: 'development',
    objective: 'Dispatch a development task from Obsidian',
    acceptanceCriteria: ['Exactly one Multica issue per confirmation'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    executionLink: executionLink === null ? undefined : {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: `atl:${TASK_ID}`,
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
      issueId: null,
      issueIdentifier: null,
      dispatchState: 'not_requested',
      remoteState: null,
      lastCommentId: null,
      lastEventId: null,
      summary: null,
      artifactRefs: [],
      lastAttemptAt: null,
      lastSyncedAt: null,
      ...executionLink,
    } as Task['executionLink'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:outcome-view-1',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('outcomeView (PAW-GOAL-003-V0.5 D2)', () => {
  it('maps linked and already_linked to the success projection with TEP-xx', () => {
    expect(outcomeView(outcome('linked', {
      issueId: 'issue-1', issueIdentifier: 'TEP-152', recovered: false,
    }), '2026-08-22T15:40:00.000Z')).toEqual({
      status: 'linked',
      issueId: 'issue-1',
      issueIdentifier: 'TEP-152',
      dispatchedAt: '2026-08-22T15:40:00.000Z',
      recovered: false,
    });
    expect(outcomeView(outcome('already_linked', {
      issueId: 'issue-1', issueIdentifier: 'TEP-152',
    }))).toMatchObject({ status: 'linked', issueIdentifier: 'TEP-152', recovered: true });
  });

  it('maps in_flight and remote_write_unknown to reconciling — never to success', () => {
    expect(outcomeView(outcome('in_flight', { reason: 'lease held' })))
      .toEqual({ status: 'reconciling', reason: 'lease held' });
    expect(outcomeView(outcome('remote_write_unknown', { reason: 'write-back failed' })))
      .toEqual({ status: 'reconciling', reason: 'write-back failed' });
  });

  it('maps duplicate_conflict to the conflict projection with candidates', () => {
    expect(outcomeView(outcome('duplicate_conflict', {
      candidateIssueIds: ['TEP-151', 'TEP-149'],
    }))).toEqual({
      status: 'conflict',
      candidateIssueIds: ['TEP-151', 'TEP-149'],
    });
  });

  it('maps failed to the failure projection carrying the real reason', () => {
    expect(outcomeView(outcome('failed', { reason: 'multica_unreachable' })))
      .toEqual({ status: 'failed', reason: 'multica_unreachable' });
  });

  it('derives the wait expectation from the shared lease constant', () => {
    expect(DISPATCH_EXPECTATION_MINUTES).toBe(2);
  });
});

describe('executionLinkEntryView (补投 read-back)', () => {
  it('offers the contract when no dispatch has been requested', () => {
    expect(executionLinkEntryView(developmentTask(null)).kind).toBe('contract');
    expect(executionLinkEntryView(developmentTask({})).kind).toBe('contract');
    expect(executionLinkEntryView(developmentTask({ dispatchState: 'failed' })).kind)
      .toBe('contract');
    expect(executionLinkEntryView(developmentTask({ dispatchState: 'not_requested' })).kind)
      .toBe('contract');
  });

  it('projects reconciling for every unresolved remote state', () => {
    for (const dispatchState of ['pending', 'resolving_remote', 'remote_write_unknown']) {
      const view = executionLinkEntryView(developmentTask({ dispatchState }));
      expect(view).toMatchObject({ kind: 'result', result: { status: 'reconciling' } });
    }
  });

  it('projects the conflict state without offering re-dispatch', () => {
    expect(executionLinkEntryView(developmentTask({ dispatchState: 'duplicate_conflict' })))
      .toEqual({ kind: 'result', result: { status: 'conflict', candidateIssueIds: [] } });
  });

  it('projects the bound TEP identifier once activation is complete', () => {
    const view = executionLinkEntryView(developmentTask({
      dispatchState: 'linked',
      issueId: '01234567-89ab-4cde-8f01-234567890abc',
      issueIdentifier: 'TEP-152',
      lastSyncedAt: '2026-08-22T15:40:00.000Z',
      activationAssigneeId: 'acc15624-c025-4fa8-bc61-e74a1a7725c9',
      activationRunId: 'run-1',
    }));
    expect(view).toEqual({
      kind: 'result',
      result: {
        status: 'linked',
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-152',
        dispatchedAt: '2026-08-22T15:40:00.000Z',
        recovered: true,
      },
    });
  });
});
