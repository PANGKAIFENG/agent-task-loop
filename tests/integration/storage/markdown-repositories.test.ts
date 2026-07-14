import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
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
import { rebuildTaskIndex } from '../../../src/storage/task-index.js';
import {
  artifactDirectory,
  auditFilePath,
  projectFilePath,
} from '../../../src/storage/task-paths.js';

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

async function makeNonTempVault(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.atl-storage-test-'));
  temporaryRoots.push(root);
  await cp(fixtureVault, root, { recursive: true });
  return root;
}

async function writeIndexTask(
  root: string,
  filename: string,
  fields: {
    taskId: string;
    title: string;
    updatedAt: string;
  },
): Promise<string> {
  const path = join(root, '10_Tasks', 'Active', 'project-index', filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\ntype: task\ntask_id: ${JSON.stringify(fields.taskId)}\ntitle: ${JSON.stringify(fields.title)}\nstatus: ready\nreview_state: confirmed\norigin: synthetic_index_test\nsource_date: 2026-07-14\npriority: normal\nupdated_at: ${JSON.stringify(fields.updatedAt)}\n---\n\nSynthetic index fixture.\n`);
  return path;
}

async function plantPredictableTempSymlink(target: string): Promise<{
  outsidePath: string;
  sentinel: string;
  temporaryPath: string;
}> {
  const outsideRoot = await mkdtemp(join(tmpdir(), 'atl-storage-atomic-outside-'));
  temporaryRoots.push(outsideRoot);
  const outsidePath = join(outsideRoot, 'outside.txt');
  const sentinel = 'outside-file-must-not-change';
  const temporaryPath = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(outsidePath, sentinel);
  await symlink(outsidePath, temporaryPath);
  return { outsidePath, sentinel, temporaryPath };
}

function syntheticExternalTask(title: string): string {
  return `---\ntype: task\ntask_id: task-external-symlink\ntitle: ${JSON.stringify(title)}\nstatus: ready\nreview_state: confirmed\norigin: synthetic_symlink_test\nsource_date: 2026-07-14\npriority: normal\ncreated_at: 2026-07-14T08:00:00+08:00\nupdated_at: 2026-07-14T08:00:00+08:00\n---\n\nExternal synthetic content.\n`;
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
    expect(index).toContain(`[task-20260713-deadbeef.md](<${encodeURI(newPath)}>)`);
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

  it('always allows OS temp roots even when real-vault environment differs', async () => {
    const root = await makeVault();
    process.env.ATL_VAULT_ROOT = join(process.cwd(), 'different-vault');
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');

    await expect(repository.save({
      ...task,
      title: 'Allowed synthetic temp write',
    })).resolves.toMatchObject({ title: 'Allowed synthetic temp write' });
  });

  it('fails closed for non-temp roots and resolves symlink aliases canonically', async () => {
    const root = await makeNonTempVault();
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');

    await expect(repository.save(task)).rejects.toThrow('Vault writes are disabled');
    process.env.ATL_ALLOW_REAL_WRITES = '1';
    await expect(repository.save(task)).rejects.toThrow('Vault writes are disabled');
    process.env.ATL_VAULT_ROOT = `${root}-different`;
    await expect(repository.save(task)).rejects.toThrow('Vault writes are disabled');

    process.env.ATL_VAULT_ROOT = root;
    await expect(repository.save(task)).resolves.toEqual(task);

    const alias = `${root}-alias`;
    temporaryRoots.push(alias);
    await symlink(root, alias, 'dir');
    delete process.env.ATL_ALLOW_REAL_WRITES;
    const aliasRepository = new MarkdownTaskRepository(alias);
    const aliasedTask = await aliasRepository.get(task.taskId);
    await expect(aliasRepository.save(aliasedTask)).rejects.toThrow('Vault writes are disabled');
    process.env.ATL_ALLOW_REAL_WRITES = '1';
    await expect(aliasRepository.save(aliasedTask)).resolves.toEqual(aliasedTask);
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

  it('preserves external body and unknown metadata edits on an existing task save', async () => {
    const root = await makeVault();
    const path = join(root, fixtureRelativePath);
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const external = parseTaskDocument(await readFile(path, 'utf8'));
    const externalBody = '\nExternally edited synthetic body.\n';
    await writeFile(path, serializeTaskDocument({
      ...external.data,
      external_unknown: 'preserve-me',
    }, externalBody));

    await repository.save({ ...task, title: 'Requested canonical update' });

    const persistedPath = join(dirname(path), `${task.taskId}.md`);
    const persisted = parseTaskDocument(await readFile(persistedPath, 'utf8'));
    expect(persisted.data.title).toBe('Requested canonical update');
    expect(persisted.data.external_unknown).toBe('preserve-me');
    expect(persisted.body).toBe(externalBody);
  });

  it('rejects an existing task save after an external canonical edit', async () => {
    const root = await makeVault();
    const path = join(root, fixtureRelativePath);
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const external = parseTaskDocument(await readFile(path, 'utf8'));
    await writeFile(path, serializeTaskDocument({
      ...external.data,
      title: 'External canonical edit',
    }, external.body));

    await expect(repository.save({
      ...task,
      priority: 'urgent',
    })).rejects.toMatchObject({ code: 'task_conflict' });
    expect(parseTaskDocument(await readFile(path, 'utf8')).data.title).toBe(
      'External canonical edit',
    );
  });

  it('rejects save after external task deletion without recreating it', async () => {
    const root = await makeVault();
    const path = join(root, fixtureRelativePath);
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    await rm(path);

    await expect(repository.save({ ...task, title: 'Must not recreate' }))
      .rejects.toMatchObject({ code: 'task_conflict' });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rescans an externally moved task by ID before saving', async () => {
    const root = await makeVault();
    const oldPath = join(root, fixtureRelativePath);
    const movedPath = join(dirname(oldPath), 'externally-moved.md');
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    await rename(oldPath, movedPath);

    await repository.save({ ...task, title: 'Saved after external move' });

    const targetPath = join(dirname(oldPath), `${task.taskId}.md`);
    expect(parseTaskDocument(await readFile(targetPath, 'utf8')).data.title).toBe(
      'Saved after external move',
    );
    await expect(stat(movedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite or delete a replacement at a stale cached task path', async () => {
    const root = await makeVault();
    const oldPath = join(root, fixtureRelativePath);
    const movedPath = join(dirname(oldPath), 'externally-moved.md');
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const original = await readFile(oldPath, 'utf8');
    await rename(oldPath, movedPath);
    const replacementDocument = parseTaskDocument(original);
    await writeFile(oldPath, serializeTaskDocument({
      ...replacementDocument.data,
      task_id: 'task-replacement-safe',
      title: 'Replacement must survive',
    }, replacementDocument.body));

    await expect(repository.save({
      ...task,
      title: 'Save should use rescanned path',
    })).resolves.toMatchObject({ title: 'Save should use rescanned path' });

    const replacement = parseTaskDocument(await readFile(oldPath, 'utf8'));
    const targetPath = join(dirname(oldPath), `${task.taskId}.md`);
    const moved = parseTaskDocument(await readFile(targetPath, 'utf8'));
    expect(replacement.data.task_id).toBe('task-replacement-safe');
    expect(replacement.data.title).toBe('Replacement must survive');
    expect(moved.data.task_id).toBe('task-20260713-deadbeef');
    await expect(stat(movedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const tasks = await new MarkdownTaskRepository(root).list();
    expect(tasks.filter((candidate) => candidate.taskId === task.taskId)).toHaveLength(1);
  });

  it('leaves one source task when a lifecycle move target is occupied', async () => {
    const root = await makeVault();
    const sourcePath = join(root, fixtureRelativePath);
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const targetPath = join(
      root,
      '10_Tasks',
      'Active',
      'project-public-research',
      `${task.taskId}.md`,
    );
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, syntheticExternalTask('Occupied target').replace(
      'task_id: task-external-symlink',
      'task_id: task-occupied-target',
    ));

    await expect(repository.save({
      ...task,
      status: 'ready',
      reviewState: 'confirmed',
      projectId: 'project-public-research',
      taskType: 'research',
      objective: 'Synthetic occupied target move',
      acceptanceCriteria: ['Leave one source task'],
      autoExecutable: true,
      permissionProfile: 'read_only_research',
    })).rejects.toMatchObject({ code: 'task_conflict' });

    expect(parseTaskDocument(await readFile(targetPath, 'utf8')).data.task_id).toBe(
      'task-occupied-target',
    );
    expect(parseTaskDocument(await readFile(sourcePath, 'utf8')).data.task_id).toBe(
      task.taskId,
    );
    const tasks = await new MarkdownTaskRepository(root).list();
    expect(tasks.filter((candidate) => candidate.taskId === task.taskId)).toHaveLength(1);
  });

  it('rejects duplicate task IDs from list, get, and source-key lookup', async () => {
    const root = await makeVault();
    const duplicatePath = join(root, '10_Tasks', 'Active', 'synthetic', 'duplicate.md');
    await mkdir(dirname(duplicatePath), { recursive: true });
    await cp(join(root, fixtureRelativePath), duplicatePath);

    await expect(new MarkdownTaskRepository(root).list()).rejects.toMatchObject({
      code: 'task_integrity_error',
    });
    await expect(
      new MarkdownTaskRepository(root).get('task-20260713-deadbeef'),
    ).rejects.toMatchObject({ code: 'task_integrity_error' });
    await expect(
      new MarkdownTaskRepository(root).findBySourceKey('synthetic-source-key'),
    ).rejects.toMatchObject({ code: 'task_integrity_error' });
  });
});

describe('storage path boundaries', () => {
  it('rejects traversal, absolute paths, separators, and encoded traversal', async () => {
    const root = await makeVault();
    const invalidSegments = [
      '.',
      '..',
      '../../escaped',
      '/absolute/path',
      'nested/path',
      'nested\\path',
      '%2e%2e%2fescaped',
      '%252e%252e%252fescaped',
      '%2525252e%2525252e%2525252fescaped',
    ];

    for (const segment of invalidSegments) {
      expect(() => artifactDirectory(root, segment)).toThrow('Invalid path segment');
      expect(() => projectFilePath(root, segment)).toThrow('Invalid path segment');
      expect(() => auditFilePath(root, segment)).toThrow('Invalid path segment');
    }
  });

  it('guards direct index rebuilds outside OS temp', async () => {
    const root = await makeNonTempVault();

    await expect(rebuildTaskIndex(root)).rejects.toThrow('Vault writes are disabled');
  });

  it('rejects storage subdirectories that symlink outside 10_Tasks', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-outside-'));
    temporaryRoots.push(outside);
    const projects = join(root, '10_Tasks', 'Projects');
    await mkdir(dirname(projects), { recursive: true });
    await symlink(outside, projects, 'dir');

    expect(() => projectFilePath(root, 'project-safe-name')).toThrow(
      'Storage path escapes required directory',
    );
  });
});

describe('atomic Markdown writes', () => {
  it('does not follow or rename a predictable task temp symlink', async () => {
    const root = await makeVault();
    const repository = new MarkdownTaskRepository(root);
    const task = await repository.get('task-20260713-deadbeef');
    const target = join(
      root,
      '10_Tasks',
      'Inbox',
      '2026-07-13',
      `${task.taskId}.md`,
    );
    const attack = await plantPredictableTempSymlink(target);

    await repository.save(task);

    expect(await readFile(attack.outsidePath, 'utf8')).toBe(attack.sentinel);
    expect((await lstat(attack.temporaryPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).isFile()).toBe(true);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  it('does not follow or rename a predictable project temp symlink', async () => {
    const root = await makeVault();
    const target = projectFilePath(root, 'project-public-research');
    const attack = await plantPredictableTempSymlink(target);
    const repository = new MarkdownProjectRepository(root);

    await repository.save(makeProject());

    expect(await readFile(attack.outsidePath, 'utf8')).toBe(attack.sentinel);
    expect((await lstat(attack.temporaryPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).isFile()).toBe(true);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  it('does not follow or rename a predictable index temp symlink', async () => {
    const root = await makeVault();
    const target = join(root, '10_Tasks', '任务索引.md');
    const attack = await plantPredictableTempSymlink(target);

    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');

    expect(await readFile(attack.outsidePath, 'utf8')).toBe(attack.sentinel);
    expect((await lstat(attack.temporaryPath)).isSymbolicLink()).toBe(true);
    expect((await lstat(target)).isFile()).toBe(true);
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });
});

describe('symlink-safe scans', () => {
  it('ignores an Active root aliased outside 10_Tasks in task list and index', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-active-root-outside-'));
    temporaryRoots.push(outside);
    const externalTitle = 'EXTERNAL_ACTIVE_ROOT_SENTINEL';
    await writeFile(join(outside, 'external-task.md'), syntheticExternalTask(externalTitle));
    await symlink(outside, join(root, '10_Tasks', 'Active'), 'dir');

    const tasks = await new MarkdownTaskRepository(root).list();
    expect.soft(tasks.map((task) => task.title)).toEqual([
      'Research a public product category',
    ]);
    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');
    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    expect(index).not.toContain(externalTitle);
  });

  it('ignores a Projects root aliased outside 10_Tasks', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-project-root-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, 'external.md'), `---\nproject_id: external\nname: EXTERNAL_PROJECT_ROOT_SENTINEL\ndescription: Synthetic external project\nresources: []\ncreated_at: 2026-07-14T08:00:00+08:00\nupdated_at: 2026-07-14T08:00:00+08:00\n---\n`);
    await symlink(outside, join(root, '10_Tasks', 'Projects'), 'dir');

    await expect(new MarkdownProjectRepository(root).list()).resolves.toEqual([]);
  });

  it('ignores an Audit root aliased outside 10_Tasks', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-audit-root-outside-'));
    temporaryRoots.push(outside);
    await writeFile(join(outside, '2026-07-15.jsonl'), `${JSON.stringify({
      event: 'external_event',
      at: '2026-07-15T08:00:00+08:00',
      taskId: 'EXTERNAL_AUDIT_ROOT_SENTINEL',
    })}\n`);
    await symlink(outside, join(root, '10_Tasks', 'Audit'), 'dir');

    await expect(
      new FileAuditLog(root).listForTask('EXTERNAL_AUDIT_ROOT_SENTINEL'),
    ).resolves.toEqual([]);
  });

  it('ignores a 10_Tasks root aliased outside the configured vault', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-task-root-outside-'));
    temporaryRoots.push(outside);
    await mkdir(join(outside, 'Inbox', '2026-07-15'), { recursive: true });
    await mkdir(join(outside, 'Projects'), { recursive: true });
    await mkdir(join(outside, 'Audit'), { recursive: true });
    await writeFile(
      join(outside, 'Inbox', '2026-07-15', 'external-task.md'),
      syntheticExternalTask('EXTERNAL_TASK_ROOT_SENTINEL'),
    );
    await writeFile(join(outside, 'Projects', 'external.md'), `---\nproject_id: external\nname: EXTERNAL_PROJECT_TASK_ROOT_SENTINEL\ndescription: Synthetic external project\nresources: []\ncreated_at: 2026-07-14T08:00:00+08:00\nupdated_at: 2026-07-14T08:00:00+08:00\n---\n`);
    await writeFile(join(outside, 'Audit', '2026-07-15.jsonl'), `${JSON.stringify({
      event: 'external_event',
      at: '2026-07-15T08:00:00+08:00',
      taskId: 'EXTERNAL_TASK_ROOT_AUDIT_SENTINEL',
    })}\n`);
    await rm(join(root, '10_Tasks'), { recursive: true });
    await symlink(outside, join(root, '10_Tasks'), 'dir');

    await expect(new MarkdownTaskRepository(root).list()).resolves.toEqual([]);
    await expect(new MarkdownProjectRepository(root).list()).resolves.toEqual([]);
    await expect(
      new FileAuditLog(root).listForTask('EXTERNAL_TASK_ROOT_AUDIT_SENTINEL'),
    ).resolves.toEqual([]);
    await expect(
      rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z'),
    ).rejects.toThrow('Vault writes are disabled');
  });

  it('skips external task directory and file symlinks in list and index', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-task-scan-outside-'));
    temporaryRoots.push(outside);
    const externalTitle = 'EXTERNAL_TASK_SENTINEL';
    const externalTask = join(outside, 'external-task.md');
    await writeFile(externalTask, syntheticExternalTask(externalTitle));
    const activeRoot = join(root, '10_Tasks', 'Active');
    await mkdir(activeRoot, { recursive: true });
    await symlink(outside, join(activeRoot, 'external-directory'), 'dir');
    await symlink(
      externalTask,
      join(root, '10_Tasks', 'Inbox', '2026-07-13', 'external-file.md'),
    );

    const tasks = await new MarkdownTaskRepository(root).list();
    expect(tasks.map((task) => task.title)).toEqual([
      'Research a public product category',
    ]);
    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');
    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    expect(index).not.toContain(externalTitle);
    expect(index).not.toContain('external-file.md');
  });

  it('skips external project and audit directory and file symlinks', async () => {
    const root = await makeVault();
    const outside = await mkdtemp(join(tmpdir(), 'atl-storage-scan-outside-'));
    temporaryRoots.push(outside);
    const outsideProjects = join(outside, 'projects');
    const outsideAudit = join(outside, 'audit');
    await mkdir(outsideProjects, { recursive: true });
    await mkdir(outsideAudit, { recursive: true });
    const externalProject = join(outsideProjects, 'external-file.md');
    await writeFile(externalProject, `---\nproject_id: external-file\nname: EXTERNAL_PROJECT_SENTINEL\ndescription: Synthetic external project\nresources: []\ncreated_at: 2026-07-14T08:00:00+08:00\nupdated_at: 2026-07-14T08:00:00+08:00\n---\n`);
    const externalAudit = join(outsideAudit, 'external.jsonl');
    await writeFile(externalAudit, `${JSON.stringify({
      event: 'external_event',
      at: '2026-07-15T08:00:00+08:00',
      taskId: 'EXTERNAL_AUDIT_SENTINEL',
    })}\n`);

    const projectsRoot = join(root, '10_Tasks', 'Projects');
    const auditRoot = join(root, '10_Tasks', 'Audit');
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(auditRoot, { recursive: true });
    await symlink(outsideProjects, join(projectsRoot, 'external-directory'), 'dir');
    await symlink(externalProject, join(projectsRoot, 'external-file.md'));
    await symlink(outsideAudit, join(auditRoot, 'external-directory'), 'dir');
    await symlink(externalAudit, join(auditRoot, '2026-07-15.jsonl'));

    const projects = new MarkdownProjectRepository(root);
    await expect(projects.list()).resolves.toEqual([]);
    await expect(projects.get('external-file')).rejects.toMatchObject({
      code: 'project_not_found',
    });
    const audit = new FileAuditLog(root);
    await expect(audit.listForTask('EXTERNAL_AUDIT_SENTINEL')).resolves.toEqual([]);
    await expect(audit.count({
      event: 'external_event',
      localDate: '2026-07-15',
    })).resolves.toBe(0);
  });
});

describe('task index rendering', () => {
  it('renders a valid 10-column link row for special Markdown path characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl storage (index)-'));
    temporaryRoots.push(root);
    const path = await writeIndexTask(root, 'task]legacy\\name.md', {
      taskId: 'task-index-special',
      title: 'Title with ] and \\ characters',
      updatedAt: '2026-07-14T08:00:00+08:00',
    });

    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');

    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    const row = index.split('\n').find((line) => line.includes('Title with'));
    expect(row).toBeDefined();
    expect(row?.split('|')).toHaveLength(12);
    expect(row).toContain('[task\\]legacy\\\\name.md]');
    expect(row).toContain(`<${encodeURI(path).replaceAll('(', '%28').replaceAll(')', '%29')}>`);
  });

  it('sorts updated times by parsed instant with deterministic offset handling', async () => {
    const root = await makeVault();
    await rm(join(root, fixtureRelativePath));
    await writeIndexTask(root, 'earlier.md', {
      taskId: 'task-earlier',
      title: 'Earlier instant',
      updatedAt: '2026-07-14T09:30:00+08:00',
    });
    await writeIndexTask(root, 'later.md', {
      taskId: 'task-later',
      title: 'Later instant',
      updatedAt: '2026-07-14T02:00:00Z',
    });

    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');

    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    expect(index.indexOf('Later instant')).toBeLessThan(index.indexOf('Earlier instant'));
  });

  it('encodes URL-significant filename characters exactly once', async () => {
    const root = await makeVault();
    const path = await writeIndexTask(root, 'task#part?literal%20.md', {
      taskId: 'task-url-significant',
      title: 'URL significant path',
      updatedAt: '2026-07-14T08:00:00+08:00',
    });

    await rebuildTaskIndex(root, '2026-07-14T00:00:00.000Z');

    const index = await readFile(join(root, '10_Tasks', '任务索引.md'), 'utf8');
    const row = index.split('\n').find((line) => line.includes('URL significant path'));
    expect(row).toBeDefined();
    expect(row?.split('|')).toHaveLength(12);
    const destination = row?.match(/\]\(<([^>]+)>\)/)?.[1];
    expect(destination).toContain('task%23part%3Fliteral%2520.md');
    expect(decodeURIComponent(destination ?? '')).toBe(path);
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

  it('preserves external project body and unknown metadata edits on save', async () => {
    const root = await makeVault();
    const path = projectFilePath(root, 'project-public-research');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeTaskDocument({
      project_id: 'project-public-research',
      name: 'Original project',
      description: 'Synthetic project fixture',
      resources: [],
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:00:00+08:00',
    }, '\nOriginal project body.\n'));
    const repository = new MarkdownProjectRepository(root);
    const project = await repository.get('project-public-research');
    const external = parseTaskDocument(await readFile(path, 'utf8'));
    const externalBody = '\nExternally edited project body.\n';
    await writeFile(path, serializeTaskDocument({
      ...external.data,
      external_unknown: 'preserve-project-metadata',
    }, externalBody));

    await repository.save({ ...project, name: 'Requested project update' });

    const persisted = parseTaskDocument(await readFile(path, 'utf8'));
    expect(persisted.data.name).toBe('Requested project update');
    expect(persisted.data.external_unknown).toBe('preserve-project-metadata');
    expect(persisted.body).toBe(externalBody);
  });

  it('rejects project save after an external canonical edit', async () => {
    const root = await makeVault();
    const path = projectFilePath(root, 'project-public-research');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeTaskDocument({
      project_id: 'project-public-research',
      name: 'Original project',
      description: 'Synthetic project fixture',
      resources: [],
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:00:00+08:00',
    }, '\nProject body.\n'));
    const repository = new MarkdownProjectRepository(root);
    const project = await repository.get('project-public-research');
    const external = parseTaskDocument(await readFile(path, 'utf8'));
    await writeFile(path, serializeTaskDocument({
      ...external.data,
      description: 'External canonical project edit',
    }, external.body));

    await expect(repository.save({
      ...project,
      name: 'Requested project update',
    })).rejects.toMatchObject({ code: 'project_conflict' });
    expect(parseTaskDocument(await readFile(path, 'utf8')).data.description).toBe(
      'External canonical project edit',
    );
  });

  it('rejects project save after external deletion', async () => {
    const root = await makeVault();
    const path = projectFilePath(root, 'project-public-research');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeTaskDocument({
      project_id: 'project-public-research',
      name: 'Original project',
      description: 'Synthetic project fixture',
      resources: [],
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:00:00+08:00',
    }, '\nProject body.\n'));
    const repository = new MarkdownProjectRepository(root);
    const project = await repository.get('project-public-research');
    await rm(path);

    await expect(repository.save(project)).rejects.toMatchObject({
      code: 'project_conflict',
    });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rescans a moved project by ID without touching a stale replacement path', async () => {
    const root = await makeVault();
    const oldPath = projectFilePath(root, 'project-public-research');
    const movedPath = join(dirname(oldPath), 'externally-moved.md');
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, serializeTaskDocument({
      project_id: 'project-public-research',
      name: 'Original project',
      description: 'Synthetic project fixture',
      resources: [],
      created_at: '2026-07-14T08:00:00+08:00',
      updated_at: '2026-07-14T08:00:00+08:00',
    }, '\nOriginal body.\n'));
    const repository = new MarkdownProjectRepository(root);
    const project = await repository.get('project-public-research');
    await rename(oldPath, movedPath);
    const replacement = makeProject({
      projectId: 'project-replacement-safe',
      name: 'Replacement must survive',
    });
    await writeFile(oldPath, serializeTaskDocument({
      project_id: replacement.projectId,
      name: replacement.name,
      description: replacement.description,
      resources: replacement.resources,
      created_at: replacement.createdAt,
      updated_at: replacement.updatedAt,
    }, '\nReplacement body.\n'));

    await repository.save({ ...project, name: 'Saved at moved project path' });

    expect(parseTaskDocument(await readFile(oldPath, 'utf8')).data.project_id).toBe(
      'project-replacement-safe',
    );
    const moved = parseTaskDocument(await readFile(movedPath, 'utf8'));
    expect(moved.data.project_id).toBe('project-public-research');
    expect(moved.data.name).toBe('Saved at moved project path');
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

  it('rejects normalized sensitive audit keys without persisting values', async () => {
    const root = await makeVault();
    const audit = new FileAuditLog(root);
    const secret = 'synthetic-sensitive-value';
    const sensitiveKeys = [
      'api_key',
      'apikey',
      'Authorization',
      'credential',
      'credentials',
      'cookie',
      'access-token',
      'clientSecret',
      'password',
      'system_prompt',
      'environment',
      'noteContent',
      'response_body',
      'content',
    ];

    for (const key of sensitiveKeys) {
      await expect(audit.append({
        event: 'invalid_event',
        at: '2026-07-14T09:00:00+08:00',
        details: { [key]: secret },
      })).rejects.not.toThrow(secret);
    }
    await expect(readFile(
      join(root, '10_Tasks', 'Audit', '2026-07-14.jsonl'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
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
