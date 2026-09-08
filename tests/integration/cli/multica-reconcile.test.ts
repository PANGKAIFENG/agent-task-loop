import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const temporaryRoots: string[] = [];

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<CliResult> {
  const root = await mkdtemp(join(tmpdir(), 'atl-multica-reconcile-'));
  temporaryRoots.push(root);
  const result = await execa('pnpm', ['exec', 'tsx', cli, ...args], {
    cwd: repositoryRoot,
    env: {
      ATL_VAULT_ROOT: root,
      ATL_ALLOW_REAL_WRITES: undefined,
    },
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('atl multica reconcile --max-tasks (CR fix 3)', () => {
  it('accepts a bounded decimal integer and reports an empty cycle', async () => {
    const result = await runCli(['multica', 'reconcile', '--max-tasks', '3', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ attempted: 0, remainingBacklog: 0 });
  });

  it.each([
    'nope',
    '5x',
    '0',
    '-1',
    '1e3',
    'Infinity',
    '3.0',
    '11',
  ])('rejects --max-tasks %s with the normalized CLI error', async (raw) => {
    const result = await runCli(['multica', 'reconcile', '--max-tasks', raw, '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_reconcile_option',
        message: expect.stringContaining('between 1 and 10'),
      },
    });
  });
});
