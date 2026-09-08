import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ContextCandidate, ContextCategory } from '../domain/context-manifest.js';
import type { Project } from '../domain/project.js';
import type { Task } from '../domain/task.js';
import type { AdditionalLocalContext } from '../runner/context-bundle.js';
import {
  MAX_CONTEXT_FILE_BYTES,
  taskContextVersion,
} from '../runner/context-bundle.js';
import type { ResearchContextDiscovery } from './dispatch-research-task.js';

export interface DiscoverResearchContextOptions {
  vaultRoot: string;
  allowedLocalRoots: readonly string[];
  maxLocalFiles?: number;
  maxTotalBytes?: number;
}

interface LocalCandidate {
  candidateId: string;
  path: string;
  sourceRef: string;
  version: string | null;
  sizeBytes: number | null;
  selectionReason: string;
  priority: number;
  relevanceScore: number;
  explicit: boolean;
  required: boolean;
  kind: AdditionalLocalContext['kind'];
  category: ContextCategory;
  fixedBlockLabel?: string;
  projectResourceIndex?: number;
}

const SUPPORTED_EXTENSIONS = /\.(?:html?|json|md|txt|ya?ml)$/iu;
const DEFAULT_MAX_LOCAL_FILES = 12;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_DISCOVERED_FILES = 200;

function isWithin(parent: string, target: string): boolean {
  const difference = relative(parent, target);
  return difference === ''
    || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(roots.map((root) => realpath(root)));
}

async function inspectLocalPath(
  rawPath: string,
  roots: readonly string[],
  vaultRoot: string,
): Promise<{ path: string; sourceRef: string; version: string; sizeBytes: number } | null> {
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [resolve(vaultRoot, rawPath), ...roots.map((root) => resolve(root, rawPath))];
  const matches = new Map<string, { version: string; sizeBytes: number }>();
  for (const candidate of candidates) {
    try {
      const pathMetadata = await lstat(candidate);
      if (!pathMetadata.isFile() && !pathMetadata.isSymbolicLink()) continue;
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile() || !roots.some((root) => isWithin(root, canonical))) continue;
      matches.set(canonical, {
        version: metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
      });
    } catch {
      // Missing candidates remain visible through their unresolved explicit ref.
    }
  }
  if (matches.size !== 1) return null;
  const [path, metadata] = [...matches.entries()][0]!;
  return {
    path,
    sourceRef: pathToFileURL(path).href,
    version: metadata.version,
    sizeBytes: metadata.sizeBytes,
  };
}

async function listContextFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    if (files.length >= MAX_DISCOVERED_FILES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_DISCOVERED_FILES || entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.test(entry.name)) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

function previousDate(sourceDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sourceDate)) return null;
  const date = new Date(`${sourceDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function relevance(path: string, task: Task, project: Project): number {
  const haystack = path.normalize('NFKC').toLocaleLowerCase();
  const tokens = [task.title, task.objective ?? '', task.body, project.name]
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .split(/[\s,.;:!?，。；：！？()[\]{}<>《》"'/_-]+/u)
    .filter((token) => token.length >= 2);
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function stableId(prefix: string, path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function unresolvedRef(rawPath: string, vaultRoot: string): string {
  return pathToFileURL(isAbsolute(rawPath) ? rawPath : resolve(vaultRoot, rawPath)).href;
}

export async function discoverResearchContext(
  input: { task: Task; project: Project },
  options: DiscoverResearchContextOptions,
): Promise<ResearchContextDiscovery> {
  const roots = await canonicalRoots(options.allowedLocalRoots);
  const vaultRoot = await realpath(options.vaultRoot);
  if (!roots.some((root) => isWithin(root, vaultRoot))) {
    throw new Error('The Vault root must be inside an allowed local root');
  }
  const maxLocalFiles = options.maxLocalFiles ?? DEFAULT_MAX_LOCAL_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxLocalFiles) || maxLocalFiles < 0 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
    throw new Error('Research context budgets must be non-negative integers');
  }

  const candidates: ContextCandidate[] = [
    {
      candidateId: 'task-current',
      category: 'task',
      sourceRef: `task://${input.task.taskId}`,
      version: taskContextVersion(input.task),
      expectedSha256: null,
      selection: 'selected',
      selectionReason: 'The current Task defines the objective and acceptance.',
      blockLabel: 'task',
    },
    {
      candidateId: 'project-current',
      category: 'project',
      sourceRef: `atl-project://${input.project.projectId}`,
      version: input.project.updatedAt,
      expectedSha256: null,
      selection: 'selected',
      selectionReason: 'The owning Project defines the durable project context.',
      blockLabel: 'project',
    },
  ];
  const local: LocalCandidate[] = [];
  const explicitCanonicalPaths = new Set<string>();

  if (input.task.sourceNote !== null && input.task.sourceNote.trim() !== '') {
    const inspected = await inspectLocalPath(input.task.sourceNote, roots, vaultRoot);
    if (inspected !== null) explicitCanonicalPaths.add(inspected.path);
    local.push({
      candidateId: 'task-source-note',
      path: inspected?.path ?? (isAbsolute(input.task.sourceNote)
        ? input.task.sourceNote
        : resolve(vaultRoot, input.task.sourceNote)),
      sourceRef: inspected?.sourceRef ?? unresolvedRef(input.task.sourceNote, vaultRoot),
      version: null,
      sizeBytes: inspected?.sizeBytes ?? null,
      selectionReason: 'The Task explicitly references this source note.',
      priority: 0,
      relevanceScore: Number.POSITIVE_INFINITY,
      explicit: true,
      required: true,
      kind: 'local_file',
      category: 'source',
      fixedBlockLabel: 'task_source_note',
    });
  }

  const selectedProjectResourceIndexes: number[] = [];
  for (const [index, resource] of input.project.resources.entries()) {
    const candidateId = `project-resource-${String(index + 1).padStart(3, '0')}`;
    const blockLabel = `project_resource_${String(index + 1).padStart(3, '0')}`;
    if (resource.kind !== 'local_path') {
      selectedProjectResourceIndexes.push(index);
      candidates.push({
        candidateId,
        category: 'source',
        sourceRef: resource.value,
        version: input.project.updatedAt,
        expectedSha256: null,
        selection: 'selected',
        selectionReason: 'The Project explicitly lists this remote resource.',
        blockLabel,
      });
      continue;
    }
    const inspected = await inspectLocalPath(resource.value, roots, vaultRoot);
    if (inspected !== null && explicitCanonicalPaths.has(inspected.path)) {
      candidates.push({
        candidateId,
        category: 'source',
        sourceRef: inspected.sourceRef,
        version: input.project.updatedAt,
        expectedSha256: null,
        selection: 'excluded',
        selectionReason: 'The Project explicitly lists this local resource.',
        exclusionReason: 'duplicate_context_source',
      });
      continue;
    }
    if (inspected !== null) explicitCanonicalPaths.add(inspected.path);
    local.push({
      candidateId,
      path: inspected?.path ?? (isAbsolute(resource.value) ? resource.value : resolve(vaultRoot, resource.value)),
      sourceRef: inspected?.sourceRef ?? unresolvedRef(resource.value, vaultRoot),
      version: input.project.updatedAt,
      sizeBytes: inspected?.sizeBytes ?? null,
      selectionReason: 'The Project explicitly lists this local resource.',
      priority: 1,
      relevanceScore: Number.POSITIVE_INFINITY,
      explicit: true,
      required: false,
      kind: 'local_file',
      category: 'source',
      fixedBlockLabel: blockLabel,
      projectResourceIndex: index,
    });
  }

  const discoveredGroups: Array<{
    directory: string;
    priority: number;
    kind: AdditionalLocalContext['kind'];
    category: ContextCategory;
    reason: string;
  }> = [];
  if (input.task.sourceDate !== null) {
    discoveredGroups.push({
      directory: join(vaultRoot, '笔记同步助手', input.task.sourceDate),
      priority: 2,
      kind: 'local_file',
      category: 'source',
      reason: 'This material was captured on the Task source date.',
    });
    const previous = previousDate(input.task.sourceDate);
    if (previous !== null) discoveredGroups.push({
      directory: join(vaultRoot, '笔记同步助手', previous),
      priority: 3,
      kind: 'local_file',
      category: 'source',
      reason: 'This nearby material may contain the article that prompted the Task.',
    });
  }
  discoveredGroups.push({
    directory: join(vaultRoot, '07_System', 'Context_Packs'),
    priority: 4,
    kind: 'user_context',
    category: 'user_context',
    reason: 'The personal Context Pack may contain durable collaboration preferences.',
  });

  for (const group of discoveredGroups) {
    const paths = await listContextFiles(group.directory);
    const scored = paths
      .filter((path) => !explicitCanonicalPaths.has(path))
      .map((path) => ({ path, score: relevance(path, input.task, input.project) }))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    for (const { path, score } of scored) {
      const inspected = await inspectLocalPath(path, roots, vaultRoot);
      if (inspected === null) continue;
      local.push({
        candidateId: stableId('discovered-context', path),
        path: inspected.path,
        sourceRef: inspected.sourceRef,
        version: inspected.version,
        sizeBytes: inspected.sizeBytes,
        selectionReason: group.reason,
        priority: group.priority,
        relevanceScore: score,
        explicit: false,
        required: false,
        kind: group.kind,
        category: group.category,
      });
    }
  }

  const registryNames = ['Project Registry.md', 'Project_Registry.md', 'project-registry.md'];
  for (const name of registryNames) {
    const inspected = await inspectLocalPath(join(vaultRoot, '07_System', name), roots, vaultRoot);
    if (inspected === null || explicitCanonicalPaths.has(inspected.path)) continue;
    local.push({
      candidateId: stableId('project-registry', inspected.path),
      path: inspected.path,
      sourceRef: inspected.sourceRef,
      version: inspected.version,
      sizeBytes: inspected.sizeBytes,
      selectionReason: 'The Project Registry maps durable project identities and source locations.',
      priority: 5,
      relevanceScore: relevance(inspected.path, input.task, input.project),
      explicit: false,
      required: false,
      kind: 'user_context',
      category: 'user_context',
    });
    break;
  }

  local.sort((left, right) => (
    Number(right.explicit) - Number(left.explicit)
    || right.relevanceScore - left.relevanceScore
    || left.priority - right.priority
    || left.path.localeCompare(right.path)
  ));
  let selectedFiles = 0;
  let selectedBytes = 0;
  let additionalIndex = 0;
  let requiredBudgetBlocked = false;
  const additionalLocalContexts: AdditionalLocalContext[] = [];
  let includeSourceNote = false;
  for (const item of local) {
    const size = item.sizeBytes ?? 0;
    const withinBudget = !requiredBudgetBlocked
      && selectedFiles < maxLocalFiles
      && size <= MAX_CONTEXT_FILE_BYTES
      && selectedBytes + size <= maxTotalBytes;
    if (!withinBudget) {
      if (item.required) requiredBudgetBlocked = true;
      candidates.push({
        candidateId: item.candidateId,
        category: item.category,
        sourceRef: item.sourceRef,
        version: item.version,
        expectedSha256: null,
        selection: item.required ? 'selected' : 'excluded',
        selectionReason: item.selectionReason,
        ...(item.required
          ? (item.fixedBlockLabel === undefined
              ? {}
              : { blockLabel: item.fixedBlockLabel })
          : {
              exclusionReason: size > MAX_CONTEXT_FILE_BYTES
                ? 'context_file_too_large'
                : 'context_file_budget_exceeded',
            }),
      });
      continue;
    }
    selectedFiles += 1;
    selectedBytes += size;
    let blockLabel = item.fixedBlockLabel;
    if (item.candidateId === 'task-source-note') includeSourceNote = true;
    if (item.projectResourceIndex !== undefined) {
      selectedProjectResourceIndexes.push(item.projectResourceIndex);
    }
    if (blockLabel === undefined) {
      additionalIndex += 1;
      blockLabel = `research_context_${String(additionalIndex).padStart(3, '0')}`;
      additionalLocalContexts.push({
        label: blockLabel,
        kind: item.kind,
        category: item.category,
        path: item.path,
        sourceRef: item.sourceRef,
        version: item.version,
      });
    }
    candidates.push({
      candidateId: item.candidateId,
      category: item.category,
      sourceRef: item.sourceRef,
      version: item.version,
      expectedSha256: null,
      selection: 'selected',
      selectionReason: item.selectionReason,
      blockLabel,
    });
  }

  return {
    additionalLocalContexts,
    candidates,
    includeSourceNote,
    selectedProjectResourceIndexes: selectedProjectResourceIndexes.sort((a, b) => a - b),
  };
}
