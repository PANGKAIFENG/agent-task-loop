import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('V0.2 synthetic loop release gate', () => {
  it('completes locally without invoking a caller-provided Multica binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-v02-loop-gate-'));
    temporaryRoots.push(root);
    const invocationMarker = join(root, 'multica-invoked');
    const fakeMultica = join(root, 'fake-multica');
    await writeFile(fakeMultica, [
      '#!/bin/sh',
      `printf invoked > ${JSON.stringify(invocationMarker)}`,
      'exit 91',
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeMultica, 0o700);

    const result = await execa('node', ['scripts/run-v0.2-synthetic-loop.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, ATL_MULTICA_BINARY: fakeMultica },
      reject: false,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      finalState: 'synthetic_loop_verified',
      checks: { explicitAgentAdmission: true },
    });
    await expect(access(invocationMarker)).rejects.toThrow();
    expect(await readFile(fakeMultica, 'utf8')).toContain('exit 91');
  }, 60_000);
});
