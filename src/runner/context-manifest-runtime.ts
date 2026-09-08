import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  buildContextManifest,
  isValidContextManifest,
  type BuildContextManifestInput,
  type ContextManifest,
} from '../domain/context-manifest.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from '../storage/file-io.js';

export interface PersistedContextManifest {
  manifest: ContextManifest;
  absolutePath: string;
  documentSha256: string;
}

export class ContextManifestRuntimeConflictError extends Error {
  readonly code = 'context_manifest_runtime_conflict';

  constructor() {
    super('Context Manifest already exists with different contents');
    this.name = 'ContextManifestRuntimeConflictError';
  }
}

export class ContextManifestBlockedError extends Error {
  readonly code = 'context_manifest_blocked';

  constructor() {
    super('Context Manifest contains unresolved consumption evidence');
    this.name = 'ContextManifestBlockedError';
  }
}

export class ContextManifestRuntimeEvidenceError extends Error {
  readonly code = 'context_manifest_runtime_evidence_invalid';

  constructor() {
    super('Persisted Context Manifest evidence is missing, malformed, or ambiguous');
    this.name = 'ContextManifestRuntimeEvidenceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function storageKey(input: Pick<BuildContextManifestInput, 'taskId' | 'runId'>): string {
  const digest = sha256(JSON.stringify({ taskId: input.taskId, runId: input.runId }));
  return `cmr_${digest.slice(0, 24)}`;
}

function manifestBoundary(runtimeRoot: string): StorageReadBoundary {
  const directory = join(runtimeRoot, 'context-manifests');
  return {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
}

function parseManifest(raw: string): ContextManifest {
  try {
    const candidate = JSON.parse(raw) as ContextManifest;
    if (!isValidContextManifest(candidate)) {
      throw new ContextManifestRuntimeEvidenceError();
    }
    return candidate;
  } catch (error) {
    if (error instanceof ContextManifestRuntimeEvidenceError) throw error;
    throw new ContextManifestRuntimeEvidenceError();
  }
}

async function readManifestAt(
  absolutePath: string,
  boundary: StorageReadBoundary,
): Promise<ContextManifest | null> {
  const raw = await readSafeTextFile(absolutePath, boundary);
  return raw === null ? null : parseManifest(raw);
}

export async function persistContextManifest(
  runtimeRoot: string,
  input: BuildContextManifestInput,
): Promise<PersistedContextManifest> {
  const manifest = buildContextManifest(input);
  const directory = join(runtimeRoot, 'context-manifests');
  const absolutePath = join(directory, `${storageKey(input)}.json`);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const boundary = manifestBoundary(runtimeRoot);
  const created = await atomicCreateTextFile(absolutePath, content, boundary);
  if (!created) {
    const existing = await readSafeTextFile(absolutePath, boundary);
    if (existing !== content) throw new ContextManifestRuntimeConflictError();
  }
  return {
    manifest,
    absolutePath,
    documentSha256: sha256(content),
  };
}

export async function readContextManifestForRun(
  runtimeRoot: string,
  taskId: string,
  runId: string,
): Promise<ContextManifest | null> {
  if (taskId.trim() === '' || runId.trim() === '') {
    throw new ContextManifestRuntimeEvidenceError();
  }
  const boundary = manifestBoundary(runtimeRoot);
  const manifest = await readManifestAt(
    join(boundary.subtree, `${storageKey({ taskId, runId })}.json`),
    boundary,
  );
  if (
    manifest !== null
    && (manifest.taskId !== taskId || manifest.runId !== runId)
  ) throw new ContextManifestRuntimeEvidenceError();
  return manifest;
}

export async function readContextManifestById(
  runtimeRoot: string,
  manifestId: string,
): Promise<ContextManifest | null> {
  if (!/^cm_[0-9a-f]{24}$/u.test(manifestId)) {
    throw new ContextManifestRuntimeEvidenceError();
  }
  const boundary = manifestBoundary(runtimeRoot);
  const files = await listSafeRegularFiles(boundary, '*.json');
  const matches: ContextManifest[] = [];
  for (const path of files) {
    const manifest = await readManifestAt(path, boundary);
    if (manifest?.manifestId === manifestId) matches.push(manifest);
  }
  if (matches.length > 1) throw new ContextManifestRuntimeEvidenceError();
  return matches[0] ?? null;
}
