import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireProcessLock } from '../../../src/runner/process-lock.js';

const NOW = new Date('2026-07-15T01:00:00.000Z');
const roots: string[] = [];

async function runtimeRoot(): Promise<string> {
  const root = join(
    tmpdir(),
    `atl-process-lock-${process.pid}-${Date.now()}-${roots.length}`,
  );
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function seedLock(
  root: string,
  value: unknown,
): Promise<string> {
  const path = join(root, 'runner.lock');
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('acquireProcessLock', () => {
  it.each([
    ['live', { pid: 10, startedAt: '2026-07-14T00:00:00.000Z', token: 'old' }, true],
    ['young dead', { pid: 11, startedAt: '2026-07-15T00:30:00.000Z', token: 'old' }, false],
    ['invalid', '{not-json', false],
  ])('fails closed for a %s existing lock', async (_label, existing, pidAlive) => {
    const root = await runtimeRoot();
    const path = await seedLock(root, existing);
    const before = await readFile(path, 'utf8');

    await expect(acquireProcessLock({
      runtimeRoot: root,
      clock: () => NOW,
      pid: 99,
      isPidAlive: () => pidAlive,
      token: () => 'new-token',
    })).resolves.toBeNull();

    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('reclaims only a dead lock older than the 35 minute ceiling', async () => {
    const root = await runtimeRoot();
    const path = await seedLock(root, {
      pid: 10,
      startedAt: '2026-07-15T00:24:59.999Z',
      token: 'stale-token',
    });

    const handle = await acquireProcessLock({
      runtimeRoot: root,
      clock: () => NOW,
      pid: 99,
      isPidAlive: () => false,
      token: () => 'new-token',
    });

    expect(handle).not.toBeNull();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      pid: 99,
      startedAt: NOW.toISOString(),
      token: 'new-token',
    });
    await handle?.release();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a replacement lock during release', async () => {
    const root = await runtimeRoot();
    const path = join(root, 'runner.lock');
    const handle = await acquireProcessLock({
      runtimeRoot: root,
      clock: () => NOW,
      pid: 99,
      isPidAlive: () => false,
      token: () => 'owned-token',
    });
    expect(handle).not.toBeNull();

    await rm(path);
    const replacement = JSON.stringify({
      pid: 100,
      startedAt: NOW.toISOString(),
      token: 'replacement-token',
    });
    await writeFile(path, replacement);

    await handle?.release();

    expect(await readFile(path, 'utf8')).toBe(replacement);
  });
});
