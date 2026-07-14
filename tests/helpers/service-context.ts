import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceContext } from '../../src/services/service-context.js';
import { FileAuditLog } from '../../src/storage/audit-log.js';
import { MarkdownProjectRepository } from '../../src/storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../../src/storage/markdown-task-repository.js';

export interface TestServiceContext {
  ctx: ServiceContext;
  root: string;
  cleanup: () => Promise<void>;
}

export async function createTestServiceContext(options: {
  now?: Date;
  ids?: string[];
} = {}): Promise<TestServiceContext> {
  const root = await mkdtemp(join(tmpdir(), 'atl-services-'));
  const now = options.now ?? new Date('2026-07-14T00:00:00.000Z');
  const ids = options.ids ?? [
    'task-20260714-00000001',
    'task-20260714-00000002',
    'task-20260714-00000003',
  ];
  let nextId = 0;

  return {
    root,
    ctx: {
      tasks: new MarkdownTaskRepository(root),
      projects: new MarkdownProjectRepository(root),
      audit: new FileAuditLog(root, { timeZone: 'Asia/Shanghai' }),
      clock: () => new Date(now),
      id: () => {
        const id = ids[nextId];
        if (id === undefined) {
          throw new Error('Test ID sequence exhausted');
        }
        nextId += 1;
        return id;
      },
    },
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}
