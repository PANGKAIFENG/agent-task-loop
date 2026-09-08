import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCandidateSource } from '../../../src/services/resolve-candidate-source.js';

const roots: string[] = [];
const NOW = new Date('2026-08-22T09:00:00.000Z');

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'atl-candidate-source-'));
  roots.push(path);
  return path;
}

function seed(overrides: Record<string, unknown> = {}) {
  return {
    sourceRefId: 'source-synthetic-1',
    sourceType: 'sync_note',
    sourceKey: 'synthetic:source-1',
    sourceNote: 'Sources/record.md',
    quote: '核对三条能力声明',
    capturedAt: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveCandidateSource', () => {
  it('resolves one exact quote with bounded parent context and verification evidence', async () => {
    const vault = await root();
    await mkdir(join(vault, 'Sources'), { recursive: true });
    await writeFile(join(vault, 'Sources', 'record.md'), [
      '# 合成来源',
      '共同意图：形成竞品判断。',
      '待办：核对三条能力声明。',
      '相邻条目：整理官方页面。',
      '不相关内容不应进入 parent context。',
    ].join('\n'));

    const resolved = await resolveCandidateSource({ root: vault, seed: seed(), now: NOW });

    expect(resolved).toMatchObject({
      status: 'available',
      anchor: 'line:3',
      quote: '核对三条能力声明',
      failureReason: null,
      lastVerifiedAt: NOW.toISOString(),
      lastVerifiedEvidence: {
        resolvedNote: 'Sources/record.md',
        quoteMatched: true,
        truncated: false,
      },
    });
    expect(resolved.parentContext).toContain('共同意图');
    expect(resolved.parentContext).toContain('相邻条目');
    expect(resolved.parentContext).not.toContain('不相关内容');
    expect(resolved.parentContext?.length).toBeLessThanOrEqual(1_000);
  });

  it('distinguishes moved, changed, unavailable, and missing sources', async () => {
    const vault = await root();
    await mkdir(join(vault, 'Moved'), { recursive: true });
    await writeFile(join(vault, 'Moved', 'record.md'), '待办：核对三条能力声明。');
    await writeFile(join(vault, 'Moved', 'changed-record.md'), '待办：改为核对一条声明。');
    await mkdir(join(vault, 'Sources'), { recursive: true });
    await writeFile(join(vault, 'Sources', 'changed.md'), '待办：改为核对两条声明。');

    const moved = await resolveCandidateSource({
      root: vault,
      seed: seed(),
      now: NOW,
      locateMoved: async (sourceKey) => (
        sourceKey === 'synthetic:source-1' ? 'Moved/record.md' : null
      ),
    });
    const changed = await resolveCandidateSource({
      root: vault,
      seed: seed({ sourceNote: 'Sources/changed.md' }),
      now: NOW,
    });
    const movedAndChanged = await resolveCandidateSource({
      root: vault,
      seed: seed({ sourceKey: 'synthetic:moved-and-changed' }),
      now: NOW,
      locateMoved: async (sourceKey) => (
        sourceKey === 'synthetic:moved-and-changed' ? 'Moved/changed-record.md' : null
      ),
    });
    const unavailable = await resolveCandidateSource({
      root: vault,
      seed: seed({ sourceKey: 'synthetic:not-found' }),
      now: NOW,
    });
    const missing = await resolveCandidateSource({
      root: vault,
      seed: seed({ sourceNote: null, sourceKey: '' }),
      now: NOW,
    });

    expect(moved).toMatchObject({
      status: 'moved',
      sourceNote: 'Moved/record.md',
      failureReason: 'source_moved',
    });
    expect(changed).toMatchObject({
      status: 'changed',
      failureReason: 'source_quote_changed',
      quote: '核对三条能力声明',
    });
    expect(movedAndChanged).toMatchObject({
      status: 'changed',
      sourceNote: 'Moved/changed-record.md',
      failureReason: 'source_moved_quote_changed',
      lastVerifiedAt: NOW.toISOString(),
      lastVerifiedEvidence: {
        resolvedNote: 'Moved/changed-record.md',
        quoteMatched: false,
      },
    });
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      failureReason: 'source_not_found',
    });
    expect(missing).toMatchObject({
      status: 'missing',
      failureReason: 'source_reference_missing',
    });
  });

  it.each([
    ['../outside.md', 'source_path_outside_root'],
    ['/tmp/outside.md', 'source_path_outside_root'],
    ['Sources/control\u0000.md', 'source_path_invalid'],
  ])('fails closed for unsafe path %s', async (sourceNote, failureReason) => {
    const vault = await root();
    const resolved = await resolveCandidateSource({
      root: vault,
      seed: seed({ sourceNote }),
      now: NOW,
    });

    expect(resolved).toMatchObject({ status: 'unavailable', failureReason });
    expect(resolved.lastVerifiedEvidence).toBeNull();
  });

  it('fails closed for symlinked files even when their target stays inside the root', async () => {
    const vault = await root();
    await mkdir(join(vault, 'Sources'), { recursive: true });
    await writeFile(join(vault, 'Sources', 'target.md'), '待办：核对三条能力声明。');
    await symlink('target.md', join(vault, 'Sources', 'record.md'));

    const resolved = await resolveCandidateSource({ root: vault, seed: seed(), now: NOW });

    expect(resolved).toMatchObject({
      status: 'unavailable',
      failureReason: 'source_symlink_rejected',
    });
    expect(resolved.lastVerifiedEvidence).toBeNull();
  });

  it('does not read an oversized source into model context', async () => {
    const vault = await root();
    await mkdir(join(vault, 'Sources'), { recursive: true });
    await writeFile(join(vault, 'Sources', 'record.md'), `${'x'.repeat(64_001)}核对三条能力声明`);

    const resolved = await resolveCandidateSource({ root: vault, seed: seed(), now: NOW });

    expect(resolved).toMatchObject({
      status: 'unavailable',
      failureReason: 'source_read_limit_exceeded',
    });
    expect(resolved.lastVerifiedEvidence).toMatchObject({
      checkedCharacters: 0,
      quoteMatched: false,
      truncated: true,
    });
    expect(resolved.parentContext).toBeNull();
  });
});
