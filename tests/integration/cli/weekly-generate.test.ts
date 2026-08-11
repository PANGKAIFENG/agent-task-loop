import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import { createProgressVersion } from '../../../src/services/create-progress-version.js';
import { MarkdownProgressRepository } from '../../../src/storage/markdown-progress-repository.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atl weekly generate', () => {
  it('creates a pending weekly snapshot from eligible progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-cli-weekly-'));
    roots.push(root);
    const source = '08_Meetings/2026-08/synthetic-meeting.md';
    await createProgressVersion({
      repository: new MarkdownProgressRepository(root),
      clock: () => new Date('2026-08-11T01:00:00.000Z'),
      id: () => 'progress-synthetic-weekly',
    }, {
      week: { startDate: '2026-08-10', endDate: '2026-08-16' },
      draft: {
        topic: '合成项目验收进展',
        reportCategory: 'project_acceptance',
        primaryProjectId: 'project-synthetic',
        occurredAt: '2026-08-11T09:00:00+08:00',
        sources: [source],
        statements: [{
          kind: 'fact',
          text: '合成验收口径已确认。',
          sourceRefs: [source],
        }],
        evidence: [{
          kind: 'confirmed_decision',
          summary: '按合成分类输出验收结果',
          sourceRef: source,
        }],
        selfEvidence: [],
        agentEvidence: [],
      },
    });

    const result = await execa('pnpm', [
      'exec', 'tsx', cli,
      'weekly', 'generate',
      '--week-key', '2026-W33',
      '--start-date', '2026-08-10',
      '--end-date', '2026-08-16',
      '--json',
    ], {
      cwd: repositoryRoot,
      env: {
        ATL_VAULT_ROOT: root,
        ATL_DINGTALK_PROFILE: '',
      },
      reject: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      weeklyId: 'weekly-2026-W33',
      version: 1,
      acceptanceState: 'pending',
      progressRefs: [{ progressId: 'progress-synthetic-weekly', version: 1 }],
    });
    await expect(readFile(join(
      root,
      '09_Progress',
      'Weekly',
      '2026-W33-v1.md',
    ), 'utf8')).resolves.toContain('# 2026-W33 工作进展周报');
  }, 30_000);
});
