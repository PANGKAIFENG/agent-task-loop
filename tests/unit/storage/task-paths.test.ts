import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertVaultWriteAllowed,
  createVaultWriteAuthorization,
} from '../../../src/storage/task-paths.js';

const originalVaultRoot = process.env.ATL_VAULT_ROOT;
const originalAllowWrites = process.env.ATL_ALLOW_REAL_WRITES;

afterEach(() => {
  if (originalVaultRoot === undefined) {
    delete process.env.ATL_VAULT_ROOT;
  } else {
    process.env.ATL_VAULT_ROOT = originalVaultRoot;
  }
  if (originalAllowWrites === undefined) {
    delete process.env.ATL_ALLOW_REAL_WRITES;
  } else {
    process.env.ATL_ALLOW_REAL_WRITES = originalAllowWrites;
  }
});

describe('embedded Vault write authorization', () => {
  it('allows only the canonical Vault root bound to the authorization', () => {
    delete process.env.ATL_VAULT_ROOT;
    delete process.env.ATL_ALLOW_REAL_WRITES;
    const allowedRoot = resolve(process.cwd(), '.test-vault-authorization');
    const otherRoot = resolve(process.cwd(), '.other-test-vault');
    const authorization = createVaultWriteAuthorization(allowedRoot);

    expect(() => assertVaultWriteAllowed(allowedRoot, authorization)).not.toThrow();
    expect(() => assertVaultWriteAllowed(otherRoot, authorization)).toThrow(
      'Vault writes are disabled',
    );
  });
});
