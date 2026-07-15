import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { projectSchema, type Project } from '../domain/project.js';
import { taskSchema, type Task } from '../domain/task.js';

export interface ContextBlock {
  label: string;
  kind: 'task' | 'project' | 'local_file' | 'url_reference';
  content: string;
  sha256: string;
}

export interface ContextBundle {
  taskId: string;
  blocks: ContextBlock[];
}

export interface BuildContextBundleOptions {
  allowedLocalRoots: readonly string[];
}

export class ContextBundleError extends Error {
  readonly code:
    | 'invalid_allowed_root'
    | 'invalid_local_file'
    | 'local_file_not_allowed'
    | 'local_file_too_large'
    | 'project_context_mismatch';

  constructor(code: ContextBundleError['code'], message: string) {
    super(message);
    this.name = 'ContextBundleError';
    this.code = code;
  }
}

export const MAX_CONTEXT_FILE_BYTES = 256 * 1024;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /AKIA[0-9A-Z]{16}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /whsec_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi,
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    value,
  );
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function contextBlock(
  label: string,
  kind: ContextBlock['kind'],
  rawContent: string,
): ContextBlock {
  const content = redactSecrets(rawContent);
  return { label, kind, content, sha256: digest(content) };
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
): Promise<string> {
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
    const [metadata, currentCanonicalPath, currentPathMetadata] = await Promise.all([
      handle.stat(),
      realpath(canonicalPath),
      stat(canonicalPath),
    ]);
    if (
      !metadata.isFile()
      || currentCanonicalPath !== canonicalPath
      || !allowedRoots.some((root) => isWithin(root, currentCanonicalPath))
      || metadata.dev !== currentPathMetadata.dev
      || metadata.ino !== currentPathMetadata.ino
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
    return content.toString('utf8');
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
  return [
    'Objective:',
    task.objective ?? '',
    '',
    'Acceptance Criteria:',
    ...criteria,
  ].join('\n');
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
    contextBlock('task', 'task', taskContent(validTask)),
  ];

  if (validTask.sourceNote !== null && validTask.sourceNote.trim() !== '') {
    blocks.push(contextBlock(
      'task_source_note',
      'local_file',
      await readAllowedLocalFile(validTask.sourceNote, allowedRoots),
    ));
  }

  blocks.push(contextBlock('project', 'project', projectContent(validProject)));

  for (const [index, resource] of validProject.resources.entries()) {
    const label = `project_resource_${String(index + 1).padStart(3, '0')}`;
    if (resource.kind === 'local_path') {
      blocks.push(contextBlock(
        label,
        'local_file',
        await readAllowedLocalFile(resource.value, allowedRoots),
      ));
    } else {
      blocks.push(contextBlock(label, 'url_reference', referenceContent(resource)));
    }
  }

  return { taskId: validTask.taskId, blocks };
}
