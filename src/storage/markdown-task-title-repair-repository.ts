import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import YAML, { isMap, isScalar } from 'yaml';

import type {
  LegacyTaskTitleCandidate,
  LegacyTaskTitlePreview,
  LegacyTaskTitleRepairRepository,
} from '../services/repair-legacy-task-titles.js';
import {
  atomicReplaceSafeTextFile,
  InvalidStorageEntryError,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import { rebuildTaskIndex } from './task-index.js';
import {
  assertVaultWriteAllowed,
  taskStorageRoot,
  type VaultWriteAuthorization,
  vaultRoot,
} from './task-paths.js';

interface MarkdownDocumentParts {
  opening: string;
  frontmatter: string;
  closing: string;
  body: string;
  newline: '\n' | '\r\n';
}

interface RepairableDocument {
  title: string;
  repairedRaw: string;
}

export interface MarkdownTaskTitleRepairRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
}

const LIFECYCLE_DIRECTORIES = ['Inbox', 'Active', 'Archive'] as const;

function splitMarkdownDocument(raw: string): MarkdownDocumentParts | null {
  const match = /^(---(\r?\n))([\s\S]*?)(\r?\n---(?=\r?\n|$))([\s\S]*)$/u.exec(raw);
  if (match === null) return null;
  return {
    opening: match[1] ?? '',
    newline: match[2] === '\r\n' ? '\r\n' : '\n',
    frontmatter: match[3] ?? '',
    closing: match[4] ?? '',
    body: match[5] ?? '',
  };
}

function firstBodyH1(body: string): string | null {
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (const line of body.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (fence === null) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (
        fence.marker === marker
        && fenceMatch[1].length >= fence.length
        && /^[ \t]*$/u.test(fenceMatch[2] ?? '')
      ) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = /^ {0,3}#(?:[ \t]+|$)(.*)$/u.exec(line);
    if (headingMatch === null) continue;
    const title = (headingMatch[1] ?? '')
      .replace(/[ \t]+#+[ \t]*$/u, '')
      .trim();
    if (title !== '') return title;
  }
  return null;
}

function serializedTitle(title: string): string {
  return YAML.stringify(title).trimEnd();
}

function sourceRange(value: unknown): readonly number[] | null {
  if (
    typeof value !== 'object'
    || value === null
    || !('range' in value)
    || !Array.isArray(value.range)
    || value.range.length < 2
    || !value.range.every((part) => typeof part === 'number')
  ) return null;
  return value.range;
}

function patchedFrontmatter(input: {
  frontmatter: string;
  newline: '\n' | '\r\n';
  document: ReturnType<typeof YAML.parseDocument>;
  title: string;
}): string | null {
  const encoded = serializedTitle(input.title);
  if (!isMap(input.document.contents)) return null;
  const titlePair = input.document.contents.items.find((pair) => (
    isScalar(pair.key) && pair.key.value === 'title'
  ));
  if (titlePair === undefined) {
    return `${input.frontmatter}${input.newline}title: ${encoded}`;
  }

  const start = sourceRange(titlePair.key)?.[0];
  const end = sourceRange(titlePair.value)?.[1];
  if (start === undefined || end === undefined || end < start) return null;
  const replaced = input.frontmatter.slice(start, end);
  const retainedNewline = replaced.endsWith('\r\n')
    ? '\r\n'
    : replaced.endsWith('\n') ? '\n' : '';
  return `${input.frontmatter.slice(0, start)}title: ${encoded}${retainedNewline}${input.frontmatter.slice(end)}`;
}

function repairableDocument(raw: string): RepairableDocument | null {
  const parts = splitMarkdownDocument(raw);
  if (parts === null) return null;
  const document = YAML.parseDocument(parts.frontmatter, {
    keepSourceTokens: true,
  });
  if (document.errors.length > 0 || document.get('type') !== 'task') return null;

  const currentTitle = document.get('title');
  if (
    currentTitle !== undefined
    && currentTitle !== null
    && (typeof currentTitle !== 'string' || currentTitle.trim() !== '')
  ) return null;
  const title = firstBodyH1(parts.body);
  if (title === null) return null;
  const frontmatter = patchedFrontmatter({
    frontmatter: parts.frontmatter,
    newline: parts.newline,
    document,
    title,
  });
  if (frontmatter === null) return null;
  return {
    title,
    repairedRaw: `${parts.opening}${frontmatter}${parts.closing}${parts.body}`,
  };
}

function revision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class MarkdownTaskTitleRepairRepository implements LegacyTaskTitleRepairRepository {
  readonly root: string;
  readonly tasksRoot: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(
    root?: string,
    options: MarkdownTaskTitleRepairRepositoryOptions = {},
  ) {
    this.root = vaultRoot(root);
    this.tasksRoot = taskStorageRoot(this.root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async scan(): Promise<LegacyTaskTitlePreview> {
    const files = (await Promise.all(LIFECYCLE_DIRECTORIES.map(async (directory) => {
      const boundary = this.boundary(directory);
      if (!await this.hasLiteralLifecycleBoundary(boundary)) return [];
      return (await listSafeRegularFiles(boundary, '**/*.md')).map((path) => ({
        path,
        boundary,
      }));
    }))).flat();
    let tasksScanned = 0;
    const candidates: LegacyTaskTitleCandidate[] = [];

    for (const { path, boundary } of files) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      const parts = splitMarkdownDocument(raw);
      if (parts === null) continue;
      const document = YAML.parseDocument(parts.frontmatter);
      if (document.errors.length > 0 || document.get('type') !== 'task') continue;
      tasksScanned += 1;
      const repairable = repairableDocument(raw);
      if (repairable === null) continue;
      candidates.push({
        path: relative(this.root, path).split(sep).join('/'),
        title: repairable.title,
        revision: revision(raw),
      });
    }

    return {
      filesScanned: files.length,
      tasksScanned,
      candidates,
    };
  }

  async repair(candidate: LegacyTaskTitleCandidate): Promise<boolean> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const located = this.locate(candidate.path);
    if (located === null) return false;
    if (!await this.hasLiteralLifecycleBoundary(located.boundary)) return false;
    const raw = await readSafeTextFile(located.path, located.boundary);
    if (raw === null || revision(raw) !== candidate.revision) return false;
    const repairable = repairableDocument(raw);
    if (repairable === null || repairable.title !== candidate.title) return false;
    if (!await this.hasLiteralLifecycleBoundary(located.boundary)) return false;
    try {
      return await atomicReplaceSafeTextFile(
        located.path,
        raw,
        repairable.repairedRaw,
        located.boundary,
      );
    } catch (error) {
      if (error instanceof InvalidStorageEntryError) return false;
      throw error;
    }
  }

  async rebuildIndex(): Promise<void> {
    await rebuildTaskIndex(this.root, undefined, this.writeAuthorization);
  }

  private boundary(
    directory: typeof LIFECYCLE_DIRECTORIES[number],
  ): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: this.tasksRoot,
      subtree: join(this.tasksRoot, directory),
    };
  }

  private locate(relativePath: string): {
    path: string;
    boundary: StorageReadBoundary;
  } | null {
    for (const directory of LIFECYCLE_DIRECTORIES) {
      const prefix = `10_Tasks/${directory}/`;
      if (!relativePath.startsWith(prefix)) continue;
      const path = resolve(this.root, relativePath);
      if (relative(this.root, path).split(sep).join('/') !== relativePath) return null;
      return { path, boundary: this.boundary(directory) };
    }
    return null;
  }

  private async hasLiteralLifecycleBoundary(
    boundary: StorageReadBoundary,
  ): Promise<boolean> {
    try {
      const [tasksRoot, lifecycleRoot] = await Promise.all([
        lstat(this.tasksRoot),
        lstat(boundary.subtree),
      ]);
      return tasksRoot.isDirectory()
        && !tasksRoot.isSymbolicLink()
        && lifecycleRoot.isDirectory()
        && !lifecycleRoot.isSymbolicLink();
    } catch {
      return false;
    }
  }
}
