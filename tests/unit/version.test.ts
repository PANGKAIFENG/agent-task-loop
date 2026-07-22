import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { ATL_VERSION } from '../../src/version.js';

describe('ATL_VERSION', () => {
  it('reports the current release version', () => {
    expect(ATL_VERSION).toBe('0.5.7');
  });

  it('matches the package version', () => {
    expect(ATL_VERSION).toBe(packageJson.version);
  });
});
