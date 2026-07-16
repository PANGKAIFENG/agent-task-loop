import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileAuditLog } from '../../../src/storage/audit-log.js';
import { MarkdownProjectRepository } from '../../../src/storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../../../src/storage/markdown-task-repository.js';
import { rebuildTaskIndex } from '../../../src/storage/task-index.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const roots: string[] = [];

async function temporaryVault(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

describe('repository embedded write authorization', () => {
  it('rejects a write authorization issued for another Vault', async () => {
    const root = await temporaryVault('atl-authorized-vault');
    const otherRoot = await temporaryVault('atl-other-vault');
    const writeAuthorization = createVaultWriteAuthorization(otherRoot);

    const tasks = new MarkdownTaskRepository(root, { writeAuthorization });
    const projects = new MarkdownProjectRepository(root, { writeAuthorization });
    const audit = new FileAuditLog(root, { writeAuthorization });

    await expect(tasks.withTaskLock('task-test', async () => undefined))
      .rejects.toThrow('Vault writes are disabled');
    await expect(projects.create({
      projectId: 'test-project',
      name: 'Test project',
      description: 'Test description',
      resources: [],
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    })).rejects.toThrow('Vault writes are disabled');
    await expect(audit.append({
      event: 'test.event',
      at: '2026-07-16T00:00:00.000Z',
    })).rejects.toThrow('Vault writes are disabled');
    await expect(rebuildTaskIndex(
      root,
      '2026-07-16T00:00:00.000Z',
      writeAuthorization,
    )).rejects.toThrow('Vault writes are disabled');
  });
});
