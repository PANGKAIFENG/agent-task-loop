import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from 'node:path';

import type { Task } from '../domain/task.js';

export function vaultRoot(configuredRoot?: string): string {
  const root = configuredRoot ?? process.env.ATL_VAULT_ROOT;
  if (root === undefined || root.trim() === '') {
    throw new Error('ATL_VAULT_ROOT is required');
  }
  return resolve(root);
}

export function taskStorageRoot(root: string): string {
  return join(resolve(root), '10_Tasks');
}

export function isTaskMarkdownPath(path: string): boolean {
  const name = basename(path);
  return name.startsWith('task-') && name.endsWith('.md');
}

export function isSafePathSegment(value: string): boolean {
  let candidate = value.normalize('NFKC');
  for (let depth = 0; depth < 16; depth += 1) {
    if (!isLiteralSafeSegment(candidate)) {
      return false;
    }
    try {
      const decoded = decodeURIComponent(candidate).normalize('NFKC');
      if (decoded === candidate) {
        return true;
      }
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return false;
}

function isLiteralSafeSegment(value: string): boolean {
  return value !== ''
    && value !== '.'
    && value !== '..'
    && !isAbsolute(value)
    && !win32.isAbsolute(value)
    && !/[\\/\0\r\n]/.test(value);
}

function assertSafePathSegment(value: string): void {
  if (!isSafePathSegment(value)) {
    throw new Error('Invalid path segment');
  }
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

function joinWithin(parent: string, segment: string, suffix = ''): string {
  assertSafePathSegment(segment);
  const resolvedParent = resolve(parent);
  const canonicalAllowedParent = canonicalizePotentialPath(dirname(resolvedParent));
  const canonicalParent = canonicalizePotentialPath(resolvedParent);
  if (!isWithin(canonicalAllowedParent, canonicalParent)) {
    throw new Error('Storage path escapes required directory');
  }

  const target = resolve(resolvedParent, `${segment}${suffix}`);
  const canonicalTarget = canonicalizePotentialPath(target);
  if (!isWithin(canonicalParent, canonicalTarget)) {
    throw new Error('Storage path escapes required directory');
  }
  return target;
}

function storageSubdirectory(root: string, name: string): string {
  const canonicalRoot = canonicalizePotentialPath(root);
  const tasksRoot = taskStorageRoot(root);
  const canonicalTasksRoot = canonicalizePotentialPath(tasksRoot);
  if (!isWithin(canonicalRoot, canonicalTasksRoot)) {
    throw new Error('Storage path escapes required directory');
  }

  const directory = join(tasksRoot, name);
  const canonicalDirectory = canonicalizePotentialPath(directory);
  if (!isWithin(canonicalTasksRoot, canonicalDirectory)) {
    throw new Error('Storage path escapes required directory');
  }
  return directory;
}

export function lifecycleDirectory(root: string, task: Task): string {
  if (task.status === 'inbox') {
    return joinWithin(join(root, 'Inbox'), task.sourceDate ?? 'undated');
  }
  if (['done', 'cancelled'].includes(task.status)) {
    const year = task.updatedAt.slice(0, 4);
    if (!/^\d{4}$/.test(year)) {
      throw new Error('Invalid path segment');
    }
    return joinWithin(join(root, 'Archive'), year);
  }
  return joinWithin(join(root, 'Active'), task.projectId ?? 'unassigned');
}

export function artifactDirectory(root: string, taskId: string): string {
  return joinWithin(storageSubdirectory(root, 'Artifacts'), taskId);
}

export function projectFilePath(root: string, projectId: string): string {
  return joinWithin(storageSubdirectory(root, 'Projects'), projectId, '.md');
}

export function auditFilePath(root: string, localDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error('Invalid path segment');
  }
  return joinWithin(storageSubdirectory(root, 'Audit'), localDate, '.jsonl');
}

export function assertVaultWriteAllowed(root: string): void {
  const canonicalRoot = canonicalizePotentialPath(root);
  const canonicalTasksRoot = canonicalizePotentialPath(taskStorageRoot(root));
  if (!isWithin(canonicalRoot, canonicalTasksRoot)) {
    throw new Error('Vault writes are disabled');
  }
  const canonicalTempRoot = canonicalizePotentialPath(tmpdir());
  // OS temp roots are test-safe. Every other root requires an explicit,
  // canonical ATL_VAULT_ROOT match plus ATL_ALLOW_REAL_WRITES=1.
  if (isWithin(canonicalTempRoot, canonicalRoot)) {
    return;
  }

  const configuredRoot = process.env.ATL_VAULT_ROOT;
  if (
    configuredRoot === undefined
    || configuredRoot.trim() === ''
    || process.env.ATL_ALLOW_REAL_WRITES !== '1'
    || canonicalizePotentialPath(configuredRoot) !== canonicalRoot
  ) {
    throw new Error('Vault writes are disabled');
  }
}

function canonicalizePotentialPath(path: string): string {
  let existingParent = resolve(path);
  const missingSegments: string[] = [];

  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) {
      break;
    }
    missingSegments.unshift(basename(existingParent));
    existingParent = parent;
  }

  const canonicalParent = realpathSync(existingParent);
  return resolve(canonicalParent, ...missingSegments);
}
