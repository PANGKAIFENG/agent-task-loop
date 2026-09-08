import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { contextRefSymlinkErrors } from '../../../src/domain/context-ref-resolution.js';

const temporaryRoots: string[] = [];

async function makeBase(prefix = 'atl-context-refs-'): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(base);
  return base;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('contextRefSymlinkErrors', () => {
  it('CR fix 2: rejects a ref that resolves through a symlink outside the allowlisted root', async () => {
    const base = await makeBase();
    const root = join(base, 'allowed');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.md'), 'secret');
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'));

    const errors = await contextRefSymlinkErrors([join(root, 'escape.md')], [root]);

    expect(errors).toEqual([
      `contextRefs entry escapes the allowlist through a symlink: ${join(root, 'escape.md')}`,
    ]);
  });

  it('CR fix 2: accepts symlinks whose targets stay inside the allowlisted root', async () => {
    const base = await makeBase();
    const root = join(base, 'allowed');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'note.md'), 'note');
    await symlink(join(root, 'docs', 'note.md'), join(root, 'alias.md'));

    const errors = await contextRefSymlinkErrors([join(root, 'alias.md')], [root]);

    expect(errors).toEqual([]);
  });

  it('ignores relative refs, missing paths, and runs with no configured roots', async () => {
    const base = await makeBase();
    const root = join(base, 'allowed');
    await mkdir(root);
    await writeFile(join(root, 'note.md'), 'note');

    expect(await contextRefSymlinkErrors(['docs/relative.md'], [root])).toEqual([]);
    expect(await contextRefSymlinkErrors([join(root, 'missing.md')], [root])).toEqual([]);
    // No roots configured: the lexical allowlist check owns the rejection.
    expect(await contextRefSymlinkErrors([join(root, 'note.md')], [])).toEqual([]);
  });
});
