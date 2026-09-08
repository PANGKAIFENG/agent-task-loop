import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvalidTaskDataError, MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';
import type { Task } from '../../../src/domain/task.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260820-abc00001',
    title: 'Ship the dispatch slice',
    body: '',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: PROJECT_ID,
    taskType: 'development',
    objective: 'Deliver the unique Multica dispatch',
    acceptanceCriteria: ['Exactly one remote issue per authorized task'],
    autoExecutable: true,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md'],
    executionLink: {
      schemaVersion: 1,
      provider: 'multica',
      idempotencyKey: 'atl:task-20260820-abc00001',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
      activationAssigneeId: 'acc15624-c025-4fa8-bc61-e74a1a7725c9',
      activationRunId: 'run-initial',
      contextManifestId: 'cm_0123456789abcdef01234567',
      contextManifestSha256: 'a'.repeat(64),
      executionBindingReceiptId: 'ebr_0123456789abcdef01234567',
      activationAgentModel: 'gpt-5.6-sol',
      activationAgentMaxConcurrentTasks: 10,
      activationAgentRuntimeId: 'runtime-research',
      activationRunStatus: 'in_progress',
      activationRunRuntimeId: 'runtime-research',
      dispatchState: 'linked',
      remoteState: 'active',
      lastCommentId: null,
      lastEventId: null,
      summary: null,
      artifactRefs: [],
      lastAttemptAt: '2026-08-20T12:00:00.000Z',
      lastSyncedAt: '2026-08-20T12:01:00.000Z',
    },
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:roundtrip-dev',
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

describe('execution link frontmatter round-trip', () => {
  let root: string;
  let repository: MarkdownTaskRepository;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'atl-execution-link-'));
    repository = new MarkdownTaskRepository(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists the TECH §2 snake_case contract and reloads it unchanged', async () => {
    await repository.createIfSourceKeyAbsent(developmentTask());

    const loaded = await repository.get('task-20260820-abc00001');
    expect(loaded.taskType).toBe('development');
    expect(loaded.permissionProfile).toBe('repo_delivery');
    expect(loaded.executionTarget).toBe('multica');
    expect(loaded.contextRefs).toEqual([
      'docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md',
    ]);
    expect(loaded.executionLink).toEqual(developmentTask().executionLink);

    const files = await import('node:fs/promises').then(({ readdir }) =>
      readdir(join(root, '10_Tasks'), { recursive: true }));
    const taskFile = files.find((file) => String(file).endsWith('task-20260820-abc00001.md'));
    expect(taskFile).toBeDefined();
    const raw = await readFile(join(root, '10_Tasks', String(taskFile)), 'utf8');
    expect(raw).toContain('execution_link:');
    expect(raw).toContain('idempotency_key: atl:task-20260820-abc00001');
    expect(raw).toContain('dispatch_state: linked');
    expect(raw).toContain('issue_identifier: TEP-42');
    expect(raw).toContain('activation_assignee_id: acc15624-c025-4fa8-bc61-e74a1a7725c9');
    expect(raw).toContain('activation_run_id: run-initial');
    expect(raw).toContain('context_manifest_id: cm_0123456789abcdef01234567');
    expect(raw).toContain('execution_binding_receipt_id: ebr_0123456789abcdef01234567');
    expect(raw).toContain('activation_agent_model: gpt-5.6-sol');
    expect(raw).toContain('execution_target: multica');
    expect(raw).toContain('task_type: development');
  });

  it('keeps legacy research frontmatter loadable without the new fields', async () => {
    const legacy = developmentTask({
      taskId: 'task-20260820-legacy01',
      taskType: 'research',
      permissionProfile: 'read_only_research',
      executionTarget: null,
      contextRefs: [],
      executionLink: null,
      sourceKey: 'test:roundtrip-legacy',
    });
    await repository.createIfSourceKeyAbsent(legacy);

    const loaded = await repository.get('task-20260820-legacy01');
    expect(loaded.taskType).toBe('research');
    expect(loaded.executionTarget ?? null).toBeNull();
    expect(loaded.executionLink ?? null).toBeNull();
  });

  it('fails closed on a corrupted dispatch ledger instead of dropping it', async () => {
    const corrupted = developmentTask({
      taskId: 'task-20260820-bad00001',
      sourceKey: 'test:roundtrip-bad',
    });
    await repository.createIfSourceKeyAbsent(corrupted);
    const targetPath = join(
      root,
      '10_Tasks',
      'Active',
      PROJECT_ID,
      'task-20260820-bad00001.md',
    );
    const raw = await readFile(targetPath, 'utf8');
    await writeFile(
      targetPath,
      raw.replace('dispatch_state: linked', 'dispatch_state: maybe_broken'),
    );
    // New repository instance so the cached records do not mask the disk state.
    await expect(new MarkdownTaskRepository(root).get('task-20260820-bad00001'))
      .rejects.toThrowError(InvalidTaskDataError);
  });
});
