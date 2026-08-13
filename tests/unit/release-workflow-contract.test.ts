import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('release workflow contract', () => {
  it('builds and verifies a universal executable Qianwen helper on macOS', async () => {
    const [workflow, helperBuild] = await Promise.all([
      readFile('.github/workflows/release.yml', 'utf8'),
      readFile('scripts/build-qianwen-helper.mjs', 'utf8'),
    ]);

    expect(workflow).toContain('runs-on: macos-14');
    expect(helperBuild).toContain("'-arch',\n    'arm64'");
    expect(helperBuild).toContain("'-arch',\n    'x86_64'");
    expect(workflow).toContain(
      'lipo build/obsidian-plugin/qianwen-accessibility-helper -verify_arch arm64 x86_64',
    );
    expect(workflow).toContain('test -x build/obsidian-plugin/qianwen-accessibility-helper');
  });

  it('ships the helper in both the installable ZIP and release assets', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toMatch(/zip[^\n]*qianwen-accessibility-helper/u);
    expect(workflow).toContain(
      'build/obsidian-plugin/qianwen-accessibility-helper#qianwen-accessibility-helper',
    );
    expect(workflow).toContain('test -x "$PACKAGE_ROOT/qianwen-accessibility-helper"');
    expect(workflow).toContain(
      'lipo "$PACKAGE_ROOT/qianwen-accessibility-helper" -verify_arch arm64 x86_64',
    );
  });

  it('ships the DingTalk bridge in both the installable ZIP and release assets', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('test -f build/obsidian-plugin/atl-dingtalk-bridge.mjs');
    expect(workflow).toMatch(/zip[^\n]*atl-dingtalk-bridge\.mjs/u);
    expect(workflow).toContain(
      'build/obsidian-plugin/atl-dingtalk-bridge.mjs#atl-dingtalk-bridge.mjs',
    );
  });
});
