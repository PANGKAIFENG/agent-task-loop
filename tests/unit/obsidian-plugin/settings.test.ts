import { describe, expect, it } from 'vitest';

import {
  backgroundActionState,
  normalizeSettings,
} from '../../../src/obsidian-plugin/settings.js';

describe('normalizeSettings', () => {
  it('migrates v0.1 settings and supplies conservative background defaults', () => {
    expect(normalizeSettings({ allowVaultManagement: true })).toEqual({
      allowVaultManagement: true,
      taskCardThemeEnabled: true,
      background: {
        nodeExecutable: '',
        claudeExecutable: '',
        claudeConfigDirectory: '',
        allowedLocalRoots: [],
        model: 'claude-sonnet-4-5',
        dailyLimit: 3,
      },
    });
  });

  it('sanitizes malformed persisted settings without accepting shell-like values', () => {
    expect(normalizeSettings({
      allowVaultManagement: 'yes',
      taskCardThemeEnabled: false,
      background: {
        nodeExecutable: 24,
        claudeExecutable: '/valid-looking/claude',
        claudeConfigDirectory: null,
        allowedLocalRoots: ['/research', 3, '', '/research'],
        model: 'bad model; rm -rf /',
        dailyLimit: -8,
      },
    })).toEqual({
      allowVaultManagement: false,
      taskCardThemeEnabled: false,
      background: {
        nodeExecutable: '',
        claudeExecutable: '/valid-looking/claude',
        claudeConfigDirectory: '',
        allowedLocalRoots: ['/research'],
        model: 'claude-sonnet-4-5',
        dailyLimit: 3,
      },
    });
  });
});

describe('backgroundActionState', () => {
  it('derives bounded actions for every visible runtime state', () => {
    expect(backgroundActionState({ state: 'installable' })).toEqual({
      primaryLabel: '启用后台执行',
      canRunNow: false,
      canDisable: false,
    });
    expect(backgroundActionState({ state: 'ready' })).toEqual({
      primaryLabel: '更新后台配置',
      canRunNow: true,
      canDisable: true,
    });
    expect(backgroundActionState({ state: 'running' })).toEqual({
      primaryLabel: '更新后台配置',
      canRunNow: false,
      canDisable: true,
    });
    expect(backgroundActionState({ state: 'error' })).toEqual({
      primaryLabel: '重新检测',
      canRunNow: false,
      canDisable: true,
    });
    expect(backgroundActionState({ state: 'unconfigured' })).toEqual({
      primaryLabel: '检测环境',
      canRunNow: false,
      canDisable: false,
    });
  });
});
