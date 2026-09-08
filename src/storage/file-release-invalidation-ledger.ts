import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { PluginBackupFileRecord } from '../domain/release-receipt.js';
import { atomicWriteTextFile } from './file-io.js';

// PAW-GOAL-003 T3 fix round 2 (CR2 TEP-55, sole P1): independent durable
// invalidation for a passed release receipt. The done gate persists the
// passed receipt BEFORE the task projection; when that post-passed phase then
// fails, overwriting the same ledger row with the terminal rolled_back
// receipt can fail with it — stranding a passed receipt beside an unchanged
// plugin that a later replay would trust into a done projection. This store
// is the fallback record: a separate file and write path from the receipt
// ledger, written BEFORE the rollback drill and the terminal receipt save,
// and consulted by replay before any projection completes. One acceptance
// maps to at most one record; the enriched write replaces the initial one.

export interface ReleaseInvalidationRecord {
  schemaVersion: 1;
  acceptanceId: string;
  receiptId: string;
  invalidatedAt: string;
  /** The terminal status the invalidated passed receipt resolves to. */
  terminalStatus: 'rolled_back';
  /** Why the just-durable passed receipt lost its authority. */
  reason: string;
  /** Null until the rollback drill ran; the drill result once it has. */
  rollbackRestoredFiles: PluginBackupFileRecord[] | null;
  /** Set when the rollback drill itself failed — the plugin is NOT restored. */
  rollbackFailureNote: string | null;
}

export interface ReleaseInvalidationLedger {
  get(acceptanceId: string): Promise<ReleaseInvalidationRecord | null>;
  record(entry: ReleaseInvalidationRecord): Promise<void>;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be a lowercase hex digest');

// Same bounded, control-character-free guard the Release Receipt uses — the
// invalidation record is durable terminal evidence, not a transcript (PRD 4.4).
const safeBoundedText = (maxLength: number) => z
  .string()
  .min(1)
  .max(maxLength)
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }), 'Control characters are not allowed');

const recordSchema: z.ZodType<ReleaseInvalidationRecord> = z
  .object({
    schemaVersion: z.literal(1),
    acceptanceId: safeBoundedText(600),
    receiptId: safeBoundedText(700),
    invalidatedAt: z.string().datetime({ offset: true }),
    terminalStatus: z.literal('rolled_back'),
    reason: safeBoundedText(400),
    rollbackRestoredFiles: z.array(z.object({
      path: safeBoundedText(400),
      sha256: sha256Schema,
      mode: z.number().int().min(0).max(0o777).optional(),
    }).strict()).max(64).nullable(),
    rollbackFailureNote: safeBoundedText(300).nullable(),
  })
  .strict();

export class FileReleaseInvalidationLedger implements ReleaseInvalidationLedger {
  private readonly path: string;

  constructor(private readonly runtimeRoot: string) {
    this.path = join(runtimeRoot, 'multica-release-invalidations.json');
  }

  async get(acceptanceId: string): Promise<ReleaseInvalidationRecord | null> {
    return (await this.load()).find((record) => (
      record.acceptanceId === acceptanceId
    )) ?? null;
  }

  async record(entry: ReleaseInvalidationRecord): Promise<void> {
    const parsed = recordSchema.parse(entry);
    const records = (await this.load()).filter((candidate) => (
      candidate.acceptanceId !== parsed.acceptanceId
    ));
    records.push(parsed);
    records.sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId));
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await atomicWriteTextFile(this.path, `${JSON.stringify({
      schemaVersion: 1,
      records,
    }, null, 2)}\n`);
  }

  private async load(): Promise<ReleaseInvalidationRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const parsed = z.object({
      schemaVersion: z.literal(1),
      records: z.array(recordSchema),
    }).strict().parse(JSON.parse(raw));
    return [...parsed.records];
  }
}
