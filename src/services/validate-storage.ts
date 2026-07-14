import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { taskFromDocument } from '../storage/markdown-task-repository.js';
import {
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from '../storage/file-io.js';
import { parseTaskDocument } from '../storage/frontmatter.js';
import {
  lifecycleDirectory,
  taskStorageRoot,
} from '../storage/task-paths.js';

export type StorageIssueCode =
  | 'duplicate_task_id'
  | 'invalid_frontmatter'
  | 'path_status_mismatch'
  | 'task_index_missing_link'
  | 'task_index_stale_link';

export interface StorageIssue {
  code: StorageIssueCode;
  path: string;
  message: string;
  taskId?: string;
  expectedPath?: string;
}

export interface StorageValidationReport {
  ok: boolean;
  issues: StorageIssue[];
}

interface ValidTaskFile {
  path: string;
  taskId: string;
  expectedPath: string;
}

function decodeIndexPath(value: string): string | null {
  try {
    return resolve(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function indexLinks(raw: string): Set<string> {
  const links = new Set<string>();
  for (const match of raw.matchAll(/\]\(<([^>]+)>\)/g)) {
    const decoded = decodeIndexPath(match[1] ?? '');
    if (decoded !== null) {
      links.add(decoded);
    }
  }
  return links;
}

async function readTaskIndex(tasksRoot: string, indexPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(indexPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return null;
    }
    if (dirname(await realpath(indexPath)) !== await realpath(tasksRoot)) {
      return null;
    }
    handle = await open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return null;
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ELOOP')
    ) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function taskCandidates(root: string): Promise<Array<{
  path: string;
  boundary: StorageReadBoundary;
}>> {
  const tasksRoot = taskStorageRoot(root);
  return (await Promise.all(['Inbox', 'Active', 'Archive'].map(async (name) => {
    const subtree = join(tasksRoot, name);
    const boundary = { vaultRoot: root, tasksRoot, subtree };
    return (await listSafeRegularFiles(boundary, '**/*.md'))
      .map((path) => ({ path, boundary }));
  }))).flat().sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateStorage(root: string): Promise<StorageValidationReport> {
  const tasksRoot = taskStorageRoot(root);
  const issues: StorageIssue[] = [];
  const validFiles: ValidTaskFile[] = [];
  const pathsByTaskId = new Map<string, string[]>();

  for (const { path, boundary } of await taskCandidates(root)) {
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      continue;
    }
    try {
      const document = parseTaskDocument(raw);
      const task = taskFromDocument({ path, ...document });
      const expectedPath = join(
        lifecycleDirectory(tasksRoot, task),
        `${task.taskId}.md`,
      );
      validFiles.push({ path, taskId: task.taskId, expectedPath });
      const duplicatePaths = pathsByTaskId.get(task.taskId) ?? [];
      duplicatePaths.push(path);
      pathsByTaskId.set(task.taskId, duplicatePaths);
      if (resolve(path) !== resolve(expectedPath)) {
        issues.push({
          code: 'path_status_mismatch',
          path,
          taskId: task.taskId,
          expectedPath,
          message: `Task belongs at ${expectedPath}`,
        });
      }
    } catch {
      issues.push({
        code: 'invalid_frontmatter',
        path,
        message: 'Task Markdown frontmatter is invalid',
      });
    }
  }

  for (const [taskId, paths] of pathsByTaskId) {
    if (paths.length > 1) {
      for (const path of paths) {
        issues.push({
          code: 'duplicate_task_id',
          path,
          taskId,
          message: `Task ID appears ${paths.length} times`,
        });
      }
    }
  }

  const indexPath = join(tasksRoot, '任务索引.md');
  const rawIndex = await readTaskIndex(tasksRoot, indexPath);
  const links = rawIndex === null ? new Set<string>() : indexLinks(rawIndex);
  const taskPaths = new Set(validFiles.map(({ path }) => resolve(path)));
  for (const { path, taskId, expectedPath } of validFiles) {
    if (!links.has(resolve(path))) {
      issues.push({
        code: 'task_index_missing_link',
        path: indexPath,
        taskId,
        expectedPath,
        message: `Task index is missing ${path}`,
      });
    }
  }
  for (const link of links) {
    if (!taskPaths.has(link)) {
      issues.push({
        code: 'task_index_stale_link',
        path: indexPath,
        expectedPath: link,
        message: `Task index links to missing task ${link}`,
      });
    }
  }

  issues.sort((left, right) => (
    left.code.localeCompare(right.code) || left.path.localeCompare(right.path)
  ));
  return { ok: issues.length === 0, issues };
}
