import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMulticaEventComment } from '../../../src/domain/multica-event.js';

// The fixture directory is the wire contract for PAW-GOAL-003 T2 (TECH §5):
// every event fixture must parse (or be rejected) exactly as documented, so
// a drifting schema breaks this test before it breaks production ingestion.
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'multica',
);

const VALID_EVENTS: Record<string, string> = {
  'needs_decision.json': 'needs_decision',
  'blocked-recoverable.json': 'blocked',
  'failed-unrecoverable.json': 'failed',
  'release-candidate-ready.json': 'release_candidate_ready',
  'completed.json': 'completed',
};

const INVALID_EVENTS: Record<string, string> = {
  'invalid-missing-options.json': 'needs_decision_requires_options',
  'invalid-rc-without-sha.json': 'release_candidate_requires_head_sha',
};

function fenced(raw: string): string {
  return `\`\`\`json\n${raw.trim()}\n\`\`\``;
}

describe('multica event fixtures', () => {
  it.for(Object.entries(VALID_EVENTS))(
    '%s parses into a %s event',
    async ([file, state]) => {
      const raw = await readFile(join(fixtureRoot, 'events', file), 'utf8');
      const parsed = parseMulticaEventComment('fixture', fenced(raw));
      expect(parsed.rejections).toHaveLength(0);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0]?.state).toBe(state);
    },
  );

  it.for(Object.entries(INVALID_EVENTS))(
    '%s is rejected with reason %s',
    async ([file, reason]) => {
      const raw = await readFile(join(fixtureRoot, 'events', file), 'utf8');
      const parsed = parseMulticaEventComment('fixture', fenced(raw));
      expect(parsed.events).toHaveLength(0);
      expect(parsed.rejections[0]?.reason).toBe(reason);
    },
  );

  it('keeps the natural-language comment fixture projection-free', async () => {
    const raw = await readFile(join(fixtureRoot, 'comments', 'supervisor-progress.md'), 'utf8');
    const parsed = parseMulticaEventComment('fixture', raw);
    expect(parsed.events).toHaveLength(0);
    expect(parsed.rejections).toHaveLength(0);
  });

  it('parses exactly one event from the supervisor comment fixture', async () => {
    const raw = await readFile(join(fixtureRoot, 'comments', 'supervisor-event-comment.md'), 'utf8');
    const parsed = parseMulticaEventComment('fixture', raw);
    expect(parsed.rejections).toHaveLength(0);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.decision?.options).toHaveLength(2);
  });
});
