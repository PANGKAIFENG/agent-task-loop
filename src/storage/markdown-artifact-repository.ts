import { createHash } from 'node:crypto';
import { join } from 'node:path';

import YAML from 'yaml';

import { artifactResultSchema } from '../domain/artifact.js';
import type { ArtifactRepository } from './contracts.js';
import {
  atomicCreateTextFile,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import { parseTaskDocument } from './frontmatter.js';
import {
  artifactDirectory,
  assertVaultWriteAllowed,
  isSafePathSegment,
  taskStorageRoot,
  vaultRoot,
} from './task-paths.js';

export class InvalidArtifactInputError extends Error {
  readonly code = 'invalid_artifact_input';

  constructor() {
    super('Invalid Artifact input');
    this.name = 'InvalidArtifactInputError';
  }
}

export class ArtifactAlreadyExistsError extends Error {
  readonly code = 'artifact_already_exists';

  constructor() {
    super('Artifact attempt already exists');
    this.name = 'ArtifactAlreadyExistsError';
  }
}

export class InvalidArtifactReferenceError extends Error {
  readonly code = 'invalid_artifact_reference';

  constructor() {
    super('Invalid Artifact reference');
    this.name = 'InvalidArtifactReferenceError';
  }
}

export class ArtifactNotFoundError extends Error {
  readonly code = 'artifact_not_found';

  constructor() {
    super('Artifact not found');
    this.name = 'ArtifactNotFoundError';
  }
}

function markdownText(value: string): string {
  return value.replaceAll('|', '\\|');
}

function escapeCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function isValidMetadata(value: string): boolean {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= 200
    && !/[\0\r\n]/.test(value);
}

function bulletList(items: string[]): string {
  return items.length === 0
    ? '_None._'
    : items.map((item) => `- ${markdownText(item)}`).join('\n');
}

function artifactInputDigest(
  input: Parameters<ArtifactRepository['write']>[0],
): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: input.task.taskId,
    attempt: input.task.attempts,
    runId: input.runId,
    agent: input.agent,
    result: input.result,
  })).digest('hex');
}

function hasMatchingArtifactMetadata(
  data: Record<string, unknown>,
  input: Parameters<ArtifactRepository['write']>[0],
  inputDigest: string,
): boolean {
  return data.type === 'artifact'
    && data.schema_version === 1
    && data.task_id === input.task.taskId
    && data.run_id === input.runId
    && data.attempt === input.task.attempts
    && data.agent === input.agent
    && data.summary === input.result.summary
    && data.evidence_count === input.result.evidence.length
    && data.input_digest === inputDigest
    && typeof data.created_at === 'string'
    && Number.isFinite(Date.parse(data.created_at))
    && data.updated_at === data.created_at;
}

function renderArtifact(
  input: Parameters<ArtifactRepository['write']>[0],
  inputDigest: string,
): string {
  const frontmatter = YAML.stringify({
    type: 'artifact',
    schema_version: 1,
    task_id: input.task.taskId,
    run_id: input.runId,
    attempt: input.task.attempts,
    agent: input.agent,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    summary: input.result.summary,
    evidence_count: input.result.evidence.length,
    input_digest: inputDigest,
  });
  const evidence = input.result.evidence.length === 0
    ? '_None._'
    : [
        '| Title | URL | Accessed At |',
        '| --- | --- | --- |',
        ...input.result.evidence.map((item) => (
          `| ${[
            item.title,
            item.url,
            item.accessedAt,
          ].map(escapeCell).join(' | ')} |`
        )),
      ].join('\n');
  const acceptance = input.result.acceptance.length === 0
    ? '_None._'
    : [
        '| Criterion | Status | Note |',
        '| --- | --- | --- |',
        ...input.result.acceptance.map((item) => (
          `| ${[
            item.criterion,
            item.status,
            item.note,
          ].map(escapeCell).join(' | ')} |`
        )),
      ].join('\n');

  return [
    '---',
    frontmatter.trimEnd(),
    '---',
    '',
    '## Summary',
    '',
    input.result.summary,
    '',
    '## Findings',
    '',
    bulletList(input.result.findings),
    '',
    '## Evidence',
    '',
    evidence,
    '',
    '## Uncertainties',
    '',
    bulletList(input.result.uncertainties),
    '',
    '## Recommended Actions',
    '',
    bulletList(input.result.recommendedActions),
    '',
    '## Acceptance Criteria',
    '',
    acceptance,
    '',
  ].join('\n');
}

function artifactRefParts(ref: string): { taskId: string; filename: string } | null {
  const match = /^Artifacts\/([^/]+)\/(attempt-\d{3,}\.md)$/.exec(ref);
  if (
    match === null
    || match[1] === undefined
    || match[2] === undefined
    || !isSafePathSegment(match[1])
  ) {
    return null;
  }
  return { taskId: match[1], filename: match[2] };
}

export class MarkdownArtifactRepository implements ArtifactRepository {
  readonly root: string;
  readonly tasksRoot: string;

  constructor(root?: string) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
  }

  async write(
    input: Parameters<ArtifactRepository['write']>[0],
  ): Promise<{ ref: string; absolutePath: string }> {
    assertVaultWriteAllowed(this.root);
    const parsed = artifactResultSchema.safeParse(input.result);
    if (
      !parsed.success
      || !isSafePathSegment(input.task.taskId)
      || !isValidMetadata(input.runId)
      || !isValidMetadata(input.agent)
      || !Number.isInteger(input.task.attempts)
      || input.task.attempts <= 0
      || !Number.isFinite(Date.parse(input.createdAt))
    ) {
      throw new InvalidArtifactInputError();
    }
    const directory = artifactDirectory(this.root, input.task.taskId);
    const filename = `attempt-${String(input.task.attempts).padStart(3, '0')}.md`;
    const absolutePath = join(directory, filename);
    const ref = `Artifacts/${input.task.taskId}/${filename}`;
    const normalizedInput = { ...input, result: parsed.data };
    const inputDigest = artifactInputDigest(normalizedInput);
    const created = await atomicCreateTextFile(
      absolutePath,
      renderArtifact(normalizedInput, inputDigest),
      this.readBoundary(directory),
    );
    if (!created) {
      const existing = await readSafeTextFile(
        absolutePath,
        this.readBoundary(directory),
      );
      if (existing !== null) {
        try {
          const data = parseTaskDocument(existing).data;
          if (hasMatchingArtifactMetadata(data, normalizedInput, inputDigest)) {
            return { ref, absolutePath };
          }
        } catch {
          // A malformed create-only Artifact remains a conflict.
        }
      }
      throw new ArtifactAlreadyExistsError();
    }
    return { ref, absolutePath };
  }

  async readSummary(ref: string): Promise<{ summary: string; evidenceCount: number }> {
    const parts = artifactRefParts(ref);
    if (parts === null) {
      throw new InvalidArtifactReferenceError();
    }
    const directory = artifactDirectory(this.root, parts.taskId);
    const raw = await readSafeTextFile(
      join(directory, parts.filename),
      this.readBoundary(directory),
    );
    if (raw === null) {
      throw new ArtifactNotFoundError();
    }
    const data = parseTaskDocument(raw).data;
    if (
      data.type !== 'artifact'
      || typeof data.summary !== 'string'
      || typeof data.evidence_count !== 'number'
      || !Number.isInteger(data.evidence_count)
      || data.evidence_count < 0
    ) {
      throw new InvalidArtifactReferenceError();
    }
    return { summary: data.summary, evidenceCount: data.evidence_count };
  }

  private readBoundary(directory: string): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: directory,
    };
  }
}
