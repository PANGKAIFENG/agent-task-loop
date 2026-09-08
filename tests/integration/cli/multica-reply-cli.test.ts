import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const temporaryRoots: string[] = [];

async function runResponses(extraEnv: Record<string, string | undefined>) {
  const vault = await mkdtemp(join(tmpdir(), 'atl-multica-reply-cli-'));
  temporaryRoots.push(vault);
  return execa('pnpm', ['exec', 'tsx', cli, 'multica', 'responses', '--json'], {
    cwd: repositoryRoot,
    env: {
      ATL_VAULT_ROOT: vault,
      ATL_ALLOW_REAL_WRITES: undefined,
      ATL_DINGTALK_TRUSTED_CONVERSATION_ID: 'trusted-conversation-001',
      ...extraEnv,
    },
    reject: false,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atl multica trusted sender environment', () => {
  it('accepts the sender variable installed by DingTalk Stream', async () => {
    const result = await runResponses({
      ATL_DINGTALK_TRUSTED_SENDER_ID: undefined,
      ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-001',
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ processed: 0, remaining: 0 });
  });

  it('rejects conflicting CLI and Stream sender variables', async () => {
    const result = await runResponses({
      ATL_DINGTALK_TRUSTED_SENDER_ID: 'trusted-user-cli',
      ATL_DINGTALK_TRUSTED_SENDER_USER_ID: 'trusted-user-stream',
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining('trusted sender environment values conflict'),
      },
    });
  });
});
