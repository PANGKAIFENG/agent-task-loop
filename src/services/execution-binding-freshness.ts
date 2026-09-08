import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ExecutionBindingReceipt } from '../domain/execution-binding.js';
import { projectContextSha256 } from '../domain/project-context-resolution.js';
import {
  taskContextVersion,
  taskDispatchContentSha256,
} from '../runner/context-bundle.js';
import type { ServiceContext } from './service-context.js';

export async function vaultExecutionIdentity(runtimeRoot: string): Promise<string> {
  const canonicalVaultRoot = await realpath(dirname(resolve(runtimeRoot)));
  const digest = createHash('sha256')
    .update(JSON.stringify({ canonicalVaultRoot }))
    .digest('hex');
  return `vault_${digest}`;
}

export async function executionBindingFreshnessMatches(
  ctx: ServiceContext,
  runtimeRoot: string,
  binding: ExecutionBindingReceipt,
): Promise<boolean> {
  const task = await ctx.tasks.get(binding.taskId);
  if (
    task.projectId === null
    || taskContextVersion(task) !== binding.taskContextVersion
    || taskDispatchContentSha256(task) !== binding.taskContentSha256
    || await vaultExecutionIdentity(runtimeRoot) !== binding.vaultIdentity
  ) return false;
  const project = await ctx.projects.get(task.projectId);
  return projectContextSha256(project) === binding.projectContextSha256;
}
