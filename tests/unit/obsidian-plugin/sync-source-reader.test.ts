import { describe, expect, it } from 'vitest';

import {
  readSyncSourceRecords,
  sourceDateRange,
  type SyncSourceReaderFileSystem,
} from '../../../src/obsidian-plugin/sync-source-reader.js';

class MemorySourceFileSystem implements SyncSourceReaderFileSystem {
  readonly listedDirectories: string[] = [];

  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async exists(): Promise<boolean> {
    return true;
  }

  async listMarkdownFiles(relativeDirectory: string): Promise<string[]> {
    this.listedDirectories.push(relativeDirectory);
    const prefix = `${relativeDirectory}/`;
    return Object.keys(this.files).filter((path) => path.startsWith(prefix));
  }

  async read(relativePath: string): Promise<string> {
    const content = this.files[relativePath];
    if (content === undefined) throw new Error(`Missing fixture: ${relativePath}`);
    return content;
  }
}

describe('sourceDateRange', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');

  it('uses yesterday and today for the first scan in the local timezone', () => {
    expect(sourceDateRange(now, null)).toEqual([
      '2026-07-16',
      '2026-07-17',
    ]);
  });

  it('rescans from the local date of the last successful checkpoint', () => {
    expect(sourceDateRange(
      now,
      '2026-07-15T11:30:00.000Z',
    )).toEqual([
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
    ]);
  });
});

describe('readSyncSourceRecords', () => {
  it('skips an absent date directory without aborting the scan', async () => {
    const todayPath = '笔记同步助手/2026-07-17/today.md';
    const fileSystem = {
      exists: async (relativePath: string) => relativePath.endsWith('2026-07-17'),
      listMarkdownFiles: async (relativeDirectory: string) => {
        if (relativeDirectory.endsWith('2026-07-16')) {
          throw new Error('Folder does not exist');
        }
        return [todayPath];
      },
      read: async () => '#待办 只处理今天存在的记录',
    };

    const result = await readSyncSourceRecords({
      fileSystem,
      now: new Date('2026-07-17T12:00:00.000Z'),
      lastSuccessfulScanAt: null,
    });

    expect(result.filesScanned).toBe(1);
    expect(result.records.map(({ sourceNote }) => sourceNote)).toEqual([todayPath]);
  });

  it('reads direct Markdown files only and splits aggregate sync notes', async () => {
    const aggregatePath = '笔记同步助手/2026-07-17/同步助手_2026-07-17.md';
    const articlePath = '笔记同步助手/2026-07-17/一篇文章.md';
    const fileSystem = new MemorySourceFileSystem({
      [aggregatePath]: `---\nsyncedIds: abc\n---\n\n---\n#### 第一条\n## 📅 2026-07-17 09:15:00\n#待办 调研第一个工具\n\n---\n#### 第二条\n## 📅 2026-07-17 11:40:00\n#待办 整理第二份方案\n`,
      [articlePath]: '# 一篇文章\n\n只有信息，没有明确行动。',
      '笔记同步助手/2026-07-17/nested/hidden.md': '# 不应读取',
    });

    const result = await readSyncSourceRecords({
      fileSystem,
      now: new Date('2026-07-17T12:00:00.000Z'),
      lastSuccessfulScanAt: null,
    });

    expect(fileSystem.listedDirectories).toEqual([
      '笔记同步助手/2026-07-16',
      '笔记同步助手/2026-07-17',
    ]);
    expect(result.filesScanned).toBe(2);
    expect(result.records).toHaveLength(3);
    expect(result.records.map(({ recordedAt }) => recordedAt)).toEqual([
      null,
      '2026-07-17T09:15:00+08:00',
      '2026-07-17T11:40:00+08:00',
    ]);
    expect(result.records.map(({ sourceNote }) => sourceNote)).toEqual([
      articlePath,
      aggregatePath,
      aggregatePath,
    ]);
    expect(result.records[1]?.content).toContain('#待办 调研第一个工具');
    expect(result.records[1]?.content).not.toContain('整理第二份方案');
    expect(result.records.every(({ fingerprint }) => /^[a-f0-9]{64}$/.test(fingerprint)))
      .toBe(true);
    expect(new Set(result.records.map(({ fingerprint }) => fingerprint)).size).toBe(3);
  });

  it('produces stable fingerprints for equivalent line endings', async () => {
    const path = '笔记同步助手/2026-07-17/note.md';
    const base = {
      now: new Date('2026-07-17T12:00:00.000Z'),
      lastSuccessfulScanAt: '2026-07-17T01:00:00.000Z',
    };
    const first = await readSyncSourceRecords({
      ...base,
      fileSystem: new MemorySourceFileSystem({ [path]: '第一行\r\n第二行\r\n' }),
    });
    const second = await readSyncSourceRecords({
      ...base,
      fileSystem: new MemorySourceFileSystem({ [path]: '第一行\n第二行\n' }),
    });

    expect(first.records[0]?.fingerprint).toBe(second.records[0]?.fingerprint);
  });
});
