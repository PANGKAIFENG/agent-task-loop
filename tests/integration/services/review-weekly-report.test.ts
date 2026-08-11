import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProgressDraft } from '../../../src/domain/progress.js';
import { createProgressVersion } from '../../../src/services/create-progress-version.js';
import { generateWeeklyReport } from '../../../src/services/generate-weekly-report.js';
import {
  acceptWeeklyReport,
  rejectWeeklyReport,
  rejectWeeklyReportWithFeedback,
} from '../../../src/services/review-weekly-report.js';
import { MarkdownProgressRepository } from '../../../src/storage/markdown-progress-repository.js';
import { FileWeeklyReviewDecisionRepository } from '../../../src/storage/weekly-review-decision-repository.js';
import { MarkdownWeeklyReportRepository } from '../../../src/storage/markdown-weekly-report-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function draft(): ProgressDraft {
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
  };
}

describe('review weekly report', () => {
  it('rejects into a new report version without changing source progress, then accepts without publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-weekly-review-'));
    roots.push(root);
    const progressRepository = new MarkdownProgressRepository(root);
    const weeklyRepository = new MarkdownWeeklyReportRepository(root);
    const decisionRepository = new FileWeeklyReviewDecisionRepository(root);
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };
    await createProgressVersion({
      repository: progressRepository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => 'progress-jgf',
    }, { draft: draft(), week });
    const first = await generateWeeklyReport({
      progressRepository,
      weeklyRepository,
      clock: () => new Date('2026-08-16T10:00:00.000Z'),
    }, { weekKey: '2026-W33', week });
    const progressPath = join(
      root,
      '09_Progress',
      'Items',
      '2026-08',
      'progress-jgf-v1.md',
    );
    const firstReportPath = join(
      root,
      '09_Progress',
      'Weekly',
      '2026-W33-v1.md',
    );
    const [progressBytes, firstReportBytes] = await Promise.all([
      readFile(progressPath),
      readFile(firstReportPath),
    ]);
    const reviewContext = {
      weeklyRepository,
      decisionRepository,
      clock: () => new Date('2026-08-16T11:00:00.000Z'),
      id: () => 'review-event-1',
    };

    const second = await rejectWeeklyReport(reviewContext, {
      weeklyId: first.weeklyId,
      expectedVersion: 1,
      feedback: '把结论放在变化之前，背景再压缩。',
      revisedSections: first.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({
          ...item,
          changes: ['本周已完成验收分类口径确认。'],
        })),
      })),
    });

    expect(second).toMatchObject({
      version: 2,
      supersedesVersion: 1,
      acceptanceState: 'pending',
      publicationState: 'not_published',
    });
    await expect(readFile(progressPath)).resolves.toEqual(progressBytes);
    await expect(readFile(firstReportPath)).resolves.toEqual(firstReportBytes);
    await expect(progressRepository.listVersions('progress-jgf')).resolves.toHaveLength(1);

    const accepted = await acceptWeeklyReport({
      ...reviewContext,
      clock: () => new Date('2026-08-16T11:05:00.000Z'),
      id: () => 'review-event-2',
    }, {
      weeklyId: second.weeklyId,
      version: second.version,
    });

    expect(accepted).toMatchObject({
      action: 'accepted',
      weeklyId: 'weekly-2026-W33',
      version: 2,
      publicationState: 'not_published',
    });
    await expect(decisionRepository.listForWeekly('weekly-2026-W33'))
      .resolves.toMatchObject([
        { action: 'rejected', version: 1 },
        { action: 'accepted', version: 2 },
      ]);
  });

  it('uses the current sections when Obsidian supplies feedback without edited content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-weekly-feedback-'));
    roots.push(root);
    const progressRepository = new MarkdownProgressRepository(root);
    const weeklyRepository = new MarkdownWeeklyReportRepository(root);
    const decisionRepository = new FileWeeklyReviewDecisionRepository(root);
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };
    await createProgressVersion({
      repository: progressRepository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => 'progress-feedback',
    }, { draft: draft(), week });
    const first = await generateWeeklyReport({
      progressRepository,
      weeklyRepository,
      clock: () => new Date('2026-08-16T10:00:00.000Z'),
    }, { weekKey: '2026-W33', week });

    const second = await rejectWeeklyReportWithFeedback({
      weeklyRepository,
      decisionRepository,
      clock: () => new Date('2026-08-16T11:00:00.000Z'),
      id: () => 'review-feedback',
    }, {
      weeklyId: first.weeklyId,
      expectedVersion: first.version,
      feedback: '补充输出物入口。',
    });

    expect(second.version).toBe(2);
    expect(second.sections).toEqual(first.sections);
    await expect(decisionRepository.listForWeekly(first.weeklyId)).resolves.toMatchObject([
      { action: 'rejected', feedback: '补充输出物入口。', version: 1 },
    ]);
  });
});
