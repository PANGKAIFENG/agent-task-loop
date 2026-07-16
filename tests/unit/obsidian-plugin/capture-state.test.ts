import { describe, expect, it } from 'vitest';

import {
  MAX_REVIEWED_FINGERPRINTS,
  compactReviewedFingerprints,
  normalizeSettings,
} from '../../../src/obsidian-plugin/settings.js';

describe('capture state', () => {
  it('keeps a valid ISO scan checkpoint and unique lowercase SHA-256 fingerprints', () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);

    expect(normalizeSettings({
      capture: {
        lastSuccessfulScanAt: '2026-07-17T12:30:00.000Z',
        reviewedFingerprints: [first, second, first],
      },
    }).capture).toEqual({
      lastSuccessfulScanAt: '2026-07-17T12:30:00.000Z',
      reviewedFingerprints: [first, second],
    });
  });

  it('keeps only the latest 10,000 valid unique fingerprints', () => {
    const values = Array.from(
      { length: MAX_REVIEWED_FINGERPRINTS + 2 },
      (_, index) => index.toString(16).padStart(64, '0'),
    );

    const compacted = compactReviewedFingerprints([
      'not-a-fingerprint',
      values[0]!,
      ...values,
      'F'.repeat(64),
    ]);

    expect(compacted).toHaveLength(MAX_REVIEWED_FINGERPRINTS);
    expect(compacted[0]).toBe(values[2]);
    expect(compacted.at(-1)).toBe(values.at(-1));
  });
});
