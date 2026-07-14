import { join, resolve } from 'node:path';

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

export function isSafePathSegment(value: string): boolean {
  return value !== ''
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

export function lifecycleDirectory(root: string, task: Task): string {
  if (task.status === 'inbox') {
    return join(root, 'Inbox', task.sourceDate ?? 'undated');
  }
  if (['done', 'cancelled'].includes(task.status)) {
    return join(root, 'Archive', task.updatedAt.slice(0, 4));
  }
  return join(root, 'Active', task.projectId ?? 'unassigned');
}

export function artifactDirectory(root: string, taskId: string): string {
  return join(taskStorageRoot(root), 'Artifacts', taskId);
}

export function projectFilePath(root: string, projectId: string): string {
  return join(taskStorageRoot(root), 'Projects', `${projectId}.md`);
}

export function auditFilePath(root: string, localDate: string): string {
  return join(taskStorageRoot(root), 'Audit', `${localDate}.jsonl`);
}

export function assertVaultWriteAllowed(root: string): void {
  const configuredRealRoot = process.env.ATL_VAULT_ROOT;
  if (
    configuredRealRoot !== undefined
    && resolve(configuredRealRoot) === resolve(root)
    && process.env.ATL_ALLOW_REAL_WRITES !== '1'
  ) {
    throw new Error('Real vault writes are disabled');
  }
}
