import { optionalDingTalkProfile } from './dingtalk-profile.js';
import { assertVaultWriteAllowed, vaultRoot } from './storage/task-paths.js';

export interface AtlConfig {
  vaultRoot: string;
  dingtalkProfile: string | null;
  leaseMinutes: 60;
  boardHost: '127.0.0.1';
}

export class InvalidConfigError extends Error {
  readonly code = 'invalid_config';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigError';
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AtlConfig {
  let root: string;
  try {
    root = vaultRoot(environment.ATL_VAULT_ROOT);
  } catch {
    throw new InvalidConfigError('ATL_VAULT_ROOT is required');
  }
  const dingtalkProfile = optionalDingTalkProfile(
    environment.ATL_DINGTALK_PROFILE,
  );
  if (
    environment.ATL_DINGTALK_PROFILE !== undefined
    && environment.ATL_DINGTALK_PROFILE !== ''
    && dingtalkProfile === null
  ) {
    throw new InvalidConfigError(
      'ATL_DINGTALK_PROFILE must contain one explicit DingTalk profile',
    );
  }
  return {
    vaultRoot: root,
    dingtalkProfile,
    leaseMinutes: 60,
    boardHost: '127.0.0.1',
  };
}

export function assertWriteEnabled(config: AtlConfig): void {
  try {
    assertVaultWriteAllowed(config.vaultRoot);
  } catch {
    throw new InvalidConfigError(
      'Writes outside the OS temporary directory require ATL_ALLOW_REAL_WRITES=1',
    );
  }
}
