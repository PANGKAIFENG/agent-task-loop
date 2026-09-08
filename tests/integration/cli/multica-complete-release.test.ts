import { join } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cli = join(process.cwd(), 'src', 'cli.ts');

describe('atl multica complete-release', () => {
  it('is a distinct post-deployment command with no release-action options', async () => {
    const result = await execa('pnpm', [
      'exec', 'tsx', cli, 'multica', 'complete-release', '--help',
    ], { reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Complete an already-published release');
    expect(result.stdout).toContain('--evidence-file <path>');
    expect(result.stdout).not.toContain('--workdir');
    expect(result.stdout).not.toContain('--plugin-dir');
    expect(result.stdout).not.toContain('--fresh-review-ref');
  });

  it('fails closed before writes when evidence is missing', async () => {
    const result = await execa('pnpm', [
      'exec', 'tsx', cli, 'multica', 'complete-release',
      '--task-id', 'task-20260821-rel00001',
      '--evidence-file', '/synthetic/missing-evidence.json',
      '--json',
    ], { reject: false });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_cli_input',
        message: 'post-deployment evidence file must be a single JSON object',
      },
    });
  });
});
