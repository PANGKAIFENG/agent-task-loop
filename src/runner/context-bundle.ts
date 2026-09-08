import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ContextCategory } from '../domain/context-manifest.js';
import { projectSchema, type Project } from '../domain/project.js';
import { taskSchema, type Task } from '../domain/task.js';
import { redactSecrets } from '../security/redact-secrets.js';
import { sameFileVersion } from '../storage/file-io.js';

export interface ContextBlock {
  label: string;
  kind:
    | 'task'
    | 'project'
    | 'local_file'
    | 'url_reference'
    | 'artifact_review'
    | 'user_context'
    | 'policy'
    | 'feedback';
  category: ContextCategory;
  sourceRef: string;
  version: string | null;
  readRef: string;
  content: string;
  sha256: string;
}

export interface ContextBundle {
  taskId: string;
  packId?: string;
  blocks: ContextBlock[];
}

export interface BuildContextBundleOptions {
  allowedLocalRoots: readonly string[];
  localPathBase?: string;
  includeSourceNote?: boolean;
  selectedProjectResourceIndexes?: readonly number[];
  previousArtifact?: {
    reference: string;
    version: string | null;
    summary: string;
    evidenceCount: number;
  };
  additionalLocalContexts?: readonly AdditionalLocalContext[];
}

function localPath(path: string, base: string | undefined): string {
  return isAbsolute(path) || base === undefined ? path : resolve(base, path);
}

export interface AdditionalLocalContext {
  label: string;
  kind: 'local_file' | 'user_context' | 'policy' | 'feedback';
  category?: ContextCategory;
  path: string;
  sourceRef: string;
  version: string | null;
  expectedSha256?: string;
}

export class ContextBundleError extends Error {
  readonly code:
    | 'invalid_allowed_root'
    | 'invalid_local_file'
    | 'local_file_not_allowed'
    | 'local_file_too_large'
    | 'project_context_mismatch'
    | 'invalid_additional_context';

  constructor(code: ContextBundleError['code'], message: string) {
    super(message);
    this.name = 'ContextBundleError';
    this.code = code;
  }
}

export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;

export function taskContextVersion(
  task: Pick<Task, 'readyAt' | 'updatedAt'>,
): string {
  return task.readyAt !== null && task.readyAt.trim() !== ''
    ? task.readyAt
    : task.updatedAt;
}

export function taskDispatchContentSha256(task: Task): string {
  const validTask = taskSchema.parse(task);
  return digest(JSON.stringify({
    schemaVersion: validTask.schemaVersion,
    taskId: validTask.taskId,
    title: validTask.title,
    body: validTask.body,
    status: validTask.status,
    reviewState: validTask.reviewState,
    projectId: validTask.projectId,
    taskType: validTask.taskType,
    objective: validTask.objective,
    acceptanceCriteria: validTask.acceptanceCriteria,
    autoExecutable: validTask.autoExecutable,
    permissionProfile: validTask.permissionProfile,
    executionTarget: validTask.executionTarget ?? null,
    contextRefs: validTask.contextRefs ?? [],
    origin: validTask.origin,
    sourceDate: validTask.sourceDate,
    sourceNote: validTask.sourceNote,
    sourceQuote: validTask.sourceQuote,
    sourceKey: validTask.sourceKey,
    priority: validTask.priority,
    reviewFeedback: validTask.reviewFeedback,
    lastDecision: validTask.lastDecision ?? null,
  }));
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function contextBlock(
  label: string,
  kind: ContextBlock['kind'],
  category: ContextCategory,
  sourceRef: string,
  version: string | null,
  rawContent: string,
  readRef: string = sourceRef,
): ContextBlock {
  const content = redactSecrets(rawContent);
  const safeSourceRef = redactSecrets(sourceRef);
  const safeReadRef = redactSecrets(readRef);
  return {
    label,
    kind,
    category,
    sourceRef: safeSourceRef,
    version,
    readRef: safeReadRef,
    content,
    sha256: digest(content),
  };
}

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function canonicalAllowedRoots(roots: readonly string[]): Promise<string[]> {
  try {
    return await Promise.all(roots.map(async (root) => {
      const canonical = await realpath(root);
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) {
        throw new Error('Allowed root is not a directory');
      }
      return canonical;
    }));
  } catch {
    throw new ContextBundleError(
      'invalid_allowed_root',
      'An allowed local root is missing or is not a directory',
    );
  }
}

async function readAllowedLocalFile(
  path: string,
  allowedRoots: string[],
): Promise<{ content: string; readRef: string }> {
  let handle: FileHandle | undefined;
  let canonicalPath: string;
  try {
    const referencedMetadata = await lstat(path);
    if (!referencedMetadata.isFile() && !referencedMetadata.isSymbolicLink()) {
      throw new ContextBundleError(
        'invalid_local_file',
        'An explicitly referenced local path is not a safe regular file',
      );
    }
    canonicalPath = await realpath(path);
    const canonicalMetadata = await lstat(canonicalPath);
    if (!canonicalMetadata.isFile()) {
      throw new ContextBundleError(
        'invalid_local_file',
        'An explicitly referenced local path is not a safe regular file',
      );
    }
  } catch (error) {
    if (error instanceof ContextBundleError) {
      throw error;
    }
    throw new ContextBundleError(
      'invalid_local_file',
      'An explicitly referenced local file is missing or unsafe',
    );
  }

  if (!allowedRoots.some((root) => isWithin(root, canonicalPath))) {
    throw new ContextBundleError(
      'local_file_not_allowed',
      'An explicitly referenced local file is outside allowed roots',
    );
  }

  try {
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const [
      metadata,
      currentReferencedCanonicalPath,
      currentReferencedMetadata,
      currentCanonicalPath,
      currentCanonicalMetadata,
    ] = await Promise.all([
      handle.stat(),
      realpath(path),
      stat(path),
      realpath(canonicalPath),
      stat(canonicalPath),
    ]);
    if (
      !metadata.isFile()
      || currentReferencedCanonicalPath !== canonicalPath
      || currentCanonicalPath !== canonicalPath
      || !allowedRoots.some((root) => isWithin(root, currentCanonicalPath))
      || !sameFileVersion(metadata, currentReferencedMetadata)
      || !sameFileVersion(metadata, currentCanonicalMetadata)
    ) {
      throw new ContextBundleError(
        'invalid_local_file',
        'An explicitly referenced local path is not a safe regular file',
      );
    }
    if (metadata.size > MAX_CONTEXT_FILE_BYTES) {
      throw new ContextBundleError(
        'local_file_too_large',
        'An explicitly referenced local file exceeds 256 KiB',
      );
    }

    const content = await handle.readFile();
    if (content.byteLength > MAX_CONTEXT_FILE_BYTES) {
      throw new ContextBundleError(
        'local_file_too_large',
        'An explicitly referenced local file exceeds 256 KiB',
      );
    }
    const [
      finalMetadata,
      finalReferencedCanonicalPath,
      finalReferencedMetadata,
      finalCanonicalPath,
      finalCanonicalMetadata,
    ] = await Promise.all([
      handle.stat(),
      realpath(path),
      stat(path),
      realpath(canonicalPath),
      stat(canonicalPath),
    ]);
    if (
      finalReferencedCanonicalPath !== canonicalPath
      || finalCanonicalPath !== canonicalPath
      || !allowedRoots.some((root) => isWithin(root, finalCanonicalPath))
      || !sameFileVersion(metadata, finalMetadata)
      || !sameFileVersion(metadata, finalReferencedMetadata)
      || !sameFileVersion(metadata, finalCanonicalMetadata)
    ) {
      throw new ContextBundleError(
        'invalid_local_file',
        'An explicitly referenced local file changed while it was being read',
      );
    }
    return {
      content: content.toString('utf8'),
      readRef: pathToFileURL(canonicalPath).href,
    };
  } catch (error) {
    if (error instanceof ContextBundleError) {
      throw error;
    }
    throw new ContextBundleError(
      'invalid_local_file',
      'An explicitly referenced local file is missing or unsafe',
    );
  } finally {
    await handle?.close();
  }
}

function taskContent(task: Task): string {
  const criteria = task.acceptanceCriteria.map((criterion) => `- ${criterion}`);
  const content = [
    'Objective:',
    task.objective ?? '',
    '',
    'Acceptance Criteria:',
    ...criteria,
  ];
  if (task.body.trim() !== '') {
    content.push('', 'Task Body:', task.body);
  }
  if (task.sourceQuote !== null && task.sourceQuote.trim() !== '') {
    content.push('', 'Source Quote:', task.sourceQuote);
  }
  if (task.lastDecision !== null && task.lastDecision !== undefined) {
    content.push(
      '',
      'Latest User Decision:',
      `Request ID: ${task.lastDecision.requestId}`,
      `Selected Option: ${task.lastDecision.selectedOptionLabel}`,
      `Selected Option ID: ${task.lastDecision.selectedOptionId}`,
      `Response: ${task.lastDecision.responseText ?? ''}`,
    );
  }
  if (task.reviewFeedback !== null && task.reviewFeedback.trim() !== '') {
    content.push('', 'Review Feedback:', task.reviewFeedback);
  }
  return content.join('\n');
}

function projectContent(project: Project): string {
  return ['Description:', project.description].join('\n');
}

function referenceContent(
  resource: Project['resources'][number],
): string {
  return [
    `Label: ${resource.label}`,
    `Kind: ${resource.kind}`,
    `Reference: ${resource.value}`,
  ].join('\n');
}

function previousArtifactContent(
  artifact: NonNullable<BuildContextBundleOptions['previousArtifact']>,
): string {
  return [
    `Reference: ${artifact.reference}`,
    `Summary: ${artifact.summary}`,
    `Evidence Count: ${artifact.evidenceCount}`,
  ].join('\n');
}

function validateAdditionalContexts(
  contexts: readonly AdditionalLocalContext[],
  reservedLabels: Set<string>,
): void {
  for (const context of contexts) {
    if (
      !/^[a-z][a-z0-9_]{0,99}$/u.test(context.label)
      || context.path.trim() === ''
      || context.sourceRef.trim() === ''
      || (context.version !== null && context.version.trim() === '')
      || (context.expectedSha256 !== undefined
        && !/^[0-9a-f]{64}$/u.test(context.expectedSha256))
      || reservedLabels.has(context.label)
      || (context.kind === 'local_file' && context.category !== 'source')
      || (context.kind !== 'local_file'
        && context.category !== undefined
        && context.category !== context.kind)
    ) {
      throw new ContextBundleError(
        'invalid_additional_context',
        'Dynamically selected context must have a unique safe label and explicit path',
      );
    }
    reservedLabels.add(context.label);
  }
}

export async function buildContextBundle(
  task: Task,
  project: Project,
  options: BuildContextBundleOptions,
): Promise<ContextBundle> {
  const validTask = taskSchema.parse(task);
  const validProject = projectSchema.parse(project);
  if (
    validTask.projectId === null
    || validTask.projectId.trim() === ''
    || validProject.projectId.trim() === ''
    || validTask.projectId !== validProject.projectId
  ) {
    throw new ContextBundleError(
      'project_context_mismatch',
      'Task and project context do not match',
    );
  }
  const allowedRoots = await canonicalAllowedRoots(options.allowedLocalRoots);
  const blocks: ContextBlock[] = [
    contextBlock(
      'task',
      'task',
      'task',
      `task://${validTask.taskId}`,
      taskContextVersion(validTask),
      taskContent(validTask),
    ),
  ];

  if (options.previousArtifact !== undefined) {
    blocks.push(contextBlock(
      'previous_artifact',
      'artifact_review',
      'artifact',
      options.previousArtifact.reference,
      options.previousArtifact.version,
      previousArtifactContent(options.previousArtifact),
    ));
  }

  if (
    options.includeSourceNote !== false
    && validTask.sourceNote !== null
    && validTask.sourceNote.trim() !== ''
  ) {
    const sourceNote = await readAllowedLocalFile(
      localPath(validTask.sourceNote, options.localPathBase),
      allowedRoots,
    );
    blocks.push(contextBlock(
      'task_source_note',
      'local_file',
      'source',
      sourceNote.readRef,
      null,
      sourceNote.content,
      sourceNote.readRef,
    ));
  }

  blocks.push(contextBlock(
    'project',
    'project',
    'project',
    `atl-project://${validProject.projectId}`,
    validProject.updatedAt,
    projectContent(validProject),
  ));

  const selectedProjectResourceIndexes = options.selectedProjectResourceIndexes === undefined
    ? null
    : new Set(options.selectedProjectResourceIndexes);
  for (const [index, resource] of validProject.resources.entries()) {
    if (selectedProjectResourceIndexes !== null && !selectedProjectResourceIndexes.has(index)) {
      continue;
    }
    const label = `project_resource_${String(index + 1).padStart(3, '0')}`;
    if (resource.kind === 'local_path') {
      const localResource = await readAllowedLocalFile(
        localPath(resource.value, options.localPathBase),
        allowedRoots,
      );
      blocks.push(contextBlock(
        label,
        'local_file',
        'source',
        localResource.readRef,
        validProject.updatedAt,
        localResource.content,
        localResource.readRef,
      ));
    } else {
      blocks.push(contextBlock(
        label,
        'url_reference',
        'source',
        resource.value,
        validProject.updatedAt,
        referenceContent(resource),
      ));
    }
  }

  const additionalLocalContexts = options.additionalLocalContexts ?? [];
  validateAdditionalContexts(
    additionalLocalContexts,
    new Set(blocks.map(({ label }) => label)),
  );
  for (const context of additionalLocalContexts) {
    const localContext = await readAllowedLocalFile(
      localPath(context.path, options.localPathBase),
      allowedRoots,
    );
    if (
      context.expectedSha256 !== undefined
      && digest(localContext.content) !== context.expectedSha256
    ) {
      throw new ContextBundleError(
        'invalid_additional_context',
        'Feedback context no longer matches the selected document version',
      );
    }
    blocks.push(contextBlock(
      context.label,
      context.kind,
      context.category ?? (context.kind === 'local_file' ? 'source' : context.kind),
      context.sourceRef,
      context.version,
      localContext.content,
      localContext.readRef,
    ));
  }

  return { taskId: validTask.taskId, blocks };
}
