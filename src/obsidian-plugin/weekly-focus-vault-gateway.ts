export interface WeeklyFocusDirectoryAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

function assertVaultManagement(canManageVault: () => boolean): void {
  if (!canManageVault()) throw new Error('vault_management_disabled');
}

export async function runAuthorizedWeeklyFocusWrite<T>(
  canManageVault: () => boolean,
  write: () => Promise<T>,
): Promise<T> {
  assertVaultManagement(canManageVault);
  return write();
}

export async function ensureWeeklyFocusParentDirectories(
  adapter: WeeklyFocusDirectoryAdapter,
  path: string,
  canManageVault: () => boolean,
): Promise<void> {
  assertVaultManagement(canManageVault);
  let directory = '';
  for (const segment of path.split('/').slice(0, -1).filter(Boolean)) {
    directory = directory === '' ? segment : `${directory}/${segment}`;
    if (await adapter.exists(directory)) continue;
    assertVaultManagement(canManageVault);
    await adapter.mkdir(directory);
  }
}
