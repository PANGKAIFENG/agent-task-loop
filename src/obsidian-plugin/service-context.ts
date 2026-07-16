import { MarkdownArtifactRepository } from '../storage/markdown-artifact-repository.js';
import { FileAuditLog } from '../storage/audit-log.js';
import { MarkdownProjectRepository } from '../storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../storage/markdown-task-repository.js';
import type { VaultWriteAuthorization } from '../storage/task-paths.js';
import {
  createTaskId,
  type ServiceContext,
} from '../services/service-context.js';

export interface ObsidianServiceContextOptions {
  clock?: () => Date;
  id?: () => string;
  timeZone?: string;
}

export function createObsidianServiceContext(
  root: string,
  writeAuthorization: VaultWriteAuthorization,
  options: ObsidianServiceContextOptions = {},
): ServiceContext {
  const clock = options.clock ?? (() => new Date());
  return {
    tasks: new MarkdownTaskRepository(root, { writeAuthorization }),
    artifacts: new MarkdownArtifactRepository(root, { writeAuthorization }),
    projects: new MarkdownProjectRepository(root, { writeAuthorization }),
    audit: new FileAuditLog(root, {
      writeAuthorization,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    }),
    clock,
    id: options.id ?? (() => createTaskId(clock())),
  };
}
