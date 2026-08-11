import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  confirmMeetingMatch,
  MeetingMatchConflictError,
  markRecordingWithoutCalendar,
  revokeMeetingMatchDecision,
} from '../../../src/services/decide-meeting-match.js';
import { FileMeetingMatchDecisionRepository } from '../../../src/storage/meeting-match-decision-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('meeting match decisions', () => {
  it('persists a confirmation and rejects duplicate recording or calendar assignments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-meeting-decisions-'));
    roots.push(root);
    const repository = new FileMeetingMatchDecisionRepository(root);
    const ids = ['decision-1', 'decision-2', 'decision-3'];
    const context = {
      repository,
      clock: () => new Date('2026-08-11T10:00:00.000Z'),
      id: () => ids.shift() ?? 'unexpected',
    };

    await expect(confirmMeetingMatch(context, {
      recordingId: 'recording-a',
      eventKeyHash: `sha256:${'a'.repeat(64)}`,
    })).resolves.toMatchObject({
      decisionId: 'decision-1',
      action: 'confirmed',
    });

    await expect(confirmMeetingMatch(context, {
      recordingId: 'recording-a',
      eventKeyHash: `sha256:${'b'.repeat(64)}`,
    })).rejects.toBeInstanceOf(MeetingMatchConflictError);
    await expect(confirmMeetingMatch(context, {
      recordingId: 'recording-b',
      eventKeyHash: `sha256:${'a'.repeat(64)}`,
    })).rejects.toBeInstanceOf(MeetingMatchConflictError);
    await expect(repository.list()).resolves.toHaveLength(1);
  });

  it('revokes an active decision before recording a reversible no-calendar decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-meeting-decisions-'));
    roots.push(root);
    const repository = new FileMeetingMatchDecisionRepository(root);
    const ids = ['decision-confirm', 'decision-revoke', 'decision-none', 'decision-revoke-none'];
    let minute = 0;
    const context = {
      repository,
      clock: () => new Date(`2026-08-11T10:${String(minute++).padStart(2, '0')}:00.000Z`),
      id: () => ids.shift() ?? 'unexpected',
    };

    const confirmed = await confirmMeetingMatch(context, {
      recordingId: 'recording-a',
      eventKeyHash: `sha256:${'a'.repeat(64)}`,
    });
    const revoked = await revokeMeetingMatchDecision(context, {
      decisionId: confirmed.decisionId,
    });
    expect(revoked).toMatchObject({
      action: 'revoked',
      recordingId: 'recording-a',
      supersedesDecisionId: confirmed.decisionId,
    });

    const noCalendar = await markRecordingWithoutCalendar(context, {
      recordingId: 'recording-a',
    });
    expect(noCalendar).toMatchObject({
      action: 'no_calendar',
      eventKeyHash: null,
    });
    await revokeMeetingMatchDecision(context, { decisionId: noCalendar.decisionId });

    await expect(repository.listActive()).resolves.toEqual([]);
    await expect(repository.list()).resolves.toHaveLength(4);
  });
});
