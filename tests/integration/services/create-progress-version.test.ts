import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProgressDraft } from '../../../src/domain/progress.js';
import {
  createProgressVersion,
  reviseProgressVersion,
} from '../../../src/services/create-progress-version.js';
import { MarkdownProgressRepository } from '../../../src/storage/markdown-progress-repository.js';

const roots: string[] = [];

async function makeRepository(): Promise<{
  root: string;
  repository: MarkdownProgressRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'atl-progress-'));
  roots.push(root);
  return { root, repository: new MarkdownProgressRepository(root) };
}

function draft(topic: string, projectId: string): ProgressDraft {
  const source = '08_Meetings/2026-08/synthetic-meeting.md';
  return {
    topic,
    reportCategory: 'project_acceptance',
    primaryProjectId: projectId,
    occurredAt: '2026-08-10T16:00:00+08:00',
    sources: [source],
    statements: [{
      kind: 'fact',
      text: `${topic}已形成确认结论。`,
      sourceRefs: [source],
    }],
    evidence: [{
      kind: 'confirmed_decision',
      summary: `${topic}结论已确认`,
      sourceRef: source,
    }],
    selfEvidence: [],
    agentEvidence: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('create progress version', () => {
  it('persists independently owned topics without creating tasks', async () => {
    const { root, repository } = await makeRepository();
    const ids = ['progress-jgf-classification', 'progress-jgf-payment'];
    const context = {
      repository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => ids.shift() ?? 'unexpected',
    };
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };

    const classification = await createProgressVersion(context, {
      draft: draft('验收分类', 'project-jinggongfang'),
      week,
    });
    const payment = await createProgressVersion(context, {
      draft: draft('回款节点', 'project-finance'),
      week,
    });

    expect(classification).toMatchObject({
      progressId: 'progress-jgf-classification',
      version: 1,
      primaryProjectId: 'project-jinggongfang',
      lifecycleStatus: 'eligible',
    });
    expect(payment).toMatchObject({
      progressId: 'progress-jgf-payment',
      version: 1,
      primaryProjectId: 'project-finance',
      lifecycleStatus: 'eligible',
    });
    await expect(repository.listCurrent()).resolves.toHaveLength(2);
    await expect(readdir(join(root, '09_Progress', 'Items', '2026-08')))
      .resolves.toEqual([
        'progress-jgf-classification-v1.md',
        'progress-jgf-payment-v1.md',
      ]);
    await expect(readdir(join(root, '10_Tasks'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates an immutable new version instead of overwriting the prior version', async () => {
    const { root, repository } = await makeRepository();
    const context = {
      repository,
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => 'progress-jgf-classification',
    };
    const week = { startDate: '2026-08-10', endDate: '2026-08-16' };
    await createProgressVersion(context, {
      draft: draft('验收分类', 'project-jinggongfang'),
      week,
    });
    const firstPath = join(
      root,
      '09_Progress',
      'Items',
      '2026-08',
      'progress-jgf-classification-v1.md',
    );
    const firstBytes = await readFile(firstPath);

    const second = await reviseProgressVersion(context, {
      progressId: 'progress-jgf-classification',
      expectedVersion: 1,
      draft: {
        ...draft('验收分类', 'project-jinggongfang'),
        statements: [{
          kind: 'fact',
          text: '验收分类口径已根据新证据确认。',
          sourceRefs: ['08_Meetings/2026-08/synthetic-meeting.md'],
        }],
      },
      week,
    });

    expect(second).toMatchObject({
      progressId: 'progress-jgf-classification',
      version: 2,
      supersedesVersion: 1,
    });
    await expect(readFile(firstPath)).resolves.toEqual(firstBytes);
    await expect(repository.listVersions('progress-jgf-classification'))
      .resolves.toHaveLength(2);
    await expect(repository.listCurrent()).resolves.toEqual([second]);
  });
});
