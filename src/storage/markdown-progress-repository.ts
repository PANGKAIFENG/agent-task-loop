import { join } from 'node:path';

import {
  progressVersionSchema,
  type ProgressVersion,
} from '../domain/progress.js';
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

export interface ProgressRepository {
  create(progress: ProgressVersion): Promise<ProgressVersion>;
  listVersions(progressId: string): Promise<ProgressVersion[]>;
  listCurrent(): Promise<ProgressVersion[]>;
}

export class InvalidProgressDataError extends Error {
  readonly code = 'invalid_progress_data';

  constructor() {
    super('Invalid progress data');
    this.name = 'InvalidProgressDataError';
  }
}

export class ProgressVersionConflictError extends Error {
  readonly code = 'progress_version_conflict';

  constructor() {
    super('Progress version already exists');
    this.name = 'ProgressVersionConflictError';
  }
}

function progressRoot(root: string): string {
  return join(root, '09_Progress');
}

function itemsRoot(root: string): string {
  return join(progressRoot(root), 'Items');
}

function progressMonth(progress: ProgressVersion): string {
  const month = progress.occurredAt.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new InvalidProgressDataError();
  }
  return month;
}

function serializeProgress(progress: ProgressVersion): string {
  const data = {
    type: 'progress',
    schema_version: progress.schemaVersion,
    progress_id: progress.progressId,
    version: progress.version,
    lifecycle_status: progress.lifecycleStatus,
    topic: progress.topic,
    report_category: progress.reportCategory,
    primary_project_id: progress.primaryProjectId,
    occurred_at: progress.occurredAt,
    sources: progress.sources,
    statements: progress.statements,
    evidence: progress.evidence,
    self_evidence: progress.selfEvidence,
    agent_evidence: progress.agentEvidence,
    contribution: progress.contribution,
    eligibility: progress.eligibility,
    supersedes_version: progress.supersedesVersion,
    created_at: progress.createdAt,
  };
  const facts = progress.statements
    .map((statement) => `- **${statement.kind}** ${statement.text}`)
    .join('\n');
  return serializeTaskDocument(data, `\n# ${progress.topic}\n\n${facts}\n`);
}

function parseProgress(raw: string): ProgressVersion {
  const { data } = parseTaskDocument(raw);
  const parsed = progressVersionSchema.safeParse({
    schemaVersion: data.schema_version,
    progressId: data.progress_id,
    version: data.version,
    lifecycleStatus: data.lifecycle_status,
    topic: data.topic,
    reportCategory: data.report_category,
    primaryProjectId: data.primary_project_id,
    occurredAt: data.occurred_at,
    sources: data.sources,
    statements: data.statements,
    evidence: data.evidence,
    selfEvidence: data.self_evidence,
    agentEvidence: data.agent_evidence,
    contribution: data.contribution,
    eligibility: data.eligibility,
    supersedesVersion: data.supersedes_version,
    createdAt: data.created_at,
  });
  if (!parsed.success) {
    throw new InvalidProgressDataError();
  }
  return parsed.data;
}

export class MarkdownProgressRepository implements ProgressRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: {
    writeAuthorization?: VaultWriteAuthorization;
  } = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async create(progress: ProgressVersion): Promise<ProgressVersion> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = progressVersionSchema.safeParse(progress);
    if (!parsed.success || !isSafePathSegment(parsed.data.progressId)) {
      throw new InvalidProgressDataError();
    }
    const validProgress = parsed.data;
    const monthRoot = join(itemsRoot(this.root), progressMonth(validProgress));
    const filename = `${validProgress.progressId}-v${validProgress.version}.md`;
    const created = await atomicCreateTextFile(
      join(monthRoot, filename),
      serializeProgress(validProgress),
      {
        vaultRoot: this.root,
        tasksRoot: progressRoot(this.root),
        subtree: monthRoot,
      },
    );
    if (!created) {
      throw new ProgressVersionConflictError();
    }
    return validProgress;
  }

  async listVersions(progressId: string): Promise<ProgressVersion[]> {
    if (!isSafePathSegment(progressId)) {
      throw new InvalidProgressDataError();
    }
    return (await this.listAll())
      .filter((progress) => progress.progressId === progressId)
      .sort((left, right) => left.version - right.version);
  }

  async listCurrent(): Promise<ProgressVersion[]> {
    const latest = new Map<string, ProgressVersion>();
    for (const progress of await this.listAll()) {
      const current = latest.get(progress.progressId);
      if (current === undefined || current.version < progress.version) {
        latest.set(progress.progressId, progress);
      }
    }
    return Array.from(latest.values()).sort((left, right) => (
      left.progressId.localeCompare(right.progressId)
    ));
  }

  private async listAll(): Promise<ProgressVersion[]> {
    const root = itemsRoot(this.root);
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: root,
    };
    const paths = await listSafeRegularFiles(boundary, '**/*.md');
    const versions: ProgressVersion[] = [];
    const identities = new Set<string>();
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      const progress = parseProgress(raw);
      const identity = `${progress.progressId}:${progress.version}`;
      if (identities.has(identity)) {
        throw new InvalidProgressDataError();
      }
      identities.add(identity);
      versions.push(progress);
    }
    return versions;
  }
}
