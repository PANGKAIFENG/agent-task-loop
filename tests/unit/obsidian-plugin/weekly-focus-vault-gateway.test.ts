import { describe, expect, it, vi } from 'vitest';

import {
  ensureWeeklyFocusParentDirectories,
  runAuthorizedWeeklyFocusWrite,
} from '../../../src/obsidian-plugin/weekly-focus-vault-gateway.js';

describe('ensureWeeklyFocusParentDirectories', () => {
  it('rechecks Vault permission immediately before creating each directory', async () => {
    let allowed = true;
    const mkdir = vi.fn(async () => undefined);
    const exists = vi.fn(async () => {
      allowed = false;
      return false;
    });

    await expect(ensureWeeklyFocusParentDirectories(
      { exists, mkdir },
      '05_Reviews/Weekly/2026-W30 周度重点.md',
      () => allowed,
    )).rejects.toThrow('vault_management_disabled');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('creates only missing parent directories while permission remains enabled', async () => {
    const mkdir = vi.fn(async () => undefined);
    const exists = vi.fn(async (path: string) => path === '05_Reviews');

    await ensureWeeklyFocusParentDirectories(
      { exists, mkdir },
      '05_Reviews/Weekly/2026-W30 周度重点.md',
      () => true,
    );

    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith('05_Reviews/Weekly');
  });

  it('does not start the final write after Vault permission is revoked', async () => {
    const write = vi.fn(async () => 'written');

    await expect(runAuthorizedWeeklyFocusWrite(
      () => false,
      write,
    )).rejects.toThrow('vault_management_disabled');

    expect(write).not.toHaveBeenCalled();
  });
});
