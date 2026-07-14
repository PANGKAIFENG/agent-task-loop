import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json' with { type: 'json' };
import { ATL_VERSION } from '../../src/version.js';

describe('ATL_VERSION', () => {
  it('matches the package version', () => {
    expect(ATL_VERSION).toBe(packageJson.version);
  });
});
