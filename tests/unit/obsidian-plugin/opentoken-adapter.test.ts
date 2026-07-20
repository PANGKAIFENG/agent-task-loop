import { describe, expect, it, vi } from 'vitest';

import {
  OpenTokenAdapter,
  OpenTokenAdapterError,
  type OpenTokenExecute,
} from '../../../src/obsidian-plugin/opentoken-adapter.js';

function validOutput(): string {
  return JSON.stringify({
    rows: [
      {
        date: '2026-07-20',
        tool: 'codex',
        model: 'gpt',
        input: 100,
        output: 20,
        cache_read: 40,
        cache_write: 0,
        normalized: 120,
      },
      {
        date: '2026-07-20',
        tool: 'claude-code',
        model: 'claude',
        input: 50,
        output: 10,
        cache_read: 5,
        cache_write: 2,
        normalized: 60,
      },
    ],
    sessions: [],
  });
}

function executeWith(output = validOutput()): OpenTokenExecute {
  return vi.fn(async (_executable, args) => ({
    stdout: args[0] === '--version' ? 'opentoken 0.3.11\n' : output,
    stderr: '',
  }));
}

describe('OpenTokenAdapter', () => {
  it('aggregates normalized usage across tools for each day', async () => {
    const execute = executeWith();
    const adapter = new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async () => true,
      resolveOnPath: async () => null,
      execute,
      now: () => new Date('2026-07-20T12:00:00Z'),
    });

    await expect(adapter.preview('2026-07-20')).resolves.toEqual({
      version: '0.3.11',
      updatedAt: '2026-07-20T12:00:00.000Z',
      since: '2026-07-20',
      days: [{
        date: '2026-07-20',
        normalized: 180,
        input: 150,
        output: 30,
        cacheRead: 45,
        cacheWrite: 2,
        tools: ['claude-code', 'codex'],
      }],
    });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      '/Users/test/.local/bin/opentoken',
      ['preview', '--since', '2026-07-20', '--json'],
      expect.objectContaining({ shell: false, timeout: 30_000 }),
    );
  });

  it('checks fixed candidates before resolving opentoken from PATH', async () => {
    const checked: string[] = [];
    const execute = executeWith();
    const adapter = new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async (path) => {
        checked.push(path);
        return path === '/usr/local/bin/opentoken';
      },
      resolveOnPath: async () => '/untrusted/not-used',
      execute,
      now: () => new Date('2026-07-20T12:00:00Z'),
    });

    await adapter.preview('2026-07-20');

    expect(checked).toEqual([
      '/Users/test/.local/bin/opentoken',
      '/opt/homebrew/bin/opentoken',
      '/usr/local/bin/opentoken',
    ]);
    expect(execute).toHaveBeenCalledWith(
      '/usr/local/bin/opentoken',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('reports missing when no executable can be resolved', async () => {
    const adapter = new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async () => false,
      resolveOnPath: async () => null,
      execute: executeWith(),
      now: () => new Date(),
    });

    await expect(adapter.preview('2026-07-20')).rejects.toMatchObject({
      code: 'missing',
    });
  });

  it.each([
    '2026-02-30',
    '2026-7-20',
    '../2026-07-20',
  ])('rejects an invalid since date: %s', async (since) => {
    const execute = executeWith();
    const adapter = new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async () => true,
      resolveOnPath: async () => null,
      execute,
      now: () => new Date(),
    });

    await expect(adapter.preview(since)).rejects.toMatchObject({
      code: 'invalid_output',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    JSON.stringify({ rows: [{
      date: '2026-07-20', tool: 'codex', model: 'gpt', input: -1, output: 0,
      cache_read: 0, cache_write: 0, normalized: 0,
    }], sessions: [] }),
    JSON.stringify({ rows: [{
      date: '2026-07-20', tool: 'codex', model: 'gpt', input: 1, output: 0,
      cache_read: 0, cache_write: 0, normalized: 1, unknown: true,
    }], sessions: [] }),
    JSON.stringify({ rows: [], sessions: [], unknown: true }),
    '{not-json',
  ])('rejects malformed or non-contract JSON', async (stdout) => {
    const adapter = new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async () => true,
      resolveOnPath: async () => null,
      execute: executeWith(stdout),
      now: () => new Date(),
    });

    await expect(adapter.preview('2026-07-20')).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('maps timeout and process errors without exposing stderr', async () => {
    const privateValue = 'synthetic-private-stderr';
    const timedOut = Object.assign(new Error(privateValue), { timedOut: true });
    const failed = new Error(privateValue);
    const makeAdapter = (error: Error) => new OpenTokenAdapter({
      homeDirectory: '/Users/test',
      pathExists: async () => true,
      resolveOnPath: async () => null,
      execute: async () => { throw error; },
      now: () => new Date(),
    });

    const timeoutError = await makeAdapter(timedOut).preview('2026-07-20')
      .catch((error: unknown) => error);
    expect(timeoutError).toBeInstanceOf(OpenTokenAdapterError);
    expect(timeoutError).toMatchObject({ code: 'timeout' });
    expect((timeoutError as Error).message).not.toContain(privateValue);

    const processError = await makeAdapter(failed).preview('2026-07-20')
      .catch((error: unknown) => error);
    expect(processError).toMatchObject({ code: 'process_failed' });
    expect((processError as Error).message).not.toContain(privateValue);
  });
});
