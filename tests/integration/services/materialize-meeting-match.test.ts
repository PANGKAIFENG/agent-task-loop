import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MeetingNoteController, type MeetingNoteFileSystem } from '../../../src/obsidian-plugin/meeting-note.js';
import {
  confirmMeetingMatchWithEvidence,
  markRecordingWithoutCalendarWithEvidence,
} from '../../../src/services/materialize-meeting-match.js';
import { FileMeetingMatchDecisionRepository } from '../../../src/storage/meeting-match-decision-repository.js';
import type { QianwenSourceRuntimeState } from '../../../src/storage/qianwen-source-state-repository.js';

const EVENT_HASH = `sha256:${'d'.repeat(64)}`;
const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'d'.repeat(64)}.md`;
const roots: string[] = [];

function eventDocument(): string {
  return [
    '---',
    'type: task',
    'title: 精恭纺验收推进会议',
    'origin: dingtalk_caldav',
    `dingtalk_event_key_hash: ${EVENT_HASH}`,
    'scheduled: 2026-08-10T17:00:00+08:00',
    'timeEstimate: 60',
    '---',
    '',
    '钉钉日程只读正文。',
    '',
  ].join('\n');
}

function sourceState(): QianwenSourceRuntimeState {
  return {
    schemaVersion: 2,
    lastAttemptedDate: '2026-08-11',
    lastScan: null,
    lastSuccessfulScan: null,
    recordings: {
      'recording-a': {
        currentVersion: 1,
        versions: [{
          id: 'recording-a',
          version: 1,
          fingerprint: 'f'.repeat(64),
          capturedAt: '2026-08-11T14:00:00+08:00',
          status: 'available',
          error: null,
          title: '精恭纺验收推进会议',
          createdAt: '2026-08-10T17:42:00+08:00',
          durationSeconds: 1200,
          sourceUrl: 'qianwen.com/chat/recording-a',
          transcriptComplete: true,
          transcript: '发言人：确认四类验收口径。',
          summary: '确认四类验收口径。',
        }],
      },
    },
  };
}

function fileSystem(root: string): MeetingNoteFileSystem {
  return {
    exists: async (path) => readFile(join(root, path)).then(() => true, () => false),
    read: async (path) => readFile(join(root, path), 'utf8'),
    ensureDirectory: async (path) => {
      await mkdir(join(root, path), { recursive: true });
    },
    create: async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, { encoding: 'utf8', flag: 'wx' });
    },
    process: async (path, transform) => {
      const filePath = join(root, path);
      const updated = transform(await readFile(filePath, 'utf8'));
      await writeFile(filePath, updated, 'utf8');
      return updated;
    },
    listMarkdownFiles: async (path) => {
      try {
        const entries = await readdir(join(root, path), { recursive: true, withFileTypes: true });
        const base = join(root, path);
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => join(path, entry.parentPath.slice(base.length + 1), entry.name));
      } catch {
        return [];
      }
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('meeting match evidence materialization', () => {
  it('confirms a match, creates meeting evidence, and preserves the DingTalk mirror byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-meeting-match-evidence-'));
    roots.push(root);
    await mkdir(dirname(join(root, EVENT_PATH)), { recursive: true });
    await writeFile(join(root, EVENT_PATH), eventDocument(), 'utf8');
    const sourceBefore = await readFile(join(root, EVENT_PATH), 'utf8');
    const ids = ['decision-confirm'];

    const result = await confirmMeetingMatchWithEvidence({
      sourceRepository: { load: async () => sourceState(), save: async () => undefined },
      decisionRepository: new FileMeetingMatchDecisionRepository(root),
      meetingNotes: new MeetingNoteController(fileSystem(root)),
      listCalendarSources: async () => [{
        eventPath: EVENT_PATH,
        eventKeyHash: EVENT_HASH,
        title: '精恭纺验收推进会议',
        scheduled: '2026-08-10T17:00:00+08:00',
        meetingDate: '2026-08-10',
        durationMinutes: 60,
      }],
      readCalendarSource: async (path) => readFile(join(root, path), 'utf8'),
      readMeetingNote: async (path) => readFile(join(root, path), 'utf8'),
      clock: () => new Date('2026-08-11T14:00:00.000Z'),
      id: () => ids.shift() ?? 'unexpected',
    }, {
      recordingId: 'recording-a',
      eventKeyHash: EVENT_HASH,
    });

    expect(result.decision.action).toBe('confirmed');
    expect(result.meetingPath).toMatch(/^08_Meetings\/2026-08\//u);
    await expect(readFile(join(root, result.meetingPath), 'utf8'))
      .resolves.toContain('确认四类验收口径');
    await expect(readFile(join(root, EVENT_PATH), 'utf8')).resolves.toBe(sourceBefore);
  });

  it('records no-calendar as a durable decision with independent meeting evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-meeting-no-calendar-'));
    roots.push(root);

    const result = await markRecordingWithoutCalendarWithEvidence({
      sourceRepository: { load: async () => sourceState(), save: async () => undefined },
      decisionRepository: new FileMeetingMatchDecisionRepository(root),
      meetingNotes: new MeetingNoteController(fileSystem(root)),
      listCalendarSources: async () => [],
      readCalendarSource: async () => '',
      readMeetingNote: async (path) => readFile(join(root, path), 'utf8'),
      clock: () => new Date('2026-08-11T14:00:00.000Z'),
      id: () => 'decision-no-calendar',
    }, { recordingId: 'recording-a' });

    expect(result.decision.action).toBe('no_calendar');
    const raw = await readFile(join(root, result.meetingPath), 'utf8');
    expect(raw).toContain('match_status: no_calendar');
    expect(raw).toContain('qianwen_recording_id: recording-a');
  });

  it('restores an existing meeting note when post-write evidence validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-meeting-match-rollback-'));
    roots.push(root);
    await mkdir(dirname(join(root, EVENT_PATH)), { recursive: true });
    await writeFile(join(root, EVENT_PATH), eventDocument(), 'utf8');
    const meetingNotes = new MeetingNoteController(fileSystem(root));
    const existing = await meetingNotes.create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '用户原有正文',
    });
    await writeFile(join(root, existing.path), `${await readFile(join(root, existing.path), 'utf8')}\n人工补充。\n`, 'utf8');
    const before = await readFile(join(root, existing.path), 'utf8');
    const ids = ['decision-rollback', 'decision-rollback-revoked'];

    await expect(confirmMeetingMatchWithEvidence({
      sourceRepository: { load: async () => sourceState(), save: async () => undefined },
      decisionRepository: new FileMeetingMatchDecisionRepository(root),
      meetingNotes,
      listCalendarSources: async () => [{
        eventPath: EVENT_PATH,
        eventKeyHash: EVENT_HASH,
        title: '精恭纺验收推进会议',
        scheduled: '2026-08-10T17:00:00+08:00',
        meetingDate: '2026-08-10',
        durationMinutes: 60,
      }],
      readCalendarSource: async (path) => readFile(join(root, path), 'utf8'),
      readMeetingNote: async () => before,
      clock: () => new Date('2026-08-11T14:00:00.000Z'),
      id: () => ids.shift() ?? 'unexpected',
    }, {
      recordingId: 'recording-a',
      eventKeyHash: EVENT_HASH,
    })).rejects.toMatchObject({ code: 'meeting_evidence_unavailable' });

    await expect(readFile(join(root, existing.path), 'utf8')).resolves.toBe(before);
    await expect(new FileMeetingMatchDecisionRepository(root).listActive()).resolves.toEqual([]);
  });
});
