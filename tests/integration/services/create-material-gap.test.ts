import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMaterialGap } from '../../../src/services/create-material-gap.js';
import { MarkdownMaterialGapRepository } from '../../../src/storage/markdown-material-gap-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('create material gap', () => {
  it('persists the search trail and an authorization-required message draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-material-gap-'));
    roots.push(root);
    const repository = new MarkdownMaterialGapRepository(root);

    const gap = await createMaterialGap({
      repository,
      clock: () => new Date('2026-08-11T02:02:00.000Z'),
      id: () => 'gap-jgf-table',
    }, {
      progressId: 'progress-jgf-classification',
      progressVersion: 1,
      missing: {
        kind: 'document',
        description: '精恭纺验收分类表',
        purpose: '核验本周项目验收进展',
      },
      searches: [{
        source: 'dingtalk_doc',
        target: 'synthetic-table',
        status: 'permission_denied',
        searchedAt: '2026-08-11T02:01:00.000Z',
        sourceRef: 'dingtalk://document/synthetic-table',
      }],
      suggestedContact: {
        userId: 'synthetic-user',
        displayName: '材料维护人',
        reason: '日程组织者且在会议中被明确提及为表格维护人',
        sourceRef: '08_Meetings/2026-08/synthetic-meeting.md',
      },
    });

    expect(gap.messageDraft).toMatchObject({
      state: 'draft',
      authorization: 'required',
      delivery: null,
    });
    await expect(repository.get('gap-jgf-table')).resolves.toEqual(gap);
    const raw = await readFile(join(
      root,
      '09_Progress',
      'Requests',
      '2026-08',
      'gap-jgf-table.md',
    ), 'utf8');
    expect(raw).toContain('permission_denied');
    expect(raw).toContain('authorization: required');
    expect(raw).toContain('精恭纺验收分类表');
    await expect(repository.list()).resolves.toEqual([gap]);
  });
});
