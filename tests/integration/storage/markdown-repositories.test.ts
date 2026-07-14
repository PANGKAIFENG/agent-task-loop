import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { FileAuditLog } from '../../../src/storage/audit-log.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../../../src/storage/frontmatter.js';
import {
  MarkdownProjectRepository,
} from '../../../src/storage/markdown-project-repository.js';
import {
  MarkdownTaskRepository,
  TaskSavedIndexStaleError,
} from '../../../src/storage/markdown-task-repository.js';

const fixtureVault = fileURLToPath(
  new URL('../../fixtures/vault', import.meta.url),
);
const fixtureRelativePath = join(
  '10_Tasks',
  'Inbox',
  '2026-07-13',
  'task-sample.md',
);

const temporaryRoots: string[] = [];

async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-storage-'));
  temporaryRoots.push(root);
  await cp(fixtureVault, root, { recursive: true });
  return root;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    projectId: 'project-public-research',
    name: 'Public research',
    description: 'Synthetic project fixture',
    resources: [
      {
        kind: 'url',
        value: 'https://example.com/public',
        label: 'Public example',
      },
    ],
    createdAt: '2026-07-14T08:00:00+08:00',
    updatedAt: '2026-07-14T08:00:00+08:00',
    ...overrides,
  };
}

afterEach(async () => {
  delete process.env.ATL_VAULT_ROOT;
  delete process.env.ATL_ALLOW_REAL_WRITES;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('frontmatter compatibility', () => {
  it('preserves every body byte while updating frontmatter', async () => {
    const raw = await readFile(join(fixtureVault, fixtureRelativePath), 'utf8');
    const document = parseTaskDocument(raw);

    expect(document.data.task_id).toBe('task-20260713-deadbeef');
    const serialized = serializeTaskDocument(
      { ...document.data, schema_version: 1 },
      document.body,
    );
    expect(parseTaskDocument(serialized).body).toBe(document.body);
  });
});

describe('MarkdownTaskRepository', () => {
  it('loads legacy snake_case fields and derives a stable source key without rewriting', async () => {
    const root = await makeVault();
    const path = join(root, fixtureRelativePath);
    const before = await readFile(path, 'utf8');
    const repository = new MarkdownTaskRepository(root);

    const task = await repository.get('task-20260713-deadbeef');

    const digest = createHash('sha256')
      .update([
        'explicit_note_todo',
        '2026-07-13',
        '/fixtures/source-note.md',
        'Research the category and summarize evidence.',
      ].join('|'))
      .digest('hex');
    expect(task).toMatchObject({
      schemaVersion: 1,
      taskId: 'task-20260713-deadbeef',
      title: 'Research a public product category',
      status: 'inbox',
      reviewState: 'ready_for_confirm',
      projectId: null,
      taskType: null,
      acceptanceCriteria: [],
      autoExecutable: false,
      sourceDate: '2026-07-13',
      sourceKey: `legacy:${digest}`,
      priority: 'high',
      attempts: 0,
      artifactRefs: [],
    });
    expect(task.body).toContain('Sanitized fixture content');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('writes ATL fields, moves a ready task, preserves body, and rebuilds the index', async () => {
    const root = await makeVault();
    const repository = new MarkdownTaskRepository(root);
    const oldPath = join(root, fixtureRelativePath);
    const oldRaw = await readFile(oldPath, 'utf8');
    const oldBody = parseTaskDocument(oldRaw).body;
    const legacyTask = await repository.get('task-20260713-deadbeef');
    const readyTask: Task = {
      ...legacyTask,
      status: 'ready',
      reviewState: 'confirmed',
      projectId: 'project-public-research',
      taskType: 'research',
      objective: 'Compare public evidence',
      acceptanceCriteria: ['Cite public sources'],
      autoExecutable: true,
      permissionProfile: 'read_only_research',
      possibleDuplicateIds: ['task-synthetic-duplicate'],
      readyAt: '2026-07-14T08:30:00+08:00',
      updatedAt: '2026-07-14T08:30:00+08:00',
    };

    const saved = await repository.save(readyTask);

    const newPath = join(
      root,
      '10_Tasks',
      'Active',
      'project-public-research',
      'task-20260713-deadbeef.md',
    );
    const persisted = parseTaskDocument(await readFile(newPath, 'utf8'));
    expect(saved).toEqual(readyTask);
    expect(persisted.body).toBe(oldBody);
    expect(persisted.data).toMatchObject({
      type: 'task',
      schema_version: 1,
      task_id: 'task-20260713-deadbeef',
      review_state: 'confirmed',
      project_id: 'project-public-research',
      task_type: 'research',
      objective: 'Compare public evidence',
      acceptance_criteria: ['Cite public sources'],
      auto_executable: true,
      permission_profile: 'read_only_research',
      source_key: readyTask.sourceKey,
      possible_duplicate_ids: ['task-synthetic-duplicate'],
      attempts: 0,
      artifact_refs: [],
      ready_at: '2026-07-14T08:30:00+08:00',
    });
    await expect(stat(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    expect(index).toContain('| 任务标题 | 状态 | 确认状态 | 来源类型 | 来源日期 | 优先级 | OKR | 钉钉状态 | 最近更新 | 候选文件 |');
    expect(index).toContain(`[task-20260713-deadbeef.md](${newPath})`);
    expect(index).not.toContain(oldPath);
  });

  it('preserves a committed task and reports a typed stale-index error', async () => {
    const root = await makeVault();
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const indexPath = join(root, '10_Tasks', '任务索引.md');
    await mkdir(indexPath, { recursive: true });

    await expect(repository.save({
      ...task,
      title: 'Updated synthetic title',
      updatedAt: '2026-07-14T09:00:00+08:00',
    })).rejects.toBeInstanceOf(TaskSavedIndexStaleError);

    const persisted = await repository.get(task.taskId);
    expect(persisted.title).toBe('Updated synthetic title');
  });

  it('rejects configured real-root-equivalent writes unless explicitly allowed', async () => {
    const root = await makeVault();
    process.env.ATL_VAULT_ROOT = root;
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');

    await expect(repository.save({
      ...task,
      title: 'This write must be rejected',
    })).rejects.toThrow('Real vault writes are disabled');

    process.env.ATL_ALLOW_REAL_WRITES = '1';
    await expect(repository.save({
      ...task,
      title: 'Explicitly allowed synthetic write',
    })).resolves.toMatchObject({ title: 'Explicitly allowed synthetic write' });
  });

  it('rejects task path fields that could escape lifecycle directories', async () => {
    const root = await makeVault();
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');

    await expect(repository.save({
      ...task,
      taskId: '../../escaped',
    })).rejects.toMatchObject({ code: 'invalid_task_data' });
    await expect(repository.save({
      ...task,
      sourceDate: '../../escaped',
    })).rejects.toMatchObject({ code: 'invalid_task_data' });
  });
});

describe('MarkdownProjectRepository', () => {
  it('atomically saves strict projects and preserves unknown metadata and body', async () => {
    const root = await makeVault();
    const path = join(
      root,
      '10_Tasks',
      'Projects',
      'project-public-research.md',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `---\nproject_id: project-public-research\nname: Old name\ndescription: Synthetic project fixture\nresources: []\ncreated_at: 2026-07-14T08:00:00+08:00\nupdated_at: 2026-07-14T08:00:00+08:00\ncustom_key: keep-me\n---\n\n# Project notes\n\nKeep this body.\n`);
    const originalBody = parseTaskDocument(await readFile(path, 'utf8')).body;
    const repository = new MarkdownProjectRepository(root);
    const project = await repository.get('project-public-research');

    await repository.save({ ...project, name: 'Updated public research' });

    const persisted = parseTaskDocument(await readFile(path, 'utf8'));
    expect(persisted.data).toMatchObject({
      project_id: 'project-public-research',
      name: 'Updated public research',
      custom_key: 'keep-me',
    });
    expect(persisted.body).toBe(originalBody);
    await expect(repository.list()).resolves.toHaveLength(1);
  });

  it('validates projects before writing', async () => {
    const root = await makeVault();
    const repository = new MarkdownProjectRepository(root);

    await expect(repository.save({
      ...makeProject(),
      resources: [{ kind: 'url', value: 'https://example.com', label: 'Example' }],
    })).resolves.toEqual(makeProject({
      resources: [{ kind: 'url', value: 'https://example.com', label: 'Example' }],
    }));
  });

  it('rejects project IDs that could escape the Projects directory', async () => {
    const root = await makeVault();
    const repository = new MarkdownProjectRepository(root);

    await expect(repository.save(makeProject({
      projectId: '../../escaped',
    }))).rejects.toMatchObject({ code: 'invalid_project_data' });
  });
});

describe('FileAuditLog', () => {
  it('appends daily JSONL and supports daily counts and task history', async () => {
    const root = await makeVault();
    const audit = new FileAuditLog(root);
    await audit.append({
      event: 'task_claimed',
      at: '2026-07-14T09:00:00+08:00',
      taskId: 'task-20260713-deadbeef',
      runId: 'run-synthetic',
      details: { mode: 'automatic', attempt: 1, accepted: true, note: null },
    });
    await audit.append({
      event: 'task_claimed',
      at: '2026-07-14T10:00:00+08:00',
      taskId: 'task-other',
      details: { mode: 'manual' },
    });

    await expect(audit.count({
      event: 'task_claimed',
      localDate: '2026-07-14',
      mode: 'automatic',
    })).resolves.toBe(1);
    await expect(audit.listForTask('task-20260713-deadbeef')).resolves.toEqual([
      expect.objectContaining({ at: '2026-07-14T09:00:00+08:00' }),
    ]);
  });

  it('rejects nested or sensitive audit details without echoing values', async () => {
    const root = await makeVault();
    const audit = new FileAuditLog(root);
    const secret = 'synthetic-secret-value';

    await expect(audit.append({
      event: 'invalid_event',
      at: '2026-07-14T09:00:00+08:00',
      details: { prompt: secret },
    })).rejects.not.toThrow(secret);
    await expect(audit.append({
      event: 'invalid_event',
      at: '2026-07-14T09:00:00+08:00',
      details: { noteBody: secret },
    })).rejects.toMatchObject({ code: 'invalid_audit_event' });
    await expect(audit.append({
      event: 'invalid_event',
      at: '2026-07-14T09:00:00+08:00',
      details: { nested: { value: 'not scalar' } } as never,
    })).rejects.toThrow('Invalid audit event');
  });

  it('sorts task history by absolute timestamp across UTC offsets', async () => {
    const root = await makeVault();
    const audit = new FileAuditLog(root);
    await audit.append({
      event: 'task_updated',
      at: '2026-07-14T02:00:00Z',
      taskId: 'task-20260713-deadbeef',
    });
    await audit.append({
      event: 'task_updated',
      at: '2026-07-14T09:30:00+08:00',
      taskId: 'task-20260713-deadbeef',
    });

    const events = await audit.listForTask('task-20260713-deadbeef');
    expect(events.map((event) => event.at)).toEqual([
      '2026-07-14T09:30:00+08:00',
      '2026-07-14T02:00:00Z',
    ]);
  });
});
