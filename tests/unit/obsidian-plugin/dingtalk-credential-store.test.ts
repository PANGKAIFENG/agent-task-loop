import { describe, expect, it, vi } from 'vitest';

import {
  createDingTalkCredentialStore,
  DINGTALK_CALDAV_SECRET_ID,
} from '../../../src/obsidian-plugin/dingtalk-credential-store.js';

function createSecretStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(DINGTALK_CALDAV_SECRET_ID, initial);
  return {
    values,
    storage: {
      getSecret: (id: string) => values.get(id) ?? null,
      setSecret: (id: string, value: string) => {
        values.set(id, value);
      },
    },
  };
}

describe('DingTalkCredentialStore', () => {
  it('prefers the Obsidian secret without reading the legacy keychain', async () => {
    const secrets = createSecretStorage('obsidian-secret');
    const readLegacyKeychain = vi.fn(async () => 'legacy-secret');
    const store = createDingTalkCredentialStore({
      secretStorage: secrets.storage,
      readLegacyKeychain,
    });

    await expect(store.getPassword()).resolves.toBe('obsidian-secret');
    expect(readLegacyKeychain).not.toHaveBeenCalled();
  });

  it('migrates a legacy keychain password into Obsidian SecretStorage', async () => {
    const secrets = createSecretStorage();
    const store = createDingTalkCredentialStore({
      secretStorage: secrets.storage,
      readLegacyKeychain: async () => 'legacy-secret',
    });

    await expect(store.getPassword()).resolves.toBe('legacy-secret');
    expect(secrets.values.get(DINGTALK_CALDAV_SECRET_ID)).toBe('legacy-secret');
  });

  it('treats missing, empty, and failed legacy credentials as unavailable', async () => {
    const missing = createDingTalkCredentialStore({
      secretStorage: createSecretStorage().storage,
      readLegacyKeychain: async () => null,
    });
    const empty = createDingTalkCredentialStore({
      secretStorage: createSecretStorage('').storage,
      readLegacyKeychain: async () => '',
    });
    const failed = createDingTalkCredentialStore({
      secretStorage: createSecretStorage().storage,
      readLegacyKeychain: async () => {
        throw new Error('security command failed with private output');
      },
    });

    await expect(missing.getPassword()).resolves.toBeNull();
    await expect(empty.getPassword()).resolves.toBeNull();
    await expect(failed.getPassword()).resolves.toBeNull();
  });

  it('stores and clears a password without returning it from another API', async () => {
    const secrets = createSecretStorage();
    const store = createDingTalkCredentialStore({
      secretStorage: secrets.storage,
      readLegacyKeychain: async () => null,
    });

    await store.setPassword('new-secret');
    await expect(store.getPassword()).resolves.toBe('new-secret');
    await store.clearPassword();
    await expect(store.getPassword()).resolves.toBeNull();
    expect(Object.keys(store).sort()).toEqual([
      'clearPassword',
      'getPassword',
      'setPassword',
    ]);
  });
});
