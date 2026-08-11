import { describe, expect, it } from 'vitest';

import {
  claimQianwenScheduledScan,
  normalizeQianwenSourceScan,
} from '../../../src/obsidian-plugin/qianwen-source-state.js';

describe('Qianwen source state', () => {
  it('keeps connector health separate from each recording transcription state', () => {
    const snapshot = normalizeQianwenSourceScan({
      connectorStatus: 'connected',
      scannedAt: '2026-08-11T22:00:00+08:00',
      range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      recordings: [
        { id: 'ready', transcriptComplete: true, transcript: '已完成转写' },
        { id: 'waiting', transcriptComplete: false, transcript: '' },
        {
          id: 'failed',
          transcriptComplete: false,
          transcript: '',
          transcriptionError: '听记内容读取失败',
        },
      ],
    });

    expect(snapshot.connector.status).toBe('connected');
    expect(snapshot.recordings.map((item) => [item.id, item.status])).toEqual([
      ['ready', 'available'],
      ['waiting', 'waiting'],
      ['failed', 'failed'],
    ]);
  });

  it('does not convert a connector failure into an empty successful scan', () => {
    const snapshot = normalizeQianwenSourceScan({
      connectorStatus: 'login_required',
      scannedAt: '2026-08-11T22:00:00+08:00',
      range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      recordings: [],
    });

    expect(snapshot.connector.status).toBe('login_required');
    expect(snapshot.connector.resultKind).toBe('failed');
    expect(snapshot.recordings).toEqual([]);
  });

  it('claims the latest due local date once and skips repeated startup attempts', () => {
    const first = claimQianwenScheduledScan({
      now: new Date('2026-08-11T08:00:00+08:00'),
      lastAttemptedDate: '2026-08-09',
      timeZone: 'Asia/Shanghai',
    });
    expect(first).toEqual({
      targetDate: '2026-08-10',
      checkpoint: { lastAttemptedDate: '2026-08-10' },
    });

    expect(claimQianwenScheduledScan({
      now: new Date('2026-08-11T08:05:00+08:00'),
      lastAttemptedDate: first?.checkpoint.lastAttemptedDate ?? null,
      timeZone: 'Asia/Shanghai',
    })).toBeNull();

    expect(claimQianwenScheduledScan({
      now: new Date('2026-08-11T22:05:00+08:00'),
      lastAttemptedDate: first?.checkpoint.lastAttemptedDate ?? null,
      timeZone: 'Asia/Shanghai',
    })?.targetDate).toBe('2026-08-11');
  });
});
