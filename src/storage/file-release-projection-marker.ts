import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { atomicWriteTextFile } from './file-io.js';

// PAW-GOAL-003 T3 fix round 3 (CR3 TEP-56, sole P1): the write-ahead
// projection marker. The done gate persists the passed receipt BEFORE the
// task projection, so a post-passed failure can strand a passed receipt
// beside a review task. CR2's invalidation store witnesses that failure —
// but its write can fail too (the four-way failure): ledger still passed,
// installed bytes still matching, invalidation store empty. Those durable
// states are then indistinguishable from the genuine crash window between
// the receipt save and the projection, so replay must not guess.
//
// This marker closes the gap BY CONSTRUCTION: it is armed BEFORE the passed
// receipt is persisted at all (a run that cannot make it durable refuses to
// persist the passed receipt), and it is resolved only AFTER the done
// projection is confirmed. A replay may complete a projection only for a
// marker that reads back resolved — a pending or unreadable marker fails
// closed, crash window included. Separate file and write path from both the
// receipt ledger and the invalidation store; one acceptance maps to at most
// one marker, and arm/markProjected replace it idempotently.

export type ReleaseProjectionMarkerState = 'pending' | 'projected';

export interface ReleaseProjectionMarker {
  schemaVersion: 1;
  acceptanceId: string;
  receiptId: string;
  /** When the write-ahead marker became durable — before the passed save. */
  armedAt: string;
  /** Pending until the done projection is confirmed durable. */
  state: ReleaseProjectionMarkerState;
  /** Set when the projection was confirmed; null while pending. */
  projectedAt: string | null;
}

export interface ReleaseProjectionMarkerStore {
  get(acceptanceId: string): Promise<ReleaseProjectionMarker | null>;
  arm(marker: ReleaseProjectionMarker): Promise<void>;
  markProjected(acceptanceId: string, projectedAt: string): Promise<void>;
}

// Same bounded, control-character-free guard the Release Receipt uses — the
// marker is durable gate evidence, not a transcript (PRD 4.4).
const safeBoundedText = (maxLength: number) => z
  .string()
  .min(1)
  .max(maxLength)
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }), 'Control characters are not allowed');

const markerSchema: z.ZodType<ReleaseProjectionMarker> = z
  .object({
    schemaVersion: z.literal(1),
    acceptanceId: safeBoundedText(600),
    receiptId: safeBoundedText(700),
    armedAt: z.string().datetime({ offset: true }),
    state: z.enum(['pending', 'projected']),
    projectedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === 'pending' && value.projectedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a pending marker cannot carry projectedAt',
      });
    }
    if (value.state === 'projected' && value.projectedAt === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a projected marker requires projectedAt',
      });
    }
  });

export class FileReleaseProjectionMarkerStore implements ReleaseProjectionMarkerStore {
  private readonly path: string;

  constructor(private readonly runtimeRoot: string) {
    this.path = join(runtimeRoot, 'multica-release-projection-markers.json');
  }

  async get(acceptanceId: string): Promise<ReleaseProjectionMarker | null> {
    return (await this.load()).find((marker) => (
      marker.acceptanceId === acceptanceId
    )) ?? null;
  }

  async arm(marker: ReleaseProjectionMarker): Promise<void> {
    const parsed = markerSchema.parse(marker);
    await this.persist(parsed);
  }

  async markProjected(acceptanceId: string, projectedAt: string): Promise<void> {
    const markers = await this.load();
    const marker = markers.find((candidate) => candidate.acceptanceId === acceptanceId);
    if (marker === undefined) {
      throw new Error(`no projection marker to resolve for ${acceptanceId}`);
    }
    await this.persist(markerSchema.parse({
      ...marker,
      state: 'projected',
      projectedAt,
    }));
  }

  private async persist(marker: ReleaseProjectionMarker): Promise<void> {
    const markers = (await this.load()).filter((candidate) => (
      candidate.acceptanceId !== marker.acceptanceId
    ));
    markers.push(marker);
    markers.sort((left, right) => left.acceptanceId.localeCompare(right.acceptanceId));
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await atomicWriteTextFile(this.path, `${JSON.stringify({
      schemaVersion: 1,
      markers,
    }, null, 2)}\n`);
  }

  private async load(): Promise<ReleaseProjectionMarker[]> {
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
      markers: z.array(markerSchema),
    }).strict().parse(JSON.parse(raw));
    return [...parsed.markers];
  }
}
