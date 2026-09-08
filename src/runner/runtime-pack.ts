import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import { redactSecrets } from '../security/redact-secrets.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from '../storage/file-io.js';
import type { ContextBundle } from './context-bundle.js';
import {
  parseSupportedExecutionProfile,
  validateExecutionProfileContext,
  type ExecutionProfile,
} from './execution-profile.js';

export interface RuntimePackBlock {
  label: string;
  kind: ContextBundle['blocks'][number]['kind'];
  category: ContextBundle['blocks'][number]['category'];
  sourceRef: string;
  version: string | null;
  readRef: string;
  sha256: string;
}

export interface RuntimePack {
  schemaVersion: 2;
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
  executionProfile: ExecutionProfile;
  executionProfileSha256: string;
  contextManifestId: string | null;
  contextManifestSha256: string | null;
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

export interface PersistedRuntimePackEvidence {
  pack: RuntimePack;
  sha256: string;
}

export interface PersistRuntimePackOptions {
  task: Task;
  project: Project;
  context: ContextBundle;
  executionProfile: ExecutionProfile;
  contextManifest?: {
    manifestId: string;
    sha256: string;
  };
  asOf: string;
  expiresAt: string;
  continuationOfRunId?: string;
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

export class RuntimePackEvidenceError extends Error {
  readonly code = 'runtime_pack_evidence_invalid';

  constructor() {
    super('Persisted Runtime Pack evidence is missing, malformed, or ambiguous');
    this.name = 'RuntimePackEvidenceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function storageKey(pack: Pick<RuntimePack, 'taskId' | 'runId'>): string {
  return `rpr_${sha256(stableJson({ taskId: pack.taskId, runId: pack.runId })).slice(0, 24)}`;
}

function packBoundary(runtimeRoot: string): StorageReadBoundary {
  const directory = join(runtimeRoot, 'context-packs');
  return {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
}

function runtimePackUnsigned(pack: RuntimePack): Omit<RuntimePack, 'packId'> {
  return Object.fromEntries(
    Object.entries(pack).filter(([key]) => key !== 'packId'),
  ) as Omit<RuntimePack, 'packId'>;
}

export function isValidRuntimePackEvidence(
  evidence: PersistedRuntimePackEvidence,
): boolean {
  try {
    const { pack } = evidence;
    if (
      pack === null
      || typeof pack !== 'object'
      || !Array.isArray(pack.blocks)
      || !Array.isArray(pack.acceptanceCriteria)
      || !Array.isArray(pack.projectContextRefs)
      || !Array.isArray(pack.sourceRefs)
      || !Array.isArray(pack.previousArtifactRefs)
      || !Array.isArray(pack.allowedSources)
      || !Array.isArray(pack.forbiddenSources)
      || !Array.isArray(pack.contextGaps)
    ) return false;
    parseSupportedExecutionProfile(pack.executionProfile);
    const unsigned = runtimePackUnsigned(pack);
    const expectedPackId = `pack-${sha256(stableJson(unsigned)).slice(0, 24)}`;
    const expectedDocumentSha = sha256(`${JSON.stringify(pack, null, 2)}\n`);
    const labels = pack.blocks.map(({ label }) => label);
    return pack.schemaVersion === 2
      && pack.packId === expectedPackId
      && evidence.sha256 === expectedDocumentSha
      && pack.taskId.trim() !== ''
      && pack.runId.trim() !== ''
      && (pack.continuationOfRunId === null || pack.continuationOfRunId.trim() !== '')
      && pack.contextManifestId !== null
      && /^cm_[0-9a-f]{24}$/u.test(pack.contextManifestId)
      && pack.contextManifestSha256 !== null
      && /^[0-9a-f]{64}$/u.test(pack.contextManifestSha256)
      && pack.executionProfileSha256 === sha256(stableJson(pack.executionProfile))
      && new Set(labels).size === labels.length
      && pack.blocks.every((block) => (
        block.label.trim() !== ''
        && block.sourceRef.trim() !== ''
        && block.readRef.trim() !== ''
        && /^[0-9a-f]{64}$/u.test(block.sha256)
      ));
  } catch {
    return false;
  }
}

function parseRuntimePack(raw: string): PersistedRuntimePackEvidence {
  try {
    const pack = JSON.parse(raw) as RuntimePack;
    const evidence = { pack, sha256: sha256(raw) };
    if (!isValidRuntimePackEvidence(evidence)) throw new RuntimePackEvidenceError();
    return evidence;
  } catch (error) {
    if (error instanceof RuntimePackEvidenceError) throw error;
    throw new RuntimePackEvidenceError();
  }
}

async function readRuntimePackAt(
  absolutePath: string,
  boundary: StorageReadBoundary,
): Promise<PersistedRuntimePackEvidence | null> {
  const raw = await readSafeTextFile(absolutePath, boundary);
  return raw === null ? null : parseRuntimePack(raw);
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
    || (
      options.contextManifest !== undefined
      && (
        !/^cm_[0-9a-f]{24}$/u.test(options.contextManifest.manifestId)
        || !/^[0-9a-f]{64}$/u.test(options.contextManifest.sha256)
      )
    )
  ) {
    throw new InvalidRuntimePackInputError();
  }
  const executionProfile = parseSupportedExecutionProfile(options.executionProfile);
  validateExecutionProfileContext(executionProfile, context);
  const includesPreviousArtifact = context.blocks.some((block) => (
    block.kind === 'artifact_review'
  ));
  const previousArtifactRef = includesPreviousArtifact
    ? task.artifactRefs.at(-1)
    : undefined;
  const decisionContinuationOfRunId = task.lastDecision?.continuationRunId === task.claim.runId
    ? task.lastDecision.continuationOfRunId ?? null
    : null;
  if (
    options.continuationOfRunId !== undefined
    && (
      options.continuationOfRunId.trim() === ''
      || !includesPreviousArtifact
      || (
        decisionContinuationOfRunId !== null
        && decisionContinuationOfRunId !== options.continuationOfRunId
      )
    )
  ) throw new InvalidRuntimePackInputError();
  const continuationOfRunId = options.continuationOfRunId
    ?? decisionContinuationOfRunId;
  const unsigned = {
    schemaVersion: 2 as const,
    taskId: task.taskId,
    runId: task.claim?.runId ?? '',
    continuationOfRunId,
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
    executionProfile,
    executionProfileSha256: sha256(stableJson(executionProfile)),
    contextManifestId: options.contextManifest?.manifestId ?? null,
    contextManifestSha256: options.contextManifest?.sha256 ?? null,
    contextGaps: [],
    expiresAt: options.expiresAt,
    blocks: context.blocks.map(({
      label,
      kind,
      category,
      sourceRef,
      version,
      readRef,
      sha256: digest,
    }) => ({
      label,
      kind,
      category,
      sourceRef,
      version,
      readRef,
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
  const absolutePath = join(directory, `${storageKey(pack)}.json`);
  const content = `${JSON.stringify(pack, null, 2)}\n`;
  const boundary = packBoundary(runtimeRoot);
  await writeImmutableJson(absolutePath, content, boundary);
  return { packId: pack.packId, absolutePath, sha256: sha256(content), pack };
}

export async function readRuntimePackForRun(
  runtimeRoot: string,
  taskId: string,
  runId: string,
): Promise<PersistedRuntimePackEvidence | null> {
  if (taskId.trim() === '' || runId.trim() === '') throw new RuntimePackEvidenceError();
  const boundary = packBoundary(runtimeRoot);
  const evidence = await readRuntimePackAt(
    join(boundary.subtree, `${storageKey({ taskId, runId })}.json`),
    boundary,
  );
  if (
    evidence !== null
    && (evidence.pack.taskId !== taskId || evidence.pack.runId !== runId)
  ) throw new RuntimePackEvidenceError();
  return evidence;
}

export async function readRuntimePackById(
  runtimeRoot: string,
  packId: string,
): Promise<PersistedRuntimePackEvidence | null> {
  if (!/^pack-[0-9a-f]{24}$/u.test(packId)) throw new RuntimePackEvidenceError();
  const boundary = packBoundary(runtimeRoot);
  const files = await listSafeRegularFiles(boundary, '*.json');
  const matches: PersistedRuntimePackEvidence[] = [];
  for (const path of files) {
    const evidence = await readRuntimePackAt(path, boundary);
    if (evidence?.pack.packId === packId) matches.push(evidence);
  }
  if (matches.length > 1) throw new RuntimePackEvidenceError();
  return matches[0] ?? null;
}
