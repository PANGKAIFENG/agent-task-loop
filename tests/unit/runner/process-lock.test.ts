import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const staleReclaimRace = vi.hoisted(() => {
  let targetPath: string | null = null;
  let removeArrivals = 0;
  let reclaimArrivals = 0;
  let staleRemoved = false;
  let releaseFirstRemove: (() => void) | null = null;
  let releaseFirstReclaim: (() => void) | null = null;
  let releaseSecondRemove: (() => void) | null = null;
  let firstRemoveReady = Promise.resolve();
  let firstReclaimReady = Promise.resolve();
  let replacementReady = Promise.resolve();

  return {
    enable(path: string) {
      targetPath = path;
      removeArrivals = 0;
      reclaimArrivals = 0;
      staleRemoved = false;
      firstRemoveReady = new Promise((resolve) => {
        releaseFirstRemove = resolve;
      });
      firstReclaimReady = new Promise((resolve) => {
        releaseFirstReclaim = resolve;
      });
      replacementReady = new Promise((resolve) => {
        releaseSecondRemove = resolve;
      });
    },
    disable() {
      targetPath = null;
      releaseFirstRemove?.();
      releaseFirstReclaim?.();
      releaseSecondRemove?.();
    },
    async opening(path: unknown) {
      if (typeof path !== 'string' || path !== `${targetPath}.reclaim`) {
        return;
      }
      reclaimArrivals += 1;
      if (reclaimArrivals === 1) {
        await firstReclaimReady;
        return;
      }
      if (reclaimArrivals === 2) {
        releaseFirstReclaim?.();
        releaseFirstRemove?.();
      }
    },
    async remove(path: unknown, operation: () => Promise<void>) {
      if (path !== targetPath) {
        return operation();
      }
      removeArrivals += 1;
      const arrival = removeArrivals;
      if (arrival === 1) {
        await firstRemoveReady;
        await operation();
        staleRemoved = true;
        return;
      }
      if (arrival === 2) {
        releaseFirstRemove?.();
        await replacementReady;
      }
      await operation();
    },
    opened(path: unknown) {
      if (path === targetPath && staleRemoved) {
        releaseSecondRemove?.();
      }
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      await staleReclaimRace.opening(args[0]);
      const handle = await actual.open(...args);
      staleReclaimRace.opened(args[0]);
      return handle;
    },
    async rm(...args: Parameters<typeof actual.rm>) {
      return staleReclaimRace.remove(args[0], () => actual.rm(...args));
    },
  };
});

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

  it('allows only one cooperative reclaimer to replace a stale lock', async () => {
    const root = await runtimeRoot();
    const path = await seedLock(root, {
      pid: 10,
      startedAt: '2026-07-15T00:24:59.999Z',
      token: 'stale-token',
    });
    staleReclaimRace.enable(path);

    const handles = await Promise.all([
      acquireProcessLock({
        runtimeRoot: root,
        clock: () => NOW,
        pid: 98,
        isPidAlive: () => false,
        token: () => 'first-token',
      }),
      acquireProcessLock({
        runtimeRoot: root,
        clock: () => NOW,
        pid: 99,
        isPidAlive: () => false,
        token: () => 'second-token',
      }),
    ]);
    staleReclaimRace.disable();

    expect(handles.filter((handle) => handle !== null)).toHaveLength(1);
    await Promise.all(handles.map((handle) => handle?.release()));
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
