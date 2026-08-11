import { join } from 'node:path';

import { materialGapSchema, type MaterialGap } from '../domain/material-gap.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
} from './file-io.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  type VaultWriteAuthorization,
  vaultRoot,
} from './task-paths.js';

export interface MaterialGapRepository {
  create(gap: MaterialGap): Promise<MaterialGap>;
  get(gapId: string): Promise<MaterialGap>;
  list(): Promise<MaterialGap[]>;
}

export class InvalidMaterialGapError extends Error {
  readonly code = 'invalid_material_gap';

  constructor() {
    super('Invalid material gap');
    this.name = 'InvalidMaterialGapError';
  }
}

export class MaterialGapConflictError extends Error {
  readonly code = 'material_gap_conflict';

  constructor() {
    super('Material gap already exists');
    this.name = 'MaterialGapConflictError';
  }
}

function progressRoot(root: string): string {
  return join(root, '09_Progress');
}

function requestsRoot(root: string): string {
  return join(progressRoot(root), 'Requests');
}

function serializeGap(gap: MaterialGap): string {
  const data = {
    type: 'context_request',
    schema_version: gap.schemaVersion,
    gap_id: gap.gapId,
    progress_id: gap.progressId,
    progress_version: gap.progressVersion,
    missing: gap.missing,
    searches: gap.searches,
    suggested_contact: gap.suggestedContact,
    status: gap.status,
    resolved_source_ref: gap.resolvedSourceRef,
    message_draft: gap.messageDraft,
    created_at: gap.createdAt,
  };
  const draft = gap.messageDraft === null
    ? '未生成外发草稿。'
    : `## 待审消息草稿\n\n${gap.messageDraft.body}`;
  return serializeTaskDocument(
    data,
    `\n# 待补材料：${gap.missing.description}\n\n${draft}\n`,
  );
}

function parseGap(raw: string): MaterialGap {
  const { data } = parseTaskDocument(raw);
  const parsed = materialGapSchema.safeParse({
    schemaVersion: data.schema_version,
    gapId: data.gap_id,
    progressId: data.progress_id,
    progressVersion: data.progress_version,
    missing: data.missing,
    searches: data.searches,
    suggestedContact: data.suggested_contact,
    status: data.status,
    resolvedSourceRef: data.resolved_source_ref,
    messageDraft: data.message_draft,
    createdAt: data.created_at,
  });
  if (!parsed.success) {
    throw new InvalidMaterialGapError();
  }
  return parsed.data;
}

export class MarkdownMaterialGapRepository implements MaterialGapRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: {
    writeAuthorization?: VaultWriteAuthorization;
  } = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async create(gap: MaterialGap): Promise<MaterialGap> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = materialGapSchema.safeParse(gap);
    if (!parsed.success || !isSafePathSegment(parsed.data.gapId)) {
      throw new InvalidMaterialGapError();
    }
    const validGap = parsed.data;
    const month = validGap.createdAt.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new InvalidMaterialGapError();
    }
    const monthRoot = join(requestsRoot(this.root), month);
    const created = await atomicCreateTextFile(
      join(monthRoot, `${validGap.gapId}.md`),
      serializeGap(validGap),
      {
        vaultRoot: this.root,
        tasksRoot: progressRoot(this.root),
        subtree: monthRoot,
      },
    );
    if (!created) throw new MaterialGapConflictError();
    return validGap;
  }

  async get(gapId: string): Promise<MaterialGap> {
    if (!isSafePathSegment(gapId)) throw new InvalidMaterialGapError();
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: requestsRoot(this.root),
    };
    const paths = await listSafeRegularFiles(boundary, `**/${gapId}.md`);
    if (paths.length !== 1) throw new InvalidMaterialGapError();
    const raw = await readSafeTextFile(paths[0] ?? '', boundary);
    if (raw === null) throw new InvalidMaterialGapError();
    return parseGap(raw);
  }

  async list(): Promise<MaterialGap[]> {
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: requestsRoot(this.root),
    };
    const paths = await listSafeRegularFiles(boundary, '**/*.md');
    const gaps: MaterialGap[] = [];
    const identities = new Set<string>();
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      const gap = parseGap(raw);
      if (identities.has(gap.gapId)) throw new InvalidMaterialGapError();
      identities.add(gap.gapId);
      gaps.push(gap);
    }
    return gaps.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.gapId.localeCompare(right.gapId)
    ));
  }
}
