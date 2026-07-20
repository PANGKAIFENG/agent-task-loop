import { execFile } from 'node:child_process';

export const DINGTALK_CALDAV_SECRET_ID = 'agent-task-loop-dingtalk-caldav';

const LEGACY_KEYCHAIN_SERVICE = 'ai.agent-task-loop.dingtalk-caldav';
const LEGACY_KEYCHAIN_ACCOUNT = 'default';

export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export interface DingTalkCredentialStore {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  clearPassword(): Promise<void>;
}

export interface DingTalkCredentialStoreDependencies {
  secretStorage: SecretStorageLike;
  readLegacyKeychain: () => Promise<string | null>;
}

export function readLegacyDingTalkKeychainPassword(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-w',
        '-s',
        LEGACY_KEYCHAIN_SERVICE,
        '-a',
        LEGACY_KEYCHAIN_ACCOUNT,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4096,
        timeout: 5000,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const password = typeof stdout === 'string' ? stdout.trimEnd() : '';
        resolve(password === '' ? null : password);
      },
    );
  });
}

export function createDingTalkCredentialStore(
  dependencies: DingTalkCredentialStoreDependencies,
): DingTalkCredentialStore {
  return {
    async getPassword() {
      const stored = dependencies.secretStorage.getSecret(DINGTALK_CALDAV_SECRET_ID);
      if (stored !== null && stored !== '') return stored;
      try {
        const legacy = await dependencies.readLegacyKeychain();
        if (legacy === null || legacy === '') return null;
        dependencies.secretStorage.setSecret(DINGTALK_CALDAV_SECRET_ID, legacy);
        return legacy;
      } catch {
        return null;
      }
    },
    async setPassword(password) {
      dependencies.secretStorage.setSecret(DINGTALK_CALDAV_SECRET_ID, password);
    },
    async clearPassword() {
      dependencies.secretStorage.setSecret(DINGTALK_CALDAV_SECRET_ID, '');
    },
  };
}
