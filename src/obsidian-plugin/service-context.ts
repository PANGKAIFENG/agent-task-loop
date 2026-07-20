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
  return createContext(root, writeAuthorization, options);
}

export function createObsidianReadServiceContext(
  root: string,
  options: ObsidianServiceContextOptions = {},
): ServiceContext {
  return createContext(root, undefined, options);
}

function createContext(
  root: string,
  writeAuthorization: VaultWriteAuthorization | undefined,
  options: ObsidianServiceContextOptions,
): ServiceContext {
  const clock = options.clock ?? (() => new Date());
  const repositoryOptions = writeAuthorization === undefined
    ? {}
    : { writeAuthorization };
  return {
    tasks: new MarkdownTaskRepository(root, repositoryOptions),
    artifacts: new MarkdownArtifactRepository(root, repositoryOptions),
    projects: new MarkdownProjectRepository(root, repositoryOptions),
    audit: new FileAuditLog(root, {
      ...repositoryOptions,
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    }),
    clock,
    id: options.id ?? (() => createTaskId(clock())),
  };
}
