import { describe, expect, it, vi } from 'vitest';

import {
  collectWeeklyCoachContext,
  type WeeklyCoachContextGateway,
} from '../../../src/services/weekly-coach-context.js';

const PATHS = [
  '01_Areas/2026-Q3目标.md',
  '02_Projects/StyleWork.md',
  '10_Tasks/Active/task-a.md',
  'TaskNotes/日历说明.md',
  '日志/每日所思/02_每周复盘/2026-W29.md',
  '笔记同步助手/2026-07-26/同步助手_2026-07-26.md',
  '日志/每日所思/2026-07-26.md',
];

function gateway(content = '正文'): WeeklyCoachContextGateway & {
  read: ReturnType<typeof vi.fn>;
} {
  return {
    listMarkdownPaths: vi.fn(async () => PATHS),
    read: vi.fn(async (path: string) => `${path}\n${content}`),
  };
}

describe('collectWeeklyCoachContext', () => {
  it('reads only the explicitly authorized source categories', async () => {
    const files = gateway();

    const result = await collectWeeklyCoachContext(files, ['项目', '任务']);

    expect(result.authorizedSources).toEqual(['项目', '任务']);
    expect(result.documents.map(({ path }) => path).sort()).toEqual([
      '02_Projects/StyleWork.md',
      '10_Tasks/Active/task-a.md',
    ].sort());
    expect(files.read).toHaveBeenCalledTimes(2);
    expect(files.read).not.toHaveBeenCalledWith(expect.stringContaining('笔记同步助手'));
    expect(files.read).not.toHaveBeenCalledWith(expect.stringContaining('每日所思/2026'));
  });

  it('keeps sensitive notes unavailable unless each source is explicitly selected', async () => {
    const defaultFiles = gateway();
    const defaults = await collectWeeklyCoachContext(defaultFiles, [
      '目标',
      '项目',
      '任务',
      '日历',
      '周复盘',
    ]);
    expect(defaults.documents.some(({ source }) => source === '笔记同步助手')).toBe(false);
    expect(defaults.documents.some(({ source }) => source === '每日所思')).toBe(false);

    const sensitiveFiles = gateway();
    const sensitive = await collectWeeklyCoachContext(sensitiveFiles, [
      '笔记同步助手',
      '每日所思',
    ]);
    expect(sensitive.documents.map(({ source }) => source)).toEqual([
      '每日所思',
      '笔记同步助手',
    ]);
  });

  it('deduplicates sources and caps every document and the complete model context', async () => {
    const manyPaths = Array.from(
      { length: 30 },
      (_, index) => `02_Projects/${String(index).padStart(2, '0')}.md`,
    );
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => manyPaths,
      read: async () => 'x'.repeat(20_000),
    };

    const result = await collectWeeklyCoachContext(files, ['项目', '项目']);

    expect(result.authorizedSources).toEqual(['项目']);
    expect(result.documents.length).toBeLessThanOrEqual(10);
    expect(result.documents.every(({ content }) => content.length <= 6_000)).toBe(true);
    expect(result.totalCharacters).toBeLessThanOrEqual(48_000);
    expect(result.omittedCount).toBeGreaterThan(0);
  });

  it('continues with readable documents and reports individual read failures', async () => {
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => [
        '02_Projects/readable.md',
        '02_Projects/unreadable.md',
        '10_Tasks/Active/task.md',
      ],
      read: async (path) => {
        if (path.endsWith('unreadable.md')) throw new Error('permission denied');
        return `可用：${path}`;
      },
    };

    const result = await collectWeeklyCoachContext(files, ['项目', '任务']);

    expect(result.documents.map(({ path }) => path).sort()).toEqual([
      '02_Projects/readable.md',
      '10_Tasks/Active/task.md',
    ].sort());
    expect(result.readFailures).toEqual([{
      source: '项目',
      path: '02_Projects/unreadable.md',
    }]);
    expect(result.omittedCount).toBe(0);
  });

  it('classifies goals only from explicit goal locations', async () => {
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => [
        '01_Areas/2026-Q3.md',
        '07_System/Agent_Context/长期目标.md',
        '10_Tasks/Active/task-补齐目标说明.md',
        '99_Archive/旧目标.md',
      ],
      read: async (path) => path,
    };

    const goals = await collectWeeklyCoachContext(files, ['目标']);
    expect(goals.documents.map(({ path }) => path).sort()).toEqual([
      '01_Areas/2026-Q3.md',
      '07_System/Agent_Context/长期目标.md',
    ].sort());

    const tasks = await collectWeeklyCoachContext(files, ['任务']);
    expect(tasks.documents.map(({ path }) => path)).toEqual([
      '10_Tasks/Active/task-补齐目标说明.md',
    ]);
  });

  it('does not treat archived notes as calendar or weekly-review context by name alone', async () => {
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => [
        'TaskNotes/DingTalk/current-event.md',
        '日志/每日所思/02_每周复盘/2026-W30.md',
        '05_Reviews/Weekly/2026-W30 周度重点.md',
        '99_Archive/旧日历记录.md',
        '99_Archive/历史/每周复盘/私人记录.md',
      ],
      read: async (path) => path,
    };

    const result = await collectWeeklyCoachContext(files, ['日历', '周复盘']);

    expect(result.documents.map(({ path }) => path).sort()).toEqual([
      'TaskNotes/DingTalk/current-event.md',
      '日志/每日所思/02_每周复盘/2026-W30.md',
      '05_Reviews/Weekly/2026-W30 周度重点.md',
    ].sort());
  });

  it('selects calendar notes by scheduled time instead of hash-like file names', async () => {
    const scheduledByPath = new Map([
      ['TaskNotes/DingTalk/sha256-fff.md', '2026-01-01T09:00:00+08:00'],
      ['TaskNotes/DingTalk/sha256-000.md', '2026-07-27T09:00:00+08:00'],
      ...Array.from({ length: 9 }, (_, index) => [
        `TaskNotes/DingTalk/sha256-current-${index}.md`,
        `2026-07-${String(26 - index).padStart(2, '0')}T09:00:00+08:00`,
      ] as const),
    ]);
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => [...scheduledByPath.keys()],
      read: async (path) => [
        '---',
        `scheduled: ${scheduledByPath.get(path)}`,
        '---',
        path,
      ].join('\n'),
    };

    const result = await collectWeeklyCoachContext(files, ['日历'], {
      now: new Date('2026-07-26T08:00:00+08:00'),
    });

    expect(result.documents).toHaveLength(10);
    expect(result.documents.map(({ path }) => path)).toContain(
      'TaskNotes/DingTalk/sha256-000.md',
    );
    expect(result.documents.map(({ path }) => path)).not.toContain(
      'TaskNotes/DingTalk/sha256-fff.md',
    );
    expect(result.omittedCount).toBe(1);
  });

  it('reports documents truncated before they are sent to the model', async () => {
    const files: WeeklyCoachContextGateway = {
      listMarkdownPaths: async () => ['02_Projects/long.md'],
      read: async () => 'x'.repeat(6_001),
    };

    const result = await collectWeeklyCoachContext(files, ['项目']);

    expect(result.documents[0]?.content).toHaveLength(6_000);
    expect(result.truncatedDocuments).toEqual([{
      source: '项目',
      path: '02_Projects/long.md',
    }]);
  });
});
