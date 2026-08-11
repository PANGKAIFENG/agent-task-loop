import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { qianwenRuntimeRoot } from '../../src/qianwen-runtime-root.js';

describe('qianwen runtime root', () => {
  it('derives the same state and lock directory from CLI cwd and the packaged runner path', () => {
    const pluginRoot = '/tmp/vault/.obsidian/plugins/agent-task-loop';
    expect(qianwenRuntimeRoot({ cwd: pluginRoot })).toBe(join(pluginRoot, '.atl-runtime'));
    expect(qianwenRuntimeRoot({
      runnerPath: join(pluginRoot, 'atl-runner.mjs'),
    })).toBe(join(pluginRoot, '.atl-runtime'));
  });
});
