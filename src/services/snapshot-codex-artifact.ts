import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  codexArtifactSnapshotId,
  type CodexArtifactSnapshot,
  type CodexTaskBinding,
} from '../domain/codex-feedback.js';
import { sameFileVersion } from '../storage/file-io.js';
import type { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const inputSchema = z.object({
  bindingId: z.string().regex(/^cb_[0-9a-f]{24}$/u),
  artifactVersion: z.number().int().positive(),
}).strict();

export type SnapshotCodexArtifactInput = z.input<typeof inputSchema>;

export class CodexFeedbackArtifactInvalidError extends Error {
  readonly code = 'codex_feedback_artifact_invalid';

  constructor() {
    super('Bound Codex Artifact is missing, unsafe, or invalid');
    this.name = 'CodexFeedbackArtifactInvalidError';
  }
}

export class CodexFeedbackArtifactVersionConflictError extends Error {
  readonly code = 'codex_feedback_artifact_version_conflict';

  constructor() {
    super('Codex Artifact version is already frozen with different content');
    this.name = 'CodexFeedbackArtifactVersionConflictError';
  }
}

export interface SnapshotCodexArtifactDependencies {
  repository: FileCodexFeedbackStateRepository;
  clock: () => Date;
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

export async function readBoundCodexArtifact(
  binding: CodexTaskBinding,
): Promise<{ sha256: string; bytes: number }> {
  let handle: FileHandle | undefined;
  try {
    const boundRoot = resolve(binding.artifactRoot);
    const rootPathMetadata = await lstat(boundRoot);
    const canonicalRoot = await realpath(binding.artifactRoot);
    const rootMetadata = await stat(canonicalRoot);
    const pathMetadata = await lstat(binding.artifactPath);
    if (
      rootPathMetadata.isSymbolicLink()
      || !rootPathMetadata.isDirectory()
      || canonicalRoot !== boundRoot
      || !rootMetadata.isDirectory()
      || pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.size > MAX_ARTIFACT_BYTES
    ) {
      throw new CodexFeedbackArtifactInvalidError();
    }
    const canonicalPath = await realpath(binding.artifactPath);
    if (
      canonicalPath !== resolve(binding.artifactPath)
      || !isWithin(canonicalRoot, canonicalPath)
    ) {
      throw new CodexFeedbackArtifactInvalidError();
    }
    handle = await open(
      binding.artifactPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile()
      || openedMetadata.size > MAX_ARTIFACT_BYTES
      || !sameFileVersion(openedMetadata, pathMetadata)
    ) {
      throw new CodexFeedbackArtifactInvalidError();
    }
    const content = await handle.readFile();
    const [
      finalRootMetadata,
      finalCanonicalRoot,
      finalOpenedMetadata,
      finalMetadata,
      finalCanonicalPath,
    ] = await Promise.all([
      lstat(boundRoot),
      realpath(boundRoot),
      handle.stat(),
      lstat(binding.artifactPath),
      realpath(binding.artifactPath),
    ]);
    if (
      content.byteLength > MAX_ARTIFACT_BYTES
      || finalRootMetadata.isSymbolicLink()
      || !finalRootMetadata.isDirectory()
      || finalRootMetadata.dev !== rootPathMetadata.dev
      || finalRootMetadata.ino !== rootPathMetadata.ino
      || finalCanonicalRoot !== canonicalRoot
      || !sameFileVersion(openedMetadata, finalOpenedMetadata)
      || finalMetadata.isSymbolicLink()
      || !finalMetadata.isFile()
      || !sameFileVersion(openedMetadata, finalMetadata)
      || finalCanonicalPath !== canonicalPath
      || !isWithin(canonicalRoot, finalCanonicalPath)
    ) {
      throw new CodexFeedbackArtifactInvalidError();
    }
    return {
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
    };
  } catch (error) {
    if (error instanceof CodexFeedbackArtifactInvalidError) throw error;
    throw new CodexFeedbackArtifactInvalidError();
  } finally {
    await handle?.close();
  }
}

export async function snapshotCodexArtifact(
  dependencies: SnapshotCodexArtifactDependencies,
  input: SnapshotCodexArtifactInput,
): Promise<{ snapshot: CodexArtifactSnapshot; created: boolean }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CodexFeedbackArtifactInvalidError();
  return dependencies.repository.withLock(async () => {
    const state = await dependencies.repository.read();
    const binding = state.bindings.find((candidate) => (
      candidate.bindingId === parsed.data.bindingId
    ));
    if (binding === undefined) throw new CodexFeedbackArtifactInvalidError();
    return dependencies.repository.withArtifactLock(binding.artifactPath, async () => {
      const artifact = await readBoundCodexArtifact(binding);
      const existing = state.artifactSnapshots.find((candidate) => (
        candidate.bindingId === binding.bindingId
        && candidate.artifactVersion === parsed.data.artifactVersion
      ));
      if (existing !== undefined) {
        if (existing.artifactSha256 !== artifact.sha256) {
          throw new CodexFeedbackArtifactVersionConflictError();
        }
        return { snapshot: existing, created: false };
      }
      const capturedAt = dependencies.clock().toISOString();
      if (!Number.isFinite(Date.parse(capturedAt))) {
        throw new CodexFeedbackArtifactInvalidError();
      }
      const snapshot: CodexArtifactSnapshot = {
        snapshotId: codexArtifactSnapshotId(
          binding.bindingId,
          parsed.data.artifactVersion,
        ),
        bindingId: binding.bindingId,
        artifactVersion: parsed.data.artifactVersion,
        artifactSha256: artifact.sha256,
        capturedAt,
      };
      state.artifactSnapshots.push(snapshot);
      state.artifactSnapshots.sort((left, right) => (
        left.snapshotId.localeCompare(right.snapshotId)
      ));
      await dependencies.repository.save(state);
      return { snapshot, created: true };
    });
  });
}
