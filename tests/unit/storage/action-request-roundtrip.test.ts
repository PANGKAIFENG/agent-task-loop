import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InvalidTaskDataError,
  MarkdownTaskRepository,
} from '../../../src/storage/markdown-task-repository.js';
import type { ActionRequest } from '../../../src/domain/action-request.js';
import type { Task } from '../../../src/domain/task.js';

const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';

function pendingActionRequest(): ActionRequest {
  return {
    schemaVersion: 1,
    actionId: 'action:task-20260820-abc00001:evt-20260820-0001',
    eventId: 'evt-20260820-0001',
    type: 'needs_decision',
    status: 'pending',
    title: '选择恢复策略',
    summary: '选择 synthetic canary 的恢复策略',
    allowedActions: ['select:retry_with_fixture', 'block', 'cancel'],
    multicaIssue: 'TEP-42',
    githubPr: null,
    headSha: null,
    notificationId: 'ding-msg-0001',
    handledStreamEventId: null,
    handledTerminalStep: null,
  };
}

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260820-abc00001',
    title: 'Ship the action roundtrip',
    body: '',
    status: 'waiting_for_decision',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Deliver the human action roundtrip',
    acceptanceCriteria: ['One trusted reply reaches the original task exactly once'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    executionLink: {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: 'atl:task-20260820-abc00001',
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      dispatchState: 'linked',
      remoteState: 'needs_decision',
      lastCommentId: 'comment-1',
      lastEventId: 'evt-20260820-0001',
      summary: '选择 synthetic canary 的恢复策略',
      artifactRefs: [],
      lastAttemptAt: '2026-08-20T12:00:00.000Z',
      lastSyncedAt: '2026-08-20T12:01:00.000Z',
    },
    actionRequest: pendingActionRequest(),
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:roundtrip-action',
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

describe('action_request frontmatter round-trip', () => {
  let root: string;
  let repository: MarkdownTaskRepository;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'atl-action-request-'));
    repository = new MarkdownTaskRepository(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists the TECH §2 snake_case projection and reloads it unchanged', async () => {
    await repository.createIfSourceKeyAbsent(developmentTask());

    const loaded = await repository.get('task-20260820-abc00001');
    expect(loaded.actionRequest).toEqual(pendingActionRequest());

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(root, '10_Tasks'), { recursive: true });
    const taskFile = files.find((file) => String(file).endsWith('task-20260820-abc00001.md'));
    expect(taskFile).toBeDefined();
    const raw = await readFile(join(root, '10_Tasks', String(taskFile)), 'utf8');
    expect(raw).toContain('action_request:');
    expect(raw).toContain('action_id: action:task-20260820-abc00001:evt-20260820-0001');
    expect(raw).toContain('multica_issue: TEP-42');
    expect(raw).toContain('notification_id: ding-msg-0001');
  });

  it('clears action_request when the task no longer carries one', async () => {
    const task = developmentTask({ actionRequest: pendingActionRequest() });
    await repository.createIfSourceKeyAbsent(task);
    await repository.save({ ...(await repository.get(task.taskId)), actionRequest: null });

    const loaded = await repository.get(task.taskId);
    expect(loaded.actionRequest ?? null).toBeNull();
  });

  it('keeps legacy tasks loadable without action_request', async () => {
    const legacy = developmentTask({
      taskId: 'task-20260820-legacy02',
      actionRequest: null,
      status: 'agent_executable',
      sourceKey: 'test:roundtrip-action-legacy',
    });
    await repository.createIfSourceKeyAbsent(legacy);
    const loaded = await repository.get('task-20260820-legacy02');
    expect(loaded.actionRequest ?? null).toBeNull();
  });

  it('fails closed on a corrupted action_request instead of dropping it', async () => {
    const corrupted = developmentTask({
      taskId: 'task-20260820-bad00002',
      sourceKey: 'test:roundtrip-action-bad',
    });
    await repository.createIfSourceKeyAbsent(corrupted);
    const targetPath = join(
      root,
      '10_Tasks',
      'Active',
      PROJECT_ID,
      'task-20260820-bad00002.md',
    );
    const raw = await readFile(targetPath, 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      targetPath,
      raw.replace(
        'action_id: action:task-20260820-abc00001:evt-20260820-0001',
        'action_id: not the contracted shape',
      ),
    );
    // New repository instance so the cached records do not mask the disk state.
    await expect(new MarkdownTaskRepository(root).get('task-20260820-bad00002'))
      .rejects.toThrowError(InvalidTaskDataError);
  });

  // TEP-50 fix 1: the retained handled history round-trips under
  // handled_action_requests with the same snake_case contract. Own root: the
  // corruption test above leaves an unparsable file behind in the shared one,
  // and createIfSourceKeyAbsent scans the whole vault.
  it('persists the retained handled history and reloads it unchanged', async () => {
    const retainedRoot = await mkdtemp(join(tmpdir(), 'atl-action-request-retained-'));
    try {
      const retainedRepository = new MarkdownTaskRepository(retainedRoot);
      const retained: ActionRequest = {
        ...pendingActionRequest(),
        status: 'handled',
        handledStreamEventId: 'stream-evt-retained-1',
        handledTerminalStep: 'supervisor_resumed',
      };
      const task = developmentTask({
        taskId: 'task-20260820-retain01',
        sourceKey: 'test:roundtrip-action-retained',
        handledActionRequests: [retained],
      });
      await retainedRepository.createIfSourceKeyAbsent(task);

      const loaded = await retainedRepository.get(task.taskId);
      expect(loaded.handledActionRequests).toEqual([retained]);

      const raw = await readFile(
        join(retainedRoot, '10_Tasks', 'Active', PROJECT_ID, `${task.taskId}.md`),
        'utf8',
      );
      expect(raw).toContain('handled_action_requests:');
      expect(raw).toContain('handled_stream_event_id: stream-evt-retained-1');
      expect(raw).toContain('handled_terminal_step: supervisor_resumed');

      // Clearing the history removes the key; a task file without it (legacy
      // shape) loads with an empty history.
      await retainedRepository.save({
        ...(await retainedRepository.get(task.taskId)),
        handledActionRequests: [],
      });
      const cleared = await retainedRepository.get(task.taskId);
      expect(cleared.handledActionRequests ?? []).toEqual([]);
      const clearedRaw = await readFile(
        join(retainedRoot, '10_Tasks', 'Active', PROJECT_ID, `${task.taskId}.md`),
        'utf8',
      );
      expect(clearedRaw).not.toContain('handled_action_requests:');

      await retainedRepository.createIfSourceKeyAbsent(developmentTask({
        sourceKey: 'test:roundtrip-action-retained-legacy',
      }));
      const legacy = await retainedRepository.get('task-20260820-abc00001');
      expect(legacy.handledActionRequests ?? []).toEqual([]);
    } finally {
      await rm(retainedRoot, { recursive: true, force: true });
    }
  });
});
