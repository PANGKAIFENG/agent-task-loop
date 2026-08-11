import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProgressDraft } from '../../../src/domain/progress.js';
import { createProgressVersion } from '../../../src/services/create-progress-version.js';
import { generateWeeklyReport } from '../../../src/services/generate-weekly-report.js';
import { MarkdownProgressRepository } from '../../../src/storage/markdown-progress-repository.js';
import { MarkdownWeeklyReportRepository } from '../../../src/storage/markdown-weekly-report-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function draft(overrides: Partial<ProgressDraft> = {}): ProgressDraft {
  const source = '08_Meetings/2026-08/synthetic-meeting.md';
  return {
    topic: '精恭纺验收分类',
    reportCategory: 'project_acceptance',
    primaryProjectId: 'project-jinggongfang',
    occurredAt: '2026-08-10T16:00:00+08:00',
    sources: [source],
    statements: [{
      kind: 'fact',
      text: '验收分类口径已确认。',
      sourceRefs: [source],
    }],
    evidence: [{
      kind: 'confirmed_decision',
      summary: '验收表按四类整理',
      sourceRef: source,
    }],
    selfEvidence: [],
    agentEvidence: [],
    ...overrides,
  };
}

describe('generate weekly report', () => {
  it('snapshots only eligible progress and keeps missing material as partial success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-weekly-'));
    roots.push(root);
    const progressRepository = new MarkdownProgressRepository(root);
    const weeklyRepository = new MarkdownWeeklyReportRepository(root);
    const ids = [
      'progress-jgf',
      'progress-staywork',
      'progress-skill-check',
      'progress-missing-table',
    ];
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };
    const progressContext = {
      repository: progressRepository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => ids.shift() ?? 'unexpected',
    };
    await createProgressVersion(progressContext, { draft: draft(), week });
    await createProgressVersion(progressContext, {
      draft: draft({
        topic: 'Staywork 需求评审',
        reportCategory: 'product_requirement',
        primaryProjectId: 'project-staywork',
        evidence: [{
          kind: 'artifact',
          summary: 'PRD 已形成',
          sourceRef: '10_Tasks/Artifacts/synthetic-prd.md',
        }],
        sources: ['10_Tasks/Artifacts/synthetic-prd.md'],
        statements: [{
          kind: 'fact',
          text: '需求边界已完成评审。',
          sourceRefs: ['10_Tasks/Artifacts/synthetic-prd.md'],
        }],
      }),
      week,
    });
    await createProgressVersion(progressContext, {
      draft: draft({
        topic: 'skill进展核对',
        reportCategory: 'routine_check',
        primaryProjectId: 'project-skill',
        evidence: [{
          kind: 'discussion',
          summary: '讨论了 Skill 进展',
          sourceRef: '08_Meetings/2026-08/synthetic-meeting.md',
        }],
      }),
      week,
    });
    await createProgressVersion(progressContext, {
      draft: draft({
        topic: '精恭纺分类数量',
        statements: [{
          kind: 'fact',
          text: '共有 47 项待验收。',
          sourceRefs: [],
        }],
      }),
      week,
    });

    const report = await generateWeeklyReport({
      progressRepository,
      weeklyRepository,
      clock: () => new Date('2026-08-16T10:00:00.000Z'),
    }, {
      weekKey: '2026-W33',
      week,
    });

    expect(report).toMatchObject({
      weeklyId: 'weekly-2026-W33',
      version: 1,
      acceptanceState: 'pending',
      publicationState: 'not_published',
      completeness: 'partial_success',
    });
    expect(report.progressRefs).toEqual([
      { progressId: 'progress-jgf', version: 1 },
      { progressId: 'progress-staywork', version: 1 },
    ]);
    expect(report.sections.map((section) => section.primaryProjectId)).toEqual([
      'project-jinggongfang',
      'project-staywork',
    ]);
    expect(report.sections[0]?.items[0]).toMatchObject({
      topic: '精恭纺验收分类',
      conclusions: ['验收表按四类整理'],
    });
    expect(report.omissions).toEqual([{
      progressId: 'progress-missing-table',
      version: 1,
      reasons: ['数字缺少可定位来源'],
    }]);
    expect(report.excludedProgressIds).toEqual(['progress-skill-check']);
    const raw = await readFile(join(
      root,
      '09_Progress',
      'Weekly',
      '2026-W33-v1.md',
    ), 'utf8');
    expect(raw).toContain('# 2026-W33 工作进展周报');
    expect(raw).toContain('## project-jinggongfang');
    expect(raw).not.toContain('skill进展核对');
    expect(raw).not.toContain('47');
    await expect(weeklyRepository.listCurrent()).resolves.toEqual([report]);
  });

  it('keeps the weekly version when the acceptance notification fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-weekly-'));
    roots.push(root);
    const progressRepository = new MarkdownProgressRepository(root);
    const weeklyRepository = new MarkdownWeeklyReportRepository(root);
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };
    await createProgressVersion({
      repository: progressRepository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => 'progress-notify-failed',
    }, { draft: draft(), week });
    const notified: string[] = [];

    const report = await generateWeeklyReport({
      progressRepository,
      weeklyRepository,
      clock: () => new Date('2026-08-16T10:00:00.000Z'),
      notifyAcceptance: async (object) => {
        notified.push(`${object.objectType}:${object.objectId}:${object.version}`);
        throw new Error('synthetic notification failure');
      },
    }, {
      weekKey: '2026-W33',
      week,
    });

    expect(notified).toEqual(['weekly:weekly-2026-W33:1']);
    await expect(weeklyRepository.listCurrent()).resolves.toEqual([report]);
    expect(await readFile(join(
      root,
      '09_Progress',
      'Weekly',
      '2026-W33-v1.md',
    ), 'utf8')).toContain('# 2026-W33 工作进展周报');
  });
});
