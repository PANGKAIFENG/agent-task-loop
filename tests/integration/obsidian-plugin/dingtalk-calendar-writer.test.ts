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
    expect(result.entry.taskPath).toBe(`TaskNotes/DingTalk/sha256:${'a'.repeat(64)}.md`);
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
