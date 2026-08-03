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
    ['tagged double-quoted scalar', [
      'password: !!str "prefix-private',
      '  suffix-private"',
    ].join('\n')],
    ['anchored double-quoted scalar', [
      'password: &credential "prefix-private',
      '  suffix-private"',
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

  it.each([
    ['explicit mapping key', [
      '? password',
      ': "prefix-private',
      '  suffix-private"',
      'next: keep',
    ].join('\n')],
    ['tagged flow map scalar', [
      "{password: !!str 'prefix-private''suffix-private', next: keep}",
    ].join('\n')],
    ['anchored flow map scalar', [
      '{password: &credential "prefix-private suffix-private", next: keep}',
    ].join('\n')],
    ['properties split across lines', [
      'password: !!str',
      '  &credential "prefix-private',
      '  suffix-private"',
      'next: keep',
    ].join('\n')],
  ])('redacts a complete Markdown-embedded YAML %s', (_label, credential) => {
    const source = [
      '配置如下：',
      '```yaml',
      credential,
      '```',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts a complete YAML credential inside a Markdown blockquote fence', () => {
    const source = [
      '> ```yaml',
      '> password: "prefix-private',
      '>   suffix-private"',
      '> next: keep',
      '> ```',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('> next: keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['unordered list', [
      '- ```yaml',
      '  ? password',
      '  : "prefix-private',
      '    suffix-private"',
      '  next: keep',
      '  ```',
    ].join('\n')],
    ['blockquote ordered list', [
      '> 1. ```yaml',
      '>    {password: !!str \'prefix-private\'\'suffix-private\', next: keep}',
      '>    ```',
    ].join('\n')],
    ['tab-indented list', [
      '-\t```yaml',
      '\t? password',
      '\t: "prefix-private',
      '\t  suffix-private"',
      '\tnext: keep',
      '\t````',
    ].join('\n')],
    ['nested unordered list', [
      '- - ```yaml',
      '    ? password',
      '    : "prefix-private',
      '      suffix-private"',
      '    next: keep',
      '    ````',
    ].join('\n')],
    ['nested mixed list in a blockquote', [
      '> 1. - ~~~yml',
      '>      {password: !!str \'prefix-private\'\'suffix-private\', next: keep}',
      '>      ~~~',
    ].join('\n')],
    ['list followed by a blockquote', [
      '- > ```yaml',
      '  > ? password',
      '  > : "prefix-private',
      '  >   suffix-private"',
      '  > next: keep',
      '  > ```',
    ].join('\n')],
    ['blockquote-list-blockquote nesting', [
      '> - > ~~~yml',
      '>   > {password: !!str \'prefix-private\'\'suffix-private\', next: keep}',
      '>   > ~~~',
    ].join('\n')],
    ['nested lists followed by a blockquote', [
      '- - > ```yaml',
      '    > password: "prefix-private',
      '    >   suffix-private"',
      '    > next: keep',
      '    > ```',
    ].join('\n')],
  ])('redacts YAML credentials inside a Markdown %s fence', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['plain fence', [
      '```yaml',
      '? password',
      ': |',
      '    ```',
      '    suffix-private',
      'next: keep',
      '```',
    ].join('\n')],
    ['blockquote fence', [
      '> ```yaml',
      '> ? password',
      '> : |',
      '>     ```',
      '>     suffix-private',
      '> next: keep',
      '> ```',
    ].join('\n')],
  ])('does not treat indented fence-like YAML content as the %s closer', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('next: keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it('fails closed for an unclosed Markdown YAML fence', () => {
    const source = [
      '配置如下：',
      '```yaml',
      '? password',
      ': "prefix-private',
      '  suffix-private"',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('[REDACTED]');
  });

  it('keeps content after a closed nested fence when blockquote indentation varies', () => {
    const source = [
      '   > - ```yaml',
      '>   password: prefix-private',
      '>   next: keep',
      '>   ```',
      'after: preserve',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).toContain('>   next: keep');
    expect(redacted).toContain('>   ```');
    expect(redacted).toContain('\nafter: preserve');
    expect(redacted).not.toContain('>   after: preserve');
  });

  it.each([
    ['plain fence', [
      '   ```yaml',
      'password: prefix-private',
      'next: keep',
      '```',
      'after: preserve',
    ].join('\n')],
    ['blockquote fence', [
      '>    ~~~yaml',
      '> password: prefix-private',
      '> next: keep',
      '> ~~~',
      'after: preserve',
    ].join('\n')],
  ])('allows independent opening and closing indentation for a %s', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).toContain('next: keep');
    expect(redacted).toContain('\nafter: preserve');
  });

  it('fails closed when unrelated malformed YAML follows a credential', () => {
    const source = [
      '```yaml',
      "{password: !!str 'prefix-private''suffix-private', next: keep}",
      'broken: [',
      '```',
    ].join('\n');

    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['implicit mapping', [
      '```yaml',
      'password: !!str',
      '  &credential "prefix-private',
      '  suffix-private"',
      'next: keep',
      'broken: [',
      '```',
    ].join('\n')],
    ['explicit mapping', [
      '```yaml',
      '? password',
      ': !!str',
      '  &credential "prefix-private',
      '  suffix-private"',
      'next: keep',
      'broken: [',
      '```',
    ].join('\n')],
  ])('fails closed for a property-split credential before malformed YAML in an %s', (_label, source) => {
    const redacted = redactSecrets(source);

    expect(redacted).not.toContain('prefix-private');
    expect(redacted).not.toContain('suffix-private');
    expect(redacted).toContain('keep');
    expect(redacted).toContain('[REDACTED]');
  });
});
