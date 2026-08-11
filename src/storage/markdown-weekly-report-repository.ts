import { join } from 'node:path';

import {
  weeklyReportVersionSchema,
  type WeeklyReportVersion,
} from '../domain/weekly-report.js';
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

export interface WeeklyReportRepository {
  create(report: WeeklyReportVersion): Promise<WeeklyReportVersion>;
  listVersions(weeklyId: string): Promise<WeeklyReportVersion[]>;
  listCurrent(): Promise<WeeklyReportVersion[]>;
}

export class InvalidWeeklyReportError extends Error {
  readonly code = 'invalid_weekly_report';

  constructor() {
    super('Invalid weekly report');
    this.name = 'InvalidWeeklyReportError';
  }
}

export class WeeklyReportConflictError extends Error {
  readonly code = 'weekly_report_conflict';

  constructor() {
    super('Weekly report version already exists');
    this.name = 'WeeklyReportConflictError';
  }
}

function progressRoot(root: string): string {
  return join(root, '09_Progress');
}

function weeklyRoot(root: string): string {
  return join(progressRoot(root), 'Weekly');
}

function bullet(label: string, values: string[]): string {
  return values.length === 0 ? '' : `- ${label}：${values.join('；')}\n`;
}

function itemMarkdown(item: WeeklyReportVersion['sections'][number]['items'][number]): string {
  return [
    `### ${item.topic}\n`,
    `- 类型：${item.reportCategory}`,
    `- 贡献：${item.contribution}`,
    bullet('本周变化', item.changes).trimEnd(),
    bullet('关键结论', item.conclusions).trimEnd(),
    bullet('输出产物', item.artifacts.map((artifact) => (
      `${artifact.summary} (${artifact.sourceRef})`
    ))).trimEnd(),
    bullet('卡点', item.blockers).trimEnd(),
    bullet('待确认', item.pending).trimEnd(),
    `- 证据：${item.sourceRefs.join('；')}`,
  ].filter((line) => line !== '').join('\n');
}

function serializeReport(report: WeeklyReportVersion): string {
  const data = {
    type: 'weekly_progress_report',
    schema_version: report.schemaVersion,
    weekly_id: report.weeklyId,
    version: report.version,
    week_key: report.weekKey,
    week: report.week,
    acceptance_state: report.acceptanceState,
    publication_state: report.publicationState,
    completeness: report.completeness,
    progress_refs: report.progressRefs,
    sections: report.sections,
    omissions: report.omissions,
    excluded_progress_ids: report.excludedProgressIds,
    pending_count: report.pendingCount,
    supersedes_version: report.supersedesVersion,
    created_at: report.createdAt,
  };
  const sections = report.sections.map((section) => [
    `## ${section.primaryProjectId}`,
    ...section.items.map(itemMarkdown),
  ].join('\n\n')).join('\n\n');
  const omissions = report.omissions.length === 0
    ? ''
    : [
        '## 待补材料',
        ...report.omissions.map((omission) => (
          `- ${omission.progressId} v${omission.version}：${omission.reasons.join('；')}`
        )),
      ].join('\n');
  return serializeTaskDocument(data, [
    `\n# ${report.weekKey} 工作进展周报`,
    '',
    `状态：${report.completeness}`,
    '',
    sections,
    omissions,
    '',
  ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n'));
}

function parseReport(raw: string): WeeklyReportVersion {
  const { data } = parseTaskDocument(raw);
  const parsed = weeklyReportVersionSchema.safeParse({
    schemaVersion: data.schema_version,
    weeklyId: data.weekly_id,
    version: data.version,
    weekKey: data.week_key,
    week: data.week,
    acceptanceState: data.acceptance_state,
    publicationState: data.publication_state,
    completeness: data.completeness,
    progressRefs: data.progress_refs,
    sections: data.sections,
    omissions: data.omissions,
    excludedProgressIds: data.excluded_progress_ids,
    pendingCount: data.pending_count,
    supersedesVersion: data.supersedes_version,
    createdAt: data.created_at,
  });
  if (!parsed.success) throw new InvalidWeeklyReportError();
  return parsed.data;
}

export class MarkdownWeeklyReportRepository implements WeeklyReportRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: {
    writeAuthorization?: VaultWriteAuthorization;
  } = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async create(report: WeeklyReportVersion): Promise<WeeklyReportVersion> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = weeklyReportVersionSchema.safeParse(report);
    if (!parsed.success || !isSafePathSegment(parsed.data.weekKey)) {
      throw new InvalidWeeklyReportError();
    }
    const validReport = parsed.data;
    const created = await atomicCreateTextFile(
      join(weeklyRoot(this.root), `${validReport.weekKey}-v${validReport.version}.md`),
      serializeReport(validReport),
      {
        vaultRoot: this.root,
        tasksRoot: progressRoot(this.root),
        subtree: weeklyRoot(this.root),
      },
    );
    if (!created) throw new WeeklyReportConflictError();
    return validReport;
  }

  async listVersions(weeklyId: string): Promise<WeeklyReportVersion[]> {
    if (!isSafePathSegment(weeklyId)) throw new InvalidWeeklyReportError();
    return (await this.listAll())
      .filter((report) => report.weeklyId === weeklyId)
      .sort((left, right) => left.version - right.version);
  }

  async listCurrent(): Promise<WeeklyReportVersion[]> {
    const latest = new Map<string, WeeklyReportVersion>();
    for (const report of await this.listAll()) {
      const current = latest.get(report.weeklyId);
      if (current === undefined || current.version < report.version) {
        latest.set(report.weeklyId, report);
      }
    }
    return [...latest.values()].sort((left, right) => (
      left.weekKey.localeCompare(right.weekKey)
      || left.weeklyId.localeCompare(right.weeklyId)
    ));
  }

  private async listAll(): Promise<WeeklyReportVersion[]> {
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: weeklyRoot(this.root),
    };
    const paths = await listSafeRegularFiles(boundary, '*.md');
    const reports: WeeklyReportVersion[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      const report = parseReport(raw);
      reports.push(report);
    }
    return reports;
  }
}
