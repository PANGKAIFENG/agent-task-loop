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
});
