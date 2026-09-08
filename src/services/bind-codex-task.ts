import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  bindCodexTaskInputSchema,
  codexTaskBindingId,
  type BindCodexTaskInput,
  type CodexTaskBinding,
} from '../domain/codex-feedback.js';
import type { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';

export class CodexFeedbackBindingInvalidError extends Error {
  readonly code = 'codex_feedback_binding_invalid';

  constructor() {
    super('Codex feedback binding is invalid');
    this.name = 'CodexFeedbackBindingInvalidError';
  }
}

export class CodexFeedbackBindingConflictError extends Error {
  readonly code = 'codex_feedback_binding_conflict';

  constructor() {
    super('Codex thread or task is already bound to a different identity');
    this.name = 'CodexFeedbackBindingConflictError';
  }
}

export interface BindCodexTaskDependencies {
  repository: FileCodexFeedbackStateRepository;
  clock: () => Date;
}

function canonicalizePotentialPath(path: string): string {
  let existingParent = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) break;
    missingSegments.unshift(basename(existingParent));
    existingParent = parent;
  }
  return resolve(realpathSync.native(existingParent), ...missingSegments);
}

function normalize(input: BindCodexTaskInput): BindCodexTaskInput {
  const parsed = bindCodexTaskInputSchema.safeParse(input);
  if (!parsed.success) throw new CodexFeedbackBindingInvalidError();
  if (!existsSync(parsed.data.artifactRoot)) throw new CodexFeedbackBindingInvalidError();
  const artifactRoot = realpathSync.native(parsed.data.artifactRoot);
  if (!statSync(artifactRoot).isDirectory()) throw new CodexFeedbackBindingInvalidError();
  const artifactPath = canonicalizePotentialPath(parsed.data.artifactPath);
  const difference = relative(artifactRoot, artifactPath);
  if (
    !isAbsolute(artifactRoot)
    || !isAbsolute(artifactPath)
    || difference === ''
    || difference.startsWith('..')
    || isAbsolute(difference)
  ) {
    throw new CodexFeedbackBindingInvalidError();
  }
  return { ...parsed.data, artifactRoot, artifactPath };
}

function sameIdentity(
  left: CodexTaskBinding,
  right: Omit<CodexTaskBinding, 'createdAt'>,
): boolean {
  return left.bindingId === right.bindingId
    && left.threadId === right.threadId
    && left.taskId === right.taskId
    && left.sourceRef === right.sourceRef
    && left.sourceSha256 === right.sourceSha256
    && left.artifactRoot === right.artifactRoot
    && left.artifactPath === right.artifactPath
    && left.experimentId === right.experimentId;
}

export async function bindCodexTask(
  dependencies: BindCodexTaskDependencies,
  input: BindCodexTaskInput,
): Promise<{ binding: CodexTaskBinding; created: boolean }> {
  const normalized = normalize(input);
  const identity = {
    ...normalized,
    bindingId: codexTaskBindingId(normalized),
  };
  return dependencies.repository.withLock(async () => {
    const actualSourceSha256 = await dependencies.repository.readSourceSha256(
      normalized.sourceRef,
    );
    if (actualSourceSha256 !== normalized.sourceSha256) {
      throw new CodexFeedbackBindingInvalidError();
    }
    const state = await dependencies.repository.read();
    const matches = state.bindings.filter((candidate) => (
      candidate.threadId === identity.threadId
      || candidate.taskId === identity.taskId
      || candidate.bindingId === identity.bindingId
    ));
    if (matches.length > 0) {
      if (matches.length === 1 && sameIdentity(matches[0]!, identity)) {
        return { binding: matches[0]!, created: false };
      }
      throw new CodexFeedbackBindingConflictError();
    }
    const createdAt = dependencies.clock().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new CodexFeedbackBindingInvalidError();
    }
    const binding: CodexTaskBinding = { ...identity, createdAt };
    state.bindings.push(binding);
    state.bindings.sort((left, right) => left.bindingId.localeCompare(right.bindingId));
    await dependencies.repository.save(state);
    return { binding, created: true };
  });
}
