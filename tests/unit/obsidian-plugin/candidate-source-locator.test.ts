import { describe, expect, it } from 'vitest';

import { locateMovedCandidateSource } from '../../../src/obsidian-plugin/candidate-source-locator.js';

describe('locateMovedCandidateSource', () => {
  it('returns only an exact source key match from bounded cached metadata', async () => {
    const files = [
      { path: 'Sources/unrelated.md' },
      { path: 'Moved/candidate.md' },
    ];

    await expect(locateMovedCandidateSource({
      sourceKey: 'synthetic:candidate:moved',
      files,
      metadataFor: (file) => file.path === 'Moved/candidate.md'
        ? { source_key: 'synthetic:candidate:moved' }
        : { source_key: 'synthetic:other' },
    })).resolves.toBe('Moved/candidate.md');
  });

  it('fails closed before inspecting metadata when the candidate set exceeds the bound', async () => {
    const files = Array.from({ length: 501 }, (_, index) => ({ path: `Sources/${index}.md` }));
    let inspected = 0;

    await expect(locateMovedCandidateSource({
      sourceKey: 'synthetic:candidate:moved',
      files,
      metadataFor: () => {
        inspected += 1;
        return { source_key: 'synthetic:candidate:moved' };
      },
    })).resolves.toBeNull();
    expect(inspected).toBe(0);
  });

  it('rejects ambiguous matches instead of choosing one silently', async () => {
    const files = [
      { path: 'Moved/one.md' },
      { path: 'Moved/two.md' },
    ];

    await expect(locateMovedCandidateSource({
      sourceKey: 'synthetic:candidate:moved',
      files,
      metadataFor: () => ({ source_key: 'synthetic:candidate:moved' }),
    })).resolves.toBeNull();
  });
});
