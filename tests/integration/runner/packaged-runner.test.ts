import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const runnerPath = join(
  repositoryRoot,
  'build',
  'obsidian-plugin',
  'atl-runner.mjs',
);

beforeAll(async () => {
  await execa('pnpm', ['build:runner'], { cwd: repositoryRoot });
}, 30_000);

describe('packaged ATL runner', () => {
  it('runs as a standalone Node entry and reports the release version', async () => {
    await access(runnerPath);

    const result = await execa(process.execPath, [runnerPath, '--version']);

    expect(result.stdout).toBe('0.2.0');
  });
});
