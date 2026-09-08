import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendMigrationEntries,
  isMigratedNativeId,
  migrationLedgerPath,
  readMigrationLedger,
  readMigrationLedgerDetailed,
  type MigrationLedgerEntry,
} from '../../../src/storage/decision-migration-ledger.js';

const LEDGER_DIR_SEGMENTS = ['07_System', 'Logs', 'Decision_Migration'];

function entry(overrides: Partial<MigrationLedgerEntry> = {}): MigrationLedgerEntry {
  return {
    run_id: 'run-ledger-001',
    at: '2026-08-18T12:00:00.000Z',
    source_path: '07_System/Logs/Decision_Traces/2026/08/trace-demo-001.md',
    source_sha256: createHash('sha256').update('demo-source').digest('hex'),
    kind: 'trace',
    native_id: 'dt_71a8599fdfe51dba68ea',
    status: 'migrated',
    ...overrides,
  };
}

describe('decision migration ledger', () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'atl-decision-ledger-'));
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  describe('readMigrationLedger', () => {
    it('returns an empty array when the ledger file does not exist', async () => {
      await expect(readMigrationLedger(vault)).resolves.toEqual([]);
    });

    it('reads back appended entries byte-faithfully', async () => {
      const entries = [
        entry(),
        entry({
          run_id: 'run-ledger-002',
          kind: 'policy',
          native_id: 'policy.input-routing.demo@v001',
          status: 'skipped',
          detail: 'missing_required_field:inputs',
        }),
        entry({
          run_id: 'run-ledger-003',
          kind: 'feedback',
          native_id: 'fb_0123456789abcdefghij',
          status: 'duplicate',
        }),
      ];
      await appendMigrationEntries(vault, entries);
      await expect(readMigrationLedger(vault)).resolves.toEqual(entries);
    });

    it('skips blank lines without reporting them as unreadable', async () => {
      const ledgerPath = migrationLedgerPath(vault);
      await mkdir(dirname(ledgerPath), { recursive: true });
      await writeFile(ledgerPath, '\n\n', 'utf8');
      const detailed = await readMigrationLedgerDetailed(vault);
      expect(detailed.entries).toEqual([]);
      expect(detailed.unreadableLines).toEqual([]);
    });

    it('skips a line that is not valid JSON and reports its line number', async () => {
      const ledgerPath = migrationLedgerPath(vault);
      await mkdir(dirname(ledgerPath), { recursive: true });
      const valid = entry({ run_id: 'run-ledger-010' });
      await writeFile(ledgerPath, [
        JSON.stringify(valid),
        'this line is not json at all',
        JSON.stringify(entry({ run_id: 'run-ledger-011', native_id: 'dt_8a68c15203580e21f7f9' })),
      ].map((line) => `${line}\n`).join(''), 'utf8');

      const detailed = await readMigrationLedgerDetailed(vault);
      expect(detailed.entries.map((item) => item.run_id)).toEqual(['run-ledger-010', 'run-ledger-011']);
      expect(detailed.unreadableLines).toEqual([{ line_no: 2, reason: 'invalid_json' }]);
    });

    it('skips a structurally invalid entry line and reports its line number', async () => {
      const ledgerPath = migrationLedgerPath(vault);
      await mkdir(dirname(ledgerPath), { recursive: true });
      await writeFile(ledgerPath, [
        JSON.stringify({ run_id: 'run-ledger-020', at: 'not-a-date', source_path: 'x', source_sha256: 'zz', kind: 'trace', native_id: 'dt_x', status: 'migrated' }),
        JSON.stringify(entry({ run_id: 'run-ledger-021' })),
      ].map((line) => `${line}\n`).join(''), 'utf8');

      const detailed = await readMigrationLedgerDetailed(vault);
      expect(detailed.entries.map((item) => item.run_id)).toEqual(['run-ledger-021']);
      expect(detailed.unreadableLines).toEqual([{ line_no: 1, reason: 'invalid_entry' }]);
    });

    it('propagates file-level IO errors instead of degrading to an empty ledger', async () => {
      // A regular file where the Decision_Migration directory should be makes
      // reading the ledger path fail with ENOTDIR, which must surface as-is.
      const migrationDir = join(vault, ...LEDGER_DIR_SEGMENTS);
      await mkdir(dirname(migrationDir), { recursive: true });
      await writeFile(migrationDir, 'not a directory', 'utf8');
      await expect(readMigrationLedger(vault)).rejects.toThrow();
    });
  });

  describe('appendMigrationEntries', () => {
    it('appends JSONL lines under the canonical vault path', async () => {
      const first = entry();
      const second = entry({ run_id: 'run-ledger-002', status: 'conflict' });
      await appendMigrationEntries(vault, [first]);
      await appendMigrationEntries(vault, [second]);

      const raw = await readFile(migrationLedgerPath(vault), 'utf8');
      expect(raw.split('\n').filter((line) => line !== '').length).toBe(2);
      expect(raw).toContain(JSON.stringify(first));
      expect(raw).toContain(JSON.stringify(second));
      await expect(readMigrationLedger(vault)).resolves.toEqual([first, second]);
    });

    it('rejects an invalid entry without creating the ledger file', async () => {
      const invalid = { ...entry(), status: 'not-a-status' } as unknown as MigrationLedgerEntry;
      await expect(appendMigrationEntries(vault, [invalid])).rejects.toThrow();
      await expect(readMigrationLedger(vault)).resolves.toEqual([]);
    });

    it('refuses to append into a real (non-temp) root without authorization', async () => {
      const originalVaultRoot = process.env.ATL_VAULT_ROOT;
      const originalAllowWrites = process.env.ATL_ALLOW_REAL_WRITES;
      delete process.env.ATL_VAULT_ROOT;
      delete process.env.ATL_ALLOW_REAL_WRITES;
      const forbiddenRoot = resolve(process.cwd(), '.atl-decision-ledger-real-root-probe');
      try {
        await expect(appendMigrationEntries(forbiddenRoot, [entry()]))
          .rejects.toThrow('Vault writes are disabled');
      } finally {
        if (originalVaultRoot !== undefined) {
          process.env.ATL_VAULT_ROOT = originalVaultRoot;
        }
        if (originalAllowWrites !== undefined) {
          process.env.ATL_ALLOW_REAL_WRITES = originalAllowWrites;
        }
      }
    });
  });

  describe('isMigratedNativeId', () => {
    it('matches only migrated entries with the same native id and kind', () => {
      const entries = [
        entry({ native_id: 'dt_71a8599fdfe51dba68ea', kind: 'trace', status: 'migrated' }),
        entry({ native_id: 'dt_8a68c15203580e21f7f9', kind: 'trace', status: 'failed' }),
        entry({ native_id: 'policy.input-routing.demo@v001', kind: 'policy', status: 'migrated' }),
        entry({ native_id: 'fb_0123456789abcdefghij', kind: 'feedback', status: 'duplicate' }),
      ];
      expect(isMigratedNativeId(entries, 'dt_71a8599fdfe51dba68ea', 'trace')).toBe(true);
      // Same native id but status='failed' must not deduplicate.
      expect(isMigratedNativeId(entries, 'dt_8a68c15203580e21f7f9', 'trace')).toBe(false);
      // Same native id but a different kind must not deduplicate.
      expect(isMigratedNativeId(entries, 'policy.input-routing.demo@v001', 'trace')).toBe(false);
      expect(isMigratedNativeId(entries, 'policy.input-routing.demo@v001', 'policy')).toBe(true);
      // status='duplicate' alone does not carry migrated semantics.
      expect(isMigratedNativeId(entries, 'fb_0123456789abcdefghij', 'feedback')).toBe(false);
      expect(isMigratedNativeId(entries, 'dt_unknown0000000000000', 'trace')).toBe(false);
      expect(isMigratedNativeId([], 'dt_71a8599fdfe51dba68ea', 'trace')).toBe(false);
    });

    it('treats a migrated entry paired with a later duplicate entry as migrated', () => {
      const entries = [
        entry({ native_id: 'dt_71a8599fdfe51dba68ea', kind: 'trace', status: 'migrated' }),
        entry({ native_id: 'dt_71a8599fdfe51dba68ea', kind: 'trace', status: 'duplicate' }),
      ];
      expect(isMigratedNativeId(entries, 'dt_71a8599fdfe51dba68ea', 'trace')).toBe(true);
    });
  });
});
