import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Obsidian settings UI contract', () => {
  it('exposes the DingTalk self-notification profile in the background section', async () => {
    const source = await readFile(join(
      process.cwd(),
      'src/obsidian-plugin/main.ts',
    ), 'utf8');

    expect(source).toContain(".setName('待验收通知')");
    expect(source).toContain(".setValue(background.dingtalkProfile)");
    expect(source).toContain('留空则关闭钉钉通知');
  });
});
