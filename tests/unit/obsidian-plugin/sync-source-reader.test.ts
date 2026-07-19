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

  it('uses a 14-day inclusive lookback for the first scan in the local timezone', () => {
    expect(sourceDateRange(now, null)).toEqual([
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
    ]);
  });

  it('rescans from the local date of the last successful checkpoint', () => {
    expect(sourceDateRange(
      now,
      '2026-07-15T11:30:00.000Z',
    )).toEqual([
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
    ]);
  });

  it('does not expand beyond 14 days for an old checkpoint', () => {
    const dates = sourceDateRange(now, '2026-05-01T11:30:00.000Z');

    expect(dates).toHaveLength(14);
    expect(dates.at(0)).toBe('2026-07-04');
    expect(dates.at(-1)).toBe('2026-07-17');
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

    expect(fileSystem.listedDirectories).toHaveLength(14);
    expect(fileSystem.listedDirectories.at(0)).toBe('笔记同步助手/2026-07-04');
    expect(fileSystem.listedDirectories.at(-1)).toBe('笔记同步助手/2026-07-17');
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

  it('merges an image record with adjacent explanatory text into one semantic message', async () => {
    const path = '笔记同步助手/2026-07-17/同步助手_2026-07-17.md';
    const fileSystem = new MemorySourceFileSystem({
      [path]: `#### 图片\n## 📅 2026-07-17 10:00:02\n![[images/tool.png]]\n\n#### 说明\n## 📅 2026-07-17 10:00:00\n评估示例工具 #待办\n\n#### 另一件事\n## 📅 2026-07-17 09:40:00\n#待办 整理周报\n`,
    });

    const result = await readSyncSourceRecords({
      fileSystem,
      now: new Date('2026-07-17T12:00:00.000Z'),
      lastSuccessfulScanAt: null,
    });

    expect(result.records).toHaveLength(2);
    expect(result.records[0]?.content).toContain('![[images/tool.png]]');
    expect(result.records[0]?.content).toContain('评估示例工具 #待办');
    expect(result.records[1]?.content).toBe('#待办 整理周报');
  });
});
