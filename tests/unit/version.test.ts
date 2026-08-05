import { describe, expect, it } from 'vitest';

import rootManifest from '../../manifest.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };
import pluginManifest from '../../src/obsidian-plugin/manifest.json' with { type: 'json' };
import { ATL_VERSION } from '../../src/version.js';
import versions from '../../versions.json' with { type: 'json' };

describe('ATL_VERSION', () => {
  it('reports the current release version', () => {
    expect(ATL_VERSION).toBe('0.8.5');
  });

  it('matches every release manifest', () => {
    expect(ATL_VERSION).toBe(packageJson.version);
    expect(rootManifest.version).toBe('0.8.5');
    expect(pluginManifest.version).toBe('0.8.5');
    expect(versions['0.8.5']).toBe('1.11.4');
  });
});
