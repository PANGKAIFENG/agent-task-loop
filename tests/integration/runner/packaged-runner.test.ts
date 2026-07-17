import {
  access,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import type { Task } from '../../../src/domain/task.js';

const repositoryRoot = process.cwd();
const runnerPath = join(
  repositoryRoot,
  'build',
  'obsidian-plugin',
  'atl-runner.mjs',
);
const temporaryRoots: string[] = [];

beforeAll(async () => {
  await execa('pnpm', ['build:runner'], { cwd: repositoryRoot });
}, 30_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('packaged ATL runner', () => {
  it('runs as a standalone Node entry and reports the release version', async () => {
    await access(runnerPath);

    const result = await execa(process.execPath, [runnerPath, '--version']);

    expect(result.stdout).toBe('0.3.1');
  });

  it('deduplicates daily and real-time stdin capture in the packaged runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-packaged-capture-'));
    temporaryRoots.push(root);
    const common = {
      title: '恢复 Agent 产品情报雷达',
      body: '检查并恢复每日推送。',
      sourceDate: '2026-07-16',
      sourceNote: '笔记同步助手/2026-07-16/同步助手_2026-07-16.md',
      sourceQuote: '需要恢复 Agent 产品情报雷达的每日推送',
      priority: 'normal',
    };
    for (const input of [
      {
        ...common,
        origin: 'explicit_wechat_todo',
        sourceKey: 'daily-review:packaged:radar',
      },
      {
        ...common,
        origin: 'obsidian_sync',
        sourceKey: 'obsidian-sync:packaged:radar',
      },
    ]) {
      const result = await execa(
        process.execPath,
        [runnerPath, 'task', 'capture', '--stdin-json', '--json'],
        {
          env: { ATL_VAULT_ROOT: root },
          input: JSON.stringify(input),
        },
      );
      expect((JSON.parse(result.stdout) as Task).title).toBe(common.title);
    }

    const listed = await execa(
      process.execPath,
      [runnerPath, 'task', 'list', '--json'],
      { env: { ATL_VAULT_ROOT: root } },
    );
    expect(JSON.parse(listed.stdout) as Task[]).toHaveLength(1);
  });
});
