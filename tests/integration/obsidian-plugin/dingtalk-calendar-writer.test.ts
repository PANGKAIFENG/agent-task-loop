import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DingTalkCalendarOccurrence } from '../../../src/obsidian-plugin/dingtalk-calendar-parser.js';
import {
  DingTalkCalendarWriter,
  type DingTalkCalendarFileSystem,
} from '../../../src/obsidian-plugin/dingtalk-calendar-writer.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';

let root: string;

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  }));
  return files.flat();
}

function nodeFileSystem(): DingTalkCalendarFileSystem {
  return {
    exists: async (path) => readFile(join(root, path)).then(() => true, () => false),
    ensureDirectory: async (path) => {
      await mkdir(join(root, path), { recursive: true });
    },
    listMarkdownFiles: async () => (
      (await markdownFiles(root)).map((path) => relative(root, path))
    ),
    read: async (path) => readFile(join(root, path), 'utf8'),
    create: async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, { encoding: 'utf8', flag: 'wx' });
    },
    modify: async (path, content) => {
      await writeFile(join(root, path), content, 'utf8');
    },
  };
}

function occurrence(overrides: Partial<DingTalkCalendarOccurrence> = {}): DingTalkCalendarOccurrence {
  return {
    eventKeyHash: `sha256:${'a'.repeat(64)}`,
    remoteUid: 'synthetic-event@example.com',
    recurrenceId: null,
    href: '/primary/synthetic.ics',
    etag: 'etag-1',
    snapshotHash: `sha256:${'b'.repeat(64)}`,
    snapshot: {
      title: 'Synthetic meeting',
      start: '2026-07-20T14:00:00+08:00',
      end: '2026-07-20T15:00:00+08:00',
      allDay: false,
      description: 'Synthetic agenda',
      location: 'Room A',
      state: 'active',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atl-dingtalk-writer-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('DingTalkCalendarWriter', () => {
  it('creates a TaskNotes calendar file outside the ATL task tree', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T01:00:00Z'),
    });
    const result = await writer.apply(occurrence(), undefined);

    expect(result.action).toBe('added');
    expect(result.entry.taskPath).toBe(`TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`);
    expect(result.entry.taskPath).not.toContain('10_Tasks');
    const document = parseTaskDocument(await readFile(
      join(root, result.entry.taskPath!),
      'utf8',
    ));
    expect(document.data).toMatchObject({
      type: 'task',
      status: 'inbox',
      scheduled: '2026-07-20T14:00:00+08:00',
      dingtalk_event_key_hash: `sha256:${'a'.repeat(64)}`,
      dingtalk_calendar_id: 'primary',
    });
    expect(document.data).not.toHaveProperty('due');
  });

  it('is idempotent and preserves a local drag while the remote event is unchanged', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T01:00:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);
    const path = first.entry.taskPath!;
    const document = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    document.data.scheduled = '2026-07-20T16:00:00+08:00';
    const raw = (await import('../../../src/storage/frontmatter.js')).serializeTaskDocument(
      document.data,
      `${document.body}\nLocal note.\n`,
    );
    await writeFile(join(root, path), raw, 'utf8');

    const second = await writer.apply(occurrence(), first.entry);
    expect(second.action).toBe('skipped');
    const preserved = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    expect(preserved.data.scheduled).toBe('2026-07-20T16:00:00+08:00');
    expect(preserved.body).toContain('Local note.');
    expect(await markdownFiles(root)).toHaveLength(1);
  });

  it('marks an already-ended active event done on its first import', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T03:00:00Z'),
    });

    const result = await writer.apply(occurrence({
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-20T09:00:00+08:00',
        end: '2026-07-20T10:00:00+08:00',
      },
    }), undefined);

    expect(result.action).toBe('added');
    const document = parseTaskDocument(await readFile(
      join(root, result.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('done');
  });

  it('completes an existing event after its end even when the remote snapshot is unchanged', async () => {
    let now = new Date('2026-07-20T06:30:00Z');
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => now,
    });
    const first = await writer.apply(occurrence(), undefined);
    const beforeEnd = parseTaskDocument(await readFile(
      join(root, first.entry.taskPath!),
      'utf8',
    ));
    expect(beforeEnd.data.status).toBe('inbox');

    now = new Date('2026-07-20T07:01:00Z');
    const completed = await writer.apply(occurrence(), first.entry);

    expect(completed.action).toBe('updated');
    const afterEnd = parseTaskDocument(await readFile(
      join(root, first.entry.taskPath!),
      'utf8',
    ));
    expect(afterEnd.data.status).toBe('done');
  });

  it('completes an ended ledger event without pretending it was seen remotely again', async () => {
    let now = new Date('2026-07-20T06:30:00Z');
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => now,
    });
    const first = await writer.apply(occurrence(), undefined);
    const lastSeenAt = first.entry.lastSeenAt;

    now = new Date('2026-07-20T07:01:00Z');
    const completed = await writer.reconcile(first.entry);

    expect(completed.action).toBe('updated');
    expect(completed.entry.lastSeenAt).toBe(lastSeenAt);
    const document = parseTaskDocument(await readFile(
      join(root, first.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('done');
  });

  it('leaves future events and events without a valid end incomplete', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T08:00:00Z'),
    });
    const future = await writer.apply(occurrence({
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-20T18:00:00+08:00',
        end: '2026-07-20T19:00:00+08:00',
      },
    }), undefined);
    const noEnd = await writer.apply(occurrence({
      eventKeyHash: `sha256:${'c'.repeat(64)}`,
      remoteUid: 'no-end@example.com',
      href: '/primary/no-end.ics',
      snapshotHash: `sha256:${'d'.repeat(64)}`,
      snapshot: {
        ...occurrence().snapshot,
        end: null,
      },
    }), undefined);
    const invalidEnd = await writer.apply(occurrence({
      eventKeyHash: `sha256:${'e'.repeat(64)}`,
      remoteUid: 'invalid-end@example.com',
      href: '/primary/invalid-end.ics',
      snapshotHash: `sha256:${'f'.repeat(64)}`,
      snapshot: {
        ...occurrence().snapshot,
        end: 'not-a-date',
      },
    }), undefined);

    for (const result of [future, noEnd, invalidEnd]) {
      const document = parseTaskDocument(await readFile(
        join(root, result.entry.taskPath!),
        'utf8',
      ));
      expect(document.data.status).toBe('inbox');
    }
  });

  it('does not complete an event whose end is not after its start', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T08:00:00Z'),
    });

    const result = await writer.apply(occurrence({
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-20T18:00:00+08:00',
        end: '2026-07-20T10:00:00+08:00',
      },
    }), undefined);

    const document = parseTaskDocument(await readFile(
      join(root, result.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('inbox');
  });

  it('completes an all-day event after its local end date begins', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-21T16:30:00Z'),
      timeZone: 'Asia/Shanghai',
    });

    const result = await writer.apply(occurrence({
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-21',
        end: '2026-07-22',
        allDay: true,
      },
    }), undefined);

    const document = parseTaskDocument(await readFile(
      join(root, result.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('done');
  });

  it('keeps an ended remote cancellation cancelled', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T08:00:00Z'),
    });

    const result = await writer.apply(occurrence({
      snapshot: {
        ...occurrence().snapshot,
        state: 'cancelled',
      },
    }), undefined);

    const document = parseTaskDocument(await readFile(
      join(root, result.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('cancelled');
  });

  it('does not auto-complete a status restored from remote cancellation in the same merge', async () => {
    let now = new Date('2026-07-20T06:30:00Z');
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => now,
    });
    const cancelledOccurrence = occurrence({
      snapshotHash: `sha256:${'c'.repeat(64)}`,
      snapshot: {
        ...occurrence().snapshot,
        state: 'cancelled',
      },
    });
    const cancelled = await writer.apply(cancelledOccurrence, undefined);

    now = new Date('2026-07-20T07:01:00Z');
    const restored = await writer.apply(occurrence({
      snapshotHash: `sha256:${'d'.repeat(64)}`,
    }), cancelled.entry);

    expect(restored.action).toBe('updated');
    const document = parseTaskDocument(await readFile(
      join(root, restored.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('inbox');
  });

  it('skips repeated synchronization after an event has been automatically completed', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T08:00:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);

    const repeated = await writer.apply(occurrence(), first.entry);

    expect(repeated.action).toBe('skipped');
    const document = parseTaskDocument(await readFile(
      join(root, first.entry.taskPath!),
      'utf8',
    ));
    expect(document.data.status).toBe('done');
  });

  it('preserves local notes and unrelated frontmatter when auto-completing', async () => {
    let now = new Date('2026-07-20T06:30:00Z');
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => now,
    });
    const first = await writer.apply(occurrence(), undefined);
    const path = first.entry.taskPath!;
    const current = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    current.data.project = 'Local project';
    current.data.priority = 'high';
    await writeFile(
      join(root, path),
      (await import('../../../src/storage/frontmatter.js')).serializeTaskDocument(
        current.data,
        `${current.body}\nLocal retrospective note.\n`,
      ),
      'utf8',
    );

    now = new Date('2026-07-20T07:01:00Z');
    const completed = await writer.apply(occurrence(), first.entry);

    expect(completed.action).toBe('updated');
    const document = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    expect(document.data).toMatchObject({
      status: 'done',
      project: 'Local project',
      priority: 'high',
    });
    expect(document.body).toContain('Local retrospective note.');
  });

  it('finds a moved file and applies a changed remote schedule without erasing local data', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T02:00:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);
    const oldPath = first.entry.taskPath!;
    const movedPath = 'Personal/Calendar/meeting.md';
    await mkdir(dirname(join(root, movedPath)), { recursive: true });
    await rename(join(root, oldPath), join(root, movedPath));
    const moved = parseTaskDocument(await readFile(join(root, movedPath), 'utf8'));
    moved.data.project = 'Local project';
    await writeFile(
      join(root, movedPath),
      (await import('../../../src/storage/frontmatter.js')).serializeTaskDocument(
        moved.data,
        `${moved.body}\nLocal note.\n`,
      ),
      'utf8',
    );

    const nextOccurrence = occurrence({
      snapshotHash: `sha256:${'c'.repeat(64)}`,
      snapshot: {
        ...occurrence().snapshot,
        start: '2026-07-20T15:00:00+08:00',
        end: '2026-07-20T16:30:00+08:00',
      },
    });
    const updated = await writer.apply(nextOccurrence, first.entry);

    expect(updated.action).toBe('updated');
    expect(updated.entry.taskPath).toBe(movedPath);
    const document = parseTaskDocument(await readFile(join(root, movedPath), 'utf8'));
    expect(document.data).toMatchObject({
      scheduled: '2026-07-20T15:00:00+08:00',
      timeEstimate: 90,
      project: 'Local project',
    });
    expect(document.body).toContain('Local note.');
  });

  it('records a tombstone after local deletion and does not recreate the file', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T03:00:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);
    await rm(join(root, first.entry.taskPath!));

    const deleted = await writer.apply(occurrence(), first.entry);
    expect(deleted.action).toBe('tombstoned');
    expect(deleted.entry.taskPath).toBeNull();
    expect(deleted.entry.locallyDeletedAt).toBe('2026-07-20T03:00:00.000Z');

    const repeated = await writer.apply(occurrence(), deleted.entry);
    expect(repeated.action).toBe('tombstoned');
    expect(await markdownFiles(root)).toEqual([]);
  });

  it('reassociates an existing file after ledger reset without erasing local fields', async () => {
    const writer = new DingTalkCalendarWriter({
      fileSystem: nodeFileSystem(),
      clock: () => new Date('2026-07-20T03:30:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);
    const path = first.entry.taskPath!;
    const current = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    current.data.project = 'Local project';
    current.data.priority = 'high';
    await writeFile(
      join(root, path),
      (await import('../../../src/storage/frontmatter.js')).serializeTaskDocument(
        current.data,
        `${current.body}\nLocal preparation note.\n`,
      ),
      'utf8',
    );

    const reimported = await writer.apply(occurrence({
      snapshotHash: `sha256:${'c'.repeat(64)}`,
      snapshot: {
        ...occurrence().snapshot,
        title: 'Renamed remotely',
        start: '2026-07-20T17:00:00+08:00',
        end: '2026-07-20T18:30:00+08:00',
      },
    }), undefined);

    expect(reimported.action).toBe('updated');
    const document = parseTaskDocument(await readFile(join(root, path), 'utf8'));
    expect(document.data).toMatchObject({
      title: 'Renamed remotely',
      scheduled: '2026-07-20T17:00:00+08:00',
      timeEstimate: 90,
      project: 'Local project',
      priority: 'high',
    });
    expect(document.body).toContain('Local preparation note.');
  });

  it('does not advance the returned snapshot when a file update fails', async () => {
    const fileSystem = nodeFileSystem();
    const writer = new DingTalkCalendarWriter({
      fileSystem,
      clock: () => new Date('2026-07-20T04:00:00Z'),
    });
    const first = await writer.apply(occurrence(), undefined);
    fileSystem.modify = vi.fn(async () => {
      throw new Error('synthetic write failure');
    });
    const changed = occurrence({
      snapshotHash: `sha256:${'d'.repeat(64)}`,
      snapshot: { ...occurrence().snapshot, title: 'Changed remotely' },
    });

    await expect(writer.apply(changed, first.entry)).rejects.toThrow('synthetic write failure');
    expect(first.entry.remoteSnapshotHash).toBe(`sha256:${'b'.repeat(64)}`);
  });
});
