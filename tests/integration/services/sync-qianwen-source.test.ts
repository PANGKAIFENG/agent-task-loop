import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { syncQianwenSource } from '../../../src/services/sync-qianwen-source.js';
import { FileQianwenSourceStateRepository } from '../../../src/storage/qianwen-source-state-repository.js';

describe('sync Qianwen source', () => {
  it('rejects persistent state writes outside temporary storage without authorization', async () => {
    const root = await mkdtemp(join(process.cwd(), '.atl-qianwen-auth-'));
    const scan = vi.fn(async () => ({
      connectorStatus: 'connected' as const,
      scannedAt: '2026-08-11T08:00:01+08:00',
      range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      recordings: [],
    }));
    try {
      await expect(syncQianwenSource({
        repository: new FileQianwenSourceStateRepository(root),
        connector: { scan },
        now: new Date('2026-08-11T08:00:00+08:00'),
        timeZone: 'Asia/Shanghai',
        mode: 'manual',
      })).rejects.toThrow('Vault writes are disabled');
      expect(scan).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists a scheduled claim before scanning and skips the repeated startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-state-'));
    const repository = new FileQianwenSourceStateRepository(root);
    const scan = vi.fn(async () => ({
      connectorStatus: 'connected' as const,
      scannedAt: '2026-08-11T08:00:01+08:00',
      range: { startDate: '2026-08-04', endDate: '2026-08-10' },
      recordings: [{
        id: 'waiting',
        title: '等待转写的会议',
        createdAt: '2026-08-10T19:00:00+08:00',
        durationSeconds: 600,
        sourceUrl: 'https://qianwen.com/chat/waiting',
        transcriptComplete: false,
        transcript: '',
        summary: '',
      }],
    }));

    const first = await syncQianwenSource({
      repository,
      connector: { scan },
      now: new Date('2026-08-11T08:00:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'scheduled',
    });
    const second = await syncQianwenSource({
      repository,
      connector: { scan },
      now: new Date('2026-08-11T08:05:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'scheduled',
    });

    expect(first.status).toBe('completed');
    expect(second).toEqual({ status: 'not_due' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect((await repository.load()).lastAttemptedDate).toBe('2026-08-10');
    expect((await repository.load()).lastSuccessfulScan?.recordings[0]?.status).toBe('waiting');
    expect((await stat(join(root, 'qianwen-source-state.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(root, 'qianwen-source-state.json'), 'utf8')))
      .toMatchObject({ schemaVersion: 2, lastAttemptedDate: '2026-08-10' });
  });

  it('serializes concurrent synchronizations and preserves both recording updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-concurrent-'));
    const left = new FileQianwenSourceStateRepository(root);
    const right = new FileQianwenSourceStateRepository(root);
    let releaseLeft!: () => void;
    let leftEntered!: () => void;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    const leftReady = new Promise<void>((resolve) => { leftEntered = resolve; });
    const leftRelease = new Promise<void>((resolve) => { releaseLeft = resolve; });
    const rightScan = vi.fn(async () => ({
      connectorStatus: 'connected' as const,
      scannedAt: '2026-08-11T08:01:00+08:00',
      range: { startDate: '2026-08-05', endDate: '2026-08-11' },
      recordings: [{
        id: 'recording-right',
        title: '右侧同步',
        createdAt: '2026-08-11T07:00:00+08:00',
        durationSeconds: 300,
        sourceUrl: 'https://qianwen.com/chat/right',
        transcriptComplete: true,
        transcript: '右侧原文',
        summary: '右侧摘要',
      }],
    }));
    try {
      first = syncQianwenSource({
        repository: left,
        connector: { scan: async () => {
          leftEntered();
          await leftRelease;
          return {
            connectorStatus: 'connected' as const,
            scannedAt: '2026-08-11T08:00:00+08:00',
            range: { startDate: '2026-08-05', endDate: '2026-08-11' },
            recordings: [{
              id: 'recording-left',
              title: '左侧同步',
              createdAt: '2026-08-11T06:00:00+08:00',
              durationSeconds: 300,
              sourceUrl: 'https://qianwen.com/chat/left',
              transcriptComplete: true,
              transcript: '左侧原文',
              summary: '左侧摘要',
            }],
          };
        } },
        now: new Date('2026-08-11T08:00:00+08:00'),
        timeZone: 'Asia/Shanghai',
        mode: 'manual',
      });
      await leftReady;
      second = syncQianwenSource({
        repository: right,
        connector: { scan: rightScan },
        now: new Date('2026-08-11T08:01:00+08:00'),
        timeZone: 'Asia/Shanghai',
        mode: 'manual',
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(rightScan).not.toHaveBeenCalled();
      releaseLeft();
      await Promise.all([first, second]);

      expect(Object.keys((await left.load()).recordings).sort()).toEqual([
        'recording-left',
        'recording-right',
      ]);
    } finally {
      releaseLeft?.();
      await Promise.allSettled([first, second].filter(
        (operation): operation is Promise<unknown> => operation !== undefined,
      ));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the last successful result when a later connector scan fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-state-'));
    const repository = new FileQianwenSourceStateRepository(root);
    await syncQianwenSource({
      repository,
      connector: { scan: async () => ({
        connectorStatus: 'connected',
        scannedAt: '2026-08-10T22:00:00+08:00',
        range: { startDate: '2026-08-04', endDate: '2026-08-10' },
        recordings: [{
          id: 'ready',
          title: '已完成会议',
          createdAt: '2026-08-10T19:00:00+08:00',
          durationSeconds: 600,
          sourceUrl: 'https://qianwen.com/chat/ready',
          transcriptComplete: true,
          transcript: '原文',
          summary: '摘要',
        }],
      }) },
      now: new Date('2026-08-10T22:00:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'manual',
    });

    await syncQianwenSource({
      repository,
      connector: { scan: async () => ({
        connectorStatus: 'login_required',
        scannedAt: '2026-08-11T22:00:00+08:00',
        range: { startDate: '2026-08-05', endDate: '2026-08-11' },
        recordings: [],
      }) },
      now: new Date('2026-08-11T22:00:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'manual',
    });

    const state = await repository.load();
    expect(state.lastScan?.connector.status).toBe('login_required');
    expect(state.lastSuccessfulScan?.connector.scannedAt).toBe('2026-08-10T22:00:00+08:00');
    expect(state.lastSuccessfulScan?.recordings).toHaveLength(1);
  });

  it('uses today for a manual scan even before the scheduled 22:00 run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-state-'));
    const repository = new FileQianwenSourceStateRepository(root);
    const scan = vi.fn(async (range: { startDate: string; endDate: string }) => ({
      connectorStatus: 'connected' as const,
      scannedAt: '2026-08-11T08:00:01+08:00',
      range,
      recordings: [],
    }));

    await syncQianwenSource({
      repository,
      connector: { scan },
      now: new Date('2026-08-11T08:00:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'manual',
    });

    expect(scan).toHaveBeenCalledWith({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });
  });

  it('versions changed recording content without duplicating an unchanged scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-state-'));
    const repository = new FileQianwenSourceStateRepository(root);
    let transcript = '第一版原文';
    const connector = {
      scan: async () => ({
        connectorStatus: 'connected' as const,
        scannedAt: '2026-08-11T22:00:00+08:00',
        range: { startDate: '2026-08-05', endDate: '2026-08-11' },
        recordings: [{
          id: 'recording-1',
          title: '版本测试会议',
          createdAt: '2026-08-11T20:00:00+08:00',
          durationSeconds: 600,
          sourceUrl: 'https://qianwen.com/chat/recording-1',
          transcriptComplete: true,
          transcript,
          summary: '同一摘要',
        }],
      }),
    };
    const input = {
      repository,
      connector,
      now: new Date('2026-08-11T22:00:00+08:00'),
      timeZone: 'Asia/Shanghai',
      mode: 'manual' as const,
    };

    await syncQianwenSource(input);
    await syncQianwenSource(input);
    transcript = '第二版原文';
    await syncQianwenSource(input);

    const versions = (await repository.load()).recordings['recording-1']?.versions;
    expect(versions).toHaveLength(2);
    expect(versions?.map(({ version, transcript: value }) => [version, value])).toEqual([
      [1, '第一版原文'],
      [2, '第二版原文'],
    ]);
  });

  it('migrates a V1 state file while preserving its scheduling checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-qianwen-state-'));
    await writeFile(join(root, 'qianwen-source-state.json'), JSON.stringify({
      schemaVersion: 1,
      lastAttemptedDate: '2026-08-10',
      lastScan: null,
      lastSuccessfulScan: null,
    }), 'utf8');

    await expect(new FileQianwenSourceStateRepository(root).load()).resolves.toEqual({
      schemaVersion: 2,
      lastAttemptedDate: '2026-08-10',
      lastScan: null,
      lastSuccessfulScan: null,
      recordings: {},
    });
  });
});
