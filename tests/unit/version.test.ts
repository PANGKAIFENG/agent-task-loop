import { describe, expect, it } from 'vitest';

import { ATL_VERSION } from '../../src/version.js';

describe('ATL_VERSION', () => {
  it('matches the package version', () => {
    expect(ATL_VERSION).toBe('0.1.0');
  });
});
