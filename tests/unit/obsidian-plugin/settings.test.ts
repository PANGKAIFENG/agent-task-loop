import { describe, expect, it } from 'vitest';

import {
  backgroundActionState,
  modelServiceConfiguration,
  modelServiceFieldState,
  normalizeSettings,
} from '../../../src/obsidian-plugin/settings.js';

describe('normalizeSettings', () => {
  it('migrates v0.1 settings and supplies conservative background defaults', () => {
    expect(normalizeSettings({ allowVaultManagement: true })).toEqual({
      allowVaultManagement: true,
      taskCardThemeEnabled: true,
      capture: {
        lastSuccessfulScanAt: null,
        reviewedFingerprints: [],
        processedRecordFingerprints: [],
      },
      background: {
        nodeExecutable: '',
        claudeExecutable: '',
        claudeConfigDirectory: '',
        allowedLocalRoots: [],
        modelServiceMode: 'inherit',
        model: 'claude-sonnet-4-5',
        baseUrl: '',
        dailyLimit: 3,
      },
    });
  });

  it('sanitizes malformed persisted settings without accepting shell-like values', () => {
    expect(normalizeSettings({
      allowVaultManagement: 'yes',
      taskCardThemeEnabled: false,
      capture: {
        lastSuccessfulScanAt: null,
        reviewedFingerprints: [],
        processedRecordFingerprints: [],
      },
      background: {
        nodeExecutable: 24,
        claudeExecutable: '/valid-looking/claude',
        claudeConfigDirectory: null,
        allowedLocalRoots: ['/research', 3, '', '/research'],
        modelServiceMode: 'provider',
        model: 'bad model; rm -rf /',
        baseUrl: 'file:///etc/passwd',
        dailyLimit: -8,
      },
    })).toEqual({
      allowVaultManagement: false,
      taskCardThemeEnabled: false,
      capture: {
        lastSuccessfulScanAt: null,
        reviewedFingerprints: [],
        processedRecordFingerprints: [],
      },
      background: {
        nodeExecutable: '',
        claudeExecutable: '/valid-looking/claude',
        claudeConfigDirectory: '',
        allowedLocalRoots: ['/research'],
        modelServiceMode: 'inherit',
        model: 'claude-sonnet-4-5',
        baseUrl: '',
        dailyLimit: 3,
      },
    });
  });

  it('migrates a complete legacy custom endpoint without changing its provider', () => {
    expect(normalizeSettings({
      background: {
        model: 'glm-4-flash',
        baseUrl: 'https://api.example.com/anthropic',
      },
    }).background).toMatchObject({
      modelServiceMode: 'custom',
      model: 'glm-4-flash',
      baseUrl: 'https://api.example.com/anthropic',
    });
  });

  it('drops malformed capture state without retaining source-shaped values', () => {
    expect(normalizeSettings({
      capture: {
        lastSuccessfulScanAt: 'yesterday evening',
        reviewedFingerprints: [
          'source note content',
          'A'.repeat(64),
          'a'.repeat(63),
          42,
        ],
      },
    }).capture).toEqual({
      lastSuccessfulScanAt: null,
      reviewedFingerprints: [],
      processedRecordFingerprints: [],
    });
  });
});

describe('modelServiceConfiguration', () => {
  it('omits overrides when ATL follows the current Claude Code configuration', () => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'inherit',
      model: 'ignored-model',
      baseUrl: 'https://ignored.example.com',
    })).toEqual({
      valid: true,
      model: undefined,
      baseUrl: undefined,
      modelError: null,
      baseUrlError: null,
    });
  });

  it('accepts a complete custom model service', () => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'glm-4-flash',
      baseUrl: 'https://api.example.com/anthropic/',
    })).toEqual({
      valid: true,
      model: 'glm-4-flash',
      baseUrl: 'https://api.example.com/anthropic/',
      modelError: null,
      baseUrlError: null,
    });
  });

  it('rejects plain HTTP for remote model services', () => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'glm-4-flash',
      baseUrl: 'http://api.example.com/anthropic',
    })).toMatchObject({
      valid: false,
      baseUrl: undefined,
      baseUrlError: 'Base URL 必须使用 HTTPS；本机地址可以使用 HTTP。',
    });
  });

  it('does not treat a hostname beginning with 127 as loopback', () => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'glm-4-flash',
      baseUrl: 'http://127.example.com/anthropic',
    })).toMatchObject({
      valid: false,
      baseUrl: undefined,
      baseUrlError: 'Base URL 必须使用 HTTPS；本机地址可以使用 HTTP。',
    });
  });

  it.each([
    'http://localhost:8080/anthropic',
    'http://127.0.0.1:8080/anthropic',
    'http://[::1]:8080/anthropic',
  ])('allows HTTP for a loopback model service: %s', (baseUrl) => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'local-model',
      baseUrl,
    })).toMatchObject({
      valid: true,
      baseUrl,
      baseUrlError: null,
    });
  });

  it.each([
    'file:///etc/passwd',
    'https://user:secret@example.com/anthropic',
    'https://api.example.com/anthropic?token=secret',
    'https://api.example.com/anthropic#credentials',
    'not-a-url',
  ])('rejects an unsafe custom Base URL: %s', (baseUrl) => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'glm-4-flash',
      baseUrl,
    })).toMatchObject({
      valid: false,
      baseUrl: undefined,
      baseUrlError: 'Base URL 必须是完整的 http 或 https 地址。',
    });
  });

  it('rejects a shell-like model name', () => {
    expect(modelServiceConfiguration({
      modelServiceMode: 'custom',
      model: 'glm; rm -rf /',
      baseUrl: 'https://api.example.com',
    })).toMatchObject({
      valid: false,
      model: undefined,
      modelError: 'Model 格式无效，请检查模型名称。',
    });
  });
});

describe('modelServiceFieldState', () => {
  it('hides custom fields while inheriting Claude Code configuration', () => {
    expect(modelServiceFieldState({
      modelServiceMode: 'inherit',
      model: '',
      baseUrl: '',
    })).toEqual({
      showCustomFields: false,
      canApply: true,
      modelError: null,
      baseUrlError: null,
    });
  });

  it('shows custom fields and prevents applying invalid values', () => {
    expect(modelServiceFieldState({
      modelServiceMode: 'custom',
      model: '',
      baseUrl: 'not-a-url',
    })).toEqual({
      showCustomFields: true,
      canApply: false,
      modelError: 'Model 格式无效，请检查模型名称。',
      baseUrlError: 'Base URL 必须是完整的 http 或 https 地址。',
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
