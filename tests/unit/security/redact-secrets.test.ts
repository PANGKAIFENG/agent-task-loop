import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../../../src/security/redact-secrets.js';

describe('redactSecrets', () => {
  it.each([
    ['database password', 'DB_PASSWORD=database-private-value', 'database-private-value'],
    ['DingTalk secret', 'DINGTALK_APP_SECRET: dingtalk-private-value', 'dingtalk-private-value'],
    ['Anthropic token', 'ANTHROPIC_AUTH_TOKEN=anthropic-private-value', 'anthropic-private-value'],
    ['OpenAI key', 'OPENAI_API_KEY=opaque-openai-private-value', 'opaque-openai-private-value'],
    ['generic token', 'token: generic-private-value', 'generic-private-value'],
    ['quoted JSON value', '"password": "json private value"', 'json private value'],
    ['camelCase password', '"dbPassword": "camel private value"', 'camel private value'],
    ['camelCase API key', '"openaiApiKey": "camel api private value"', 'camel api private value'],
  ])('redacts a prefixed or generic %s assignment', (_label, source, secret) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts the complete value of a YAML credential block', () => {
    const source = [
      'service:',
      '  password: |',
      '    first-private-line',
      '',
      '    second-private-line',
      '  endpoint: https://example.com',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('first-private-line');
    expect(redacted).not.toContain('second-private-line');
    expect(redacted).toContain('endpoint: https://example.com');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['explicit indentation', [
      'service:',
      '  password: |2',
      '    first-private-line',
      '    second-private-line',
      '  endpoint: https://example.com',
    ].join('\n')],
    ['sequence entry', [
      'services:',
      '  - password: |',
      '      first-private-line',
      '      second-private-line',
      '    endpoint: https://example.com',
    ].join('\n')],
    ['tagged block', [
      'service:',
      '  password: !!str |',
      '    first-private-line',
      '    second-private-line',
      '  endpoint: https://example.com',
    ].join('\n')],
    ['anchored block', [
      'service:',
      '  password: &credential >-',
      '    first-private-line',
      '    second-private-line',
      '  endpoint: https://example.com',
    ].join('\n')],
  ])('redacts a complete YAML %s credential block', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('first-private-line');
    expect(redacted).not.toContain('second-private-line');
    expect(redacted).toContain('endpoint: https://example.com');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts an entire compact JSON credential with an escaped quote', () => {
    const source = JSON.stringify({
      dbPassword: 'prefix-private"suffix-private',
      endpoint: 'https://example.com',
    });

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('https://example.com');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['single-quoted compact scalar', [
      "{dbPassword: 'prefix-private''suffix-private', next: keep}",
    ].join('\n')],
    ['multi-line double-quoted scalar', [
      'dbPassword: "prefix-private',
      '  suffix-private"',
      'next: keep',
    ].join('\n')],
  ])('redacts a complete valid YAML %s', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts YAML single-quote escapes embedded in Markdown', () => {
    const source = [
      '配置如下：',
      '```yaml',
      "{dbPassword: 'prefix-private''suffix-private', next: keep}",
      '```',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['double-quoted scalar', [
      'dbPassword: "prefix-private',
      '  suffix-private"',
    ].join('\n')],
    ['single-quoted scalar', [
      "password: 'prefix-private",
      "  suffix-private'",
    ].join('\n')],
  ])('redacts a Markdown-embedded multi-line YAML %s', (_label, credential) => {
    const source = [
      '配置如下：',
      '```yaml',
      credential,
      'next: keep',
      '```',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('next: keep');
    expect(redacted).toContain('[REDACTED]');
  });
});
