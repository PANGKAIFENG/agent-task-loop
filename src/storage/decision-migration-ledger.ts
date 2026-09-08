import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { appendSafeTextFile, type StorageReadBoundary } from './file-io.js';
import { assertVaultWriteAllowed, vaultRoot, type VaultWriteAuthorization } from './task-paths.js';

/**
 * Append-only JSONL migration ledger (D8/D12). The ledger module is owned by
 * T5 and reused by the T6 migrator: reads power query-side deduplication
 * (key `native_id + kind + status='migrated'`), appends record per-source
 * migration outcomes (idempotency key `(source_path, source_sha256)`).
 */
export const MIGRATION_LEDGER_KINDS = ['policy', 'trace', 'feedback'] as const;
export const MIGRATION_LEDGER_STATUSES = [
  'migrated',
  'duplicate',
  'conflict',
  'failed',
  'skipped',
] as const;

export type MigrationLedgerKind = (typeof MIGRATION_LEDGER_KINDS)[number];
export type MigrationLedgerStatus = (typeof MIGRATION_LEDGER_STATUSES)[number];

export const migrationLedgerEntrySchema = z.object({
  run_id: z.string().trim().min(1).max(200),
  at: z.iso.datetime({ offset: true }),
  source_path: z.string().trim().min(1).max(1000),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  kind: z.enum(MIGRATION_LEDGER_KINDS),
  native_id: z.string().trim().min(1).max(300),
  status: z.enum(MIGRATION_LEDGER_STATUSES),
  detail: z.string().trim().min(1).max(2000).optional(),
}).strict();

export type MigrationLedgerEntry = z.infer<typeof migrationLedgerEntrySchema>;

/** A ledger line that could not be read; surfaced by queries as a warning. */
export interface UnreadableLedgerLine {
  line_no: number;
  reason: 'invalid_json' | 'invalid_entry';
}

export interface MigrationLedgerReadResult {
  entries: MigrationLedgerEntry[];
  unreadableLines: UnreadableLedgerLine[];
}

export interface AppendMigrationEntriesOptions {
  writeAuthorization?: VaultWriteAuthorization;
}

function systemRoot(root: string): string {
  return join(root, '07_System');
}

function migrationLedgerDirectory(root: string): string {
  return join(root, '07_System', 'Logs', 'Decision_Migration');
}

/** Canonical ledger path: `07_System/Logs/Decision_Migration/ledger.jsonl`. */
export function migrationLedgerPath(configuredRoot: string): string {
  return join(migrationLedgerDirectory(vaultRoot(configuredRoot)), 'ledger.jsonl');
}

function ledgerReadBoundary(root: string): StorageReadBoundary {
  return {
    vaultRoot: root,
    tasksRoot: systemRoot(root),
    subtree: migrationLedgerDirectory(root),
  };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Reads the ledger with diagnostics. A missing file is an empty ledger;
 * line-level corruption is skipped and reported (the query layer turns it
 * into the `migration_ledger_entry_unreadable` warning); file-level IO
 * errors propagate as-is so deduplication never silently degrades.
 */
export async function readMigrationLedgerDetailed(
  configuredRoot: string,
): Promise<MigrationLedgerReadResult> {
  const root = vaultRoot(configuredRoot);
  let raw: string;
  try {
    raw = await readFile(migrationLedgerPath(root), 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return { entries: [], unreadableLines: [] };
    }
    throw error;
  }
  const entries: MigrationLedgerEntry[] = [];
  const unreadableLines: UnreadableLedgerLine[] = [];
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines.push({ line_no: index + 1, reason: 'invalid_json' });
      continue;
    }
    const validated = migrationLedgerEntrySchema.safeParse(parsed);
    if (validated.success) {
      entries.push(validated.data);
    } else {
      unreadableLines.push({ line_no: index + 1, reason: 'invalid_entry' });
    }
  }
  return { entries, unreadableLines };
}

/** Entries-only read of the migration ledger (frozen T5 API, D12). */
export async function readMigrationLedger(
  configuredRoot: string,
): Promise<MigrationLedgerEntry[]> {
  const detailed = await readMigrationLedgerDetailed(configuredRoot);
  return detailed.entries;
}

/**
 * Query-side deduplication key (I2): a native id counts as migrated only for
 * a matching kind with `status='migrated'`. `duplicate` rows always accompany
 * an earlier `migrated` row for the same object, so they are covered by it.
 */
export function isMigratedNativeId(
  entries: MigrationLedgerEntry[],
  nativeId: string,
  kind: MigrationLedgerKind,
): boolean {
  return entries.some((entry) => entry.native_id === nativeId
    && entry.kind === kind
    && entry.status === 'migrated');
}

/**
 * Appends entries as JSONL lines (T6 migrator entry point). Entries are
 * validated up front so a malformed batch never leaves a partial ledger.
 */
export async function appendMigrationEntries(
  configuredRoot: string,
  entries: MigrationLedgerEntry[],
  options: AppendMigrationEntriesOptions = {},
): Promise<void> {
  const root = vaultRoot(configuredRoot);
  assertVaultWriteAllowed(root, options.writeAuthorization);
  const validated = entries.map((entry) => {
    const parsed = migrationLedgerEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error('Invalid migration ledger entry');
    }
    return parsed.data;
  });
  if (validated.length === 0) {
    return;
  }
  const content = validated.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  // The safe-append primitive resolves the tasks root before creating the
  // subtree, so a fresh vault needs the ledger directory to exist first.
  await mkdir(migrationLedgerDirectory(root), { recursive: true, mode: 0o700 });
  await appendSafeTextFile(
    migrationLedgerPath(root),
    Buffer.from(content, 'utf8'),
    ledgerReadBoundary(root),
  );
}
