import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import { redactSecrets } from '../security/redact-secrets.js';
import {
  atomicCreateTextFile,
  readSafeTextFile,
  type StorageReadBoundary,
} from '../storage/file-io.js';
import type { ContextBundle } from './context-bundle.js';

export interface RuntimePackBlock {
  label: string;
  kind: ContextBundle['blocks'][number]['kind'];
  sha256: string;
}

export interface RuntimePack {
  schemaVersion: 1;
  packId: string;
  taskId: string;
  runId: string;
  continuationOfRunId: string | null;
  stateVersion: string;
  asOf: string;
  objective: string;
  expectedArtifact: 'research_result';
  acceptanceCriteria: string[];
  projectContextRefs: string[];
  sourceRefs: string[];
  previousArtifactRefs: string[];
  reviewFeedbackSha256: string | null;
  allowedSources: string[];
  forbiddenSources: string[];
  permissionProfile: Task['permissionProfile'];
  contextGaps: string[];
  expiresAt: string;
  blocks: RuntimePackBlock[];
}

export interface PersistRuntimePackResult {
  packId: string;
  absolutePath: string;
  sha256: string;
  pack: RuntimePack;
}

export interface PersistRuntimePackOptions {
  task: Task;
  project: Project;
  context: ContextBundle;
  asOf: string;
  expiresAt: string;
}

export class RuntimePackConflictError extends Error {
  readonly code = 'runtime_pack_conflict';

  constructor() {
    super('Runtime Pack already exists with different contents');
    this.name = 'RuntimePackConflictError';
  }
}

export class InvalidRuntimePackInputError extends Error {
  readonly code = 'invalid_runtime_pack_input';

  constructor() {
    super('Runtime Pack input does not describe one claimed task run');
    this.name = 'InvalidRuntimePackInputError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sourceRefs(task: Task, project: Project): string[] {
  const refs: string[] = [];
  if (task.sourceNote !== null && task.sourceNote.trim() !== '') {
    refs.push(`task_source_note:${redactSecrets(task.sourceNote)}`);
  }
  project.resources.forEach((resource, index) => {
    const label = `project_resource_${String(index + 1).padStart(3, '0')}`;
    refs.push(`${label}:${resource.kind}:${redactSecrets(resource.value)}`);
  });
  return refs;
}

function createRuntimePack(options: PersistRuntimePackOptions): RuntimePack {
  const { task, project, context } = options;
  if (
    task.claim === null
    || task.claim.runId.trim() === ''
    || task.taskId !== context.taskId
    || task.projectId !== project.projectId
    || !Number.isFinite(Date.parse(options.asOf))
    || !Number.isFinite(Date.parse(options.expiresAt))
    || options.expiresAt !== task.claim.leaseExpiresAt
  ) {
    throw new InvalidRuntimePackInputError();
  }
  const includesPreviousArtifact = context.blocks.some((block) => (
    block.kind === 'artifact_review'
  ));
  const previousArtifactRef = includesPreviousArtifact
    ? task.artifactRefs.at(-1)
    : undefined;
  const unsigned = {
    schemaVersion: 1 as const,
    taskId: task.taskId,
    runId: task.claim?.runId ?? '',
    continuationOfRunId: task.lastDecision?.continuationOfRunId ?? null,
    stateVersion: task.updatedAt,
    asOf: options.asOf,
    objective: redactSecrets(task.objective ?? ''),
    expectedArtifact: 'research_result' as const,
    acceptanceCriteria: task.acceptanceCriteria.map((criterion) => redactSecrets(criterion)),
    projectContextRefs: [`project:${project.projectId}@${project.updatedAt}`],
    sourceRefs: sourceRefs(task, project),
    previousArtifactRefs: previousArtifactRef === undefined ? [] : [previousArtifactRef],
    reviewFeedbackSha256: task.reviewFeedback === null
      ? null
      : sha256(redactSecrets(task.reviewFeedback)),
    allowedSources: ['task', 'project', 'explicit_local_files', 'public_urls'],
    forbiddenSources: [
      'authenticated_content',
      'third_party_messages',
      'calendar_mutations',
      'configuration_writes',
    ],
    permissionProfile: task.permissionProfile,
    contextGaps: [],
    expiresAt: options.expiresAt,
    blocks: context.blocks.map(({ label, kind, sha256: digest }) => ({
      label,
      kind,
      sha256: digest,
    })),
  };
  const packId = `pack-${sha256(stableJson(unsigned)).slice(0, 24)}`;
  return { ...unsigned, packId };
}

async function writeImmutableJson(
  path: string,
  content: string,
  boundary: StorageReadBoundary,
): Promise<void> {
  const created = await atomicCreateTextFile(path, content, boundary);
  if (!created) {
    const existing = await readSafeTextFile(path, boundary);
    if (existing !== content) throw new RuntimePackConflictError();
  }
}

export async function persistRuntimePack(
  runtimeRoot: string,
  options: PersistRuntimePackOptions,
): Promise<PersistRuntimePackResult> {
  const pack = createRuntimePack(options);
  const directory = join(runtimeRoot, 'context-packs');
  const absolutePath = join(directory, `${pack.packId}.json`);
  const content = `${JSON.stringify(pack, null, 2)}\n`;
  const boundary = {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
  await writeImmutableJson(absolutePath, content, boundary);
  return { packId: pack.packId, absolutePath, sha256: sha256(content), pack };
}
