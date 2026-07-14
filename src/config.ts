import { z } from 'zod';

import { assertVaultWriteAllowed, vaultRoot } from './storage/task-paths.js';

export interface AtlConfig {
  vaultRoot: string;
  dailyLimit: number;
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

const dailyLimitSchema = z.coerce.number().int().positive();

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AtlConfig {
  let root: string;
  try {
    root = vaultRoot(environment.ATL_VAULT_ROOT);
  } catch {
    throw new InvalidConfigError('ATL_VAULT_ROOT is required');
  }
  const dailyLimit = dailyLimitSchema.safeParse(
    environment.ATL_DAILY_LIMIT ?? '3',
  );
  if (!dailyLimit.success) {
    throw new InvalidConfigError('ATL_DAILY_LIMIT must be a positive integer');
  }
  return {
    vaultRoot: root,
    dailyLimit: dailyLimit.data,
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
