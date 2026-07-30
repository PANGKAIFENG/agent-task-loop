import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ATL_BOARD_PATH,
  BoardAppearanceController,
} from '../../../src/obsidian-plugin/board-appearance-controller.js';

const roots: string[] = [];

const original = `filters:
  and:
    - file.inFolder("10_Tasks")
formulas:
  atlPriorityRank: if(priority == "urgent", 1, 9)
  userFormula: file.name
properties:
  review_state:
    displayName: 确认状态
views:
  - type: tasknotesKanban
    name: 任务总看板
    groupBy:
      property: formula.atlStatus
      direction: ASC
    order:
      - priority
      - project_id
      - review_state
      - source_date
      - file.name
    sort:
      - property: formula.atlPriorityRank
        direction: ASC
    columnWidth: 300
    hideEmptyColumns: false
    cardLayout: compact
  - type: tasknotesKanban
    name: 工作任务
    filters:
      and:
        - task_scope == "work"
    order:
      - priority
    sort:
      - property: file.name
        direction: ASC
    columnWidth: 301
  - type: tasknotesKanban
    name: 个人实践
    filters:
      and:
        - task_scope == "personal"
    order:
      - priority
    sort:
      - property: file.name
        direction: ASC
    columnWidth: 302
  - type: tasknotesKanban
    name: 待归类
    filters:
      and:
        - formula.atlScope == "待归类"
    order:
      - priority
    sort:
      - property: file.name
        direction: ASC
    columnWidth: 303
  - type: tasknotesKanban
    name: 我的自建视图
    order:
      - review_state
    sort:
      - property: file.name
        direction: ASC
    columnWidth: 444
  - type: tasknotesCalendar
    name: 日历
    calendarView: timeGridWeek
    options:
      showScheduled: true
`;

async function fixture(content = original) {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'atl-board-appearance-'));
  roots.push(vaultRoot);
  const basePath = join(vaultRoot, ATL_BOARD_PATH);
  await mkdir(dirname(basePath), { recursive: true });
  await writeFile(basePath, content, 'utf8');
  return { vaultRoot, basePath, backupPath: `${basePath}.atl-backup` };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('BoardAppearanceController', () => {
  it('applies the manual-first dated preset to managed views and preserves the original backup', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      formulas: Record<string, string>;
      properties: Record<string, { displayName?: string }>;
      views: Array<Record<string, unknown>>;
    };
    const managedNames = ['任务总看板', '工作任务', '个人实践', '待归类'];
    for (const name of managedNames) {
      expect(parsed.views.find((view) => view.name === name)).toMatchObject({
        type: 'tasknotesKanban',
        name,
        order: [
          'project_id',
          'source_date',
          'formula.atlCollectedAt',
          'formula.atlPlannedAt',
          'priority',
        ],
        columnWidth: 320,
        cardLayout: 'compact',
        hideEmptyColumns: true,
        groupBy: { property: 'status', direction: 'ASC' },
        pinnedColumns: 'inbox,ready,in_progress,done',
        columnOrder: '{"status":["inbox","ready","in_progress","done"]}',
        sort: [
          { column: 'tasknotes_manual_order', direction: 'DESC' },
          { column: 'formula.atlCollectedAt', direction: 'DESC' },
          { column: 'source_date', direction: 'DESC' },
          { column: 'formula.atlPriorityRank', direction: 'ASC' },
        ],
      });
    }
    expect(parsed.formulas).toMatchObject({
      atlCollectedAt: expect.stringContaining('created_at'),
      atlPlannedAt: expect.stringContaining('scheduled'),
      userFormula: 'file.name',
    });
    expect(parsed.properties).toMatchObject({
      source_date: { displayName: '来源日期' },
      'formula.atlCollectedAt': { displayName: '入箱时间' },
      'formula.atlPlannedAt': { displayName: '计划时间' },
      review_state: { displayName: '确认状态' },
    });
    expect(parsed.views.find((view) => view.name === '工作任务')).toMatchObject({
      filters: { and: ['task_scope == "work"'] },
    });
    expect(parsed.views.find((view) => view.name === '个人实践')).toMatchObject({
      filters: { and: ['task_scope == "personal"'] },
    });
    expect(parsed.views.find((view) => view.name === '待归类')).toMatchObject({
      filters: { and: ['formula.atlScope == "待归类"'] },
    });
    expect(parsed.views.find((view) => view.name === '我的自建视图')).toMatchObject({
      order: ['review_state'],
      sort: [{ property: 'file.name', direction: 'ASC' }],
      columnWidth: 444,
    });
    const originalCalendar = (parse(original) as {
      views: Array<Record<string, unknown>>;
    }).views[5];
    expect(parsed.views[5]).toEqual(originalCalendar);
    expect(await readFile(paths.backupPath, 'utf8')).toBe(original);

    await writeFile(paths.backupPath, 'first original stays authoritative\n', 'utf8');
    await controller.applyRecommendedPreset(paths.vaultRoot);
    expect(await readFile(paths.backupPath, 'utf8')).toBe(
      'first original stays authoritative\n',
    );
  });

  it('reports preset status and restores the original file byte-for-byte', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();
    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: false,
      restorable: false,
    });

    await controller.applyRecommendedPreset(paths.vaultRoot);
    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: true,
      restorable: true,
    });

    await controller.restorePreset(paths.vaultRoot);
    expect(await readFile(paths.basePath, 'utf8')).toBe(original);
    await expect(controller.status(paths.vaultRoot)).resolves.toEqual({
      available: true,
      applied: false,
      restorable: true,
    });
  });

  it('ignores calendar options when reporting or reapplying the Kanban preset', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();
    await controller.applyRecommendedPreset(paths.vaultRoot);

    const document = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    const calendar = document.views.find((view) => view.name === '日历');
    expect(calendar).toBeDefined();
    if (calendar === undefined) throw new Error('missing calendar fixture');
    calendar.options = {
      showScheduled: false,
      slotEventOverlap: true,
      customCalendarOption: 'keep-me',
    };
    await writeFile(paths.basePath, stringify(document, { lineWidth: 0 }), 'utf8');

    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: true,
    });

    await controller.applyRecommendedPreset(paths.vaultRoot);
    const reapplied = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    expect(reapplied.views.find((view) => view.name === '日历')).toMatchObject({
      options: {
        showScheduled: false,
        slotEventOverlap: true,
        customCalendarOption: 'keep-me',
      },
    });
    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: true,
    });
  });

  it('preserves a 日历视图 byte-for-byte at the parsed-data level', async () => {
    const content = original.replace('name: 日历', 'name: 日历视图');
    const paths = await fixture(content);
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    const originalCalendar = (parse(content) as {
      views: Array<Record<string, unknown>>;
    }).views[5];
    expect(parsed.views[5]).toEqual(originalCalendar);
  });

  it('keeps the Kanban preset behavior without adding a calendar view', async () => {
    const withoutCalendar = original.replace(
      /\n {2}- type: tasknotesCalendar[\s\S]*$/,
      '\n',
    );
    const paths = await fixture(withoutCalendar);
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    expect(parsed.views).toHaveLength(5);
    expect(parsed.views.some((view) => view.type === 'tasknotesCalendar')).toBe(false);
    expect(parsed.views[0]).toMatchObject({
      type: 'tasknotesKanban',
      name: '任务总看板',
      groupBy: { property: 'status', direction: 'ASC' },
    });
    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: true,
    });
  });

  it('preserves multiple calendar views because calendars are outside the preset boundary', async () => {
    const ambiguous = `${original}  - type: tasknotesCalendar\n    name: 日历视图\n`;
    const paths = await fixture(ambiguous);
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const before = (parse(ambiguous) as {
      views: Array<Record<string, unknown>>;
    }).views.filter((view) => view.type === 'tasknotesCalendar');
    const after = (parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    }).views.filter((view) => view.type === 'tasknotesCalendar');
    expect(after).toEqual(before);
    expect(await readFile(paths.backupPath, 'utf8')).toBe(ambiguous);
  });

  it('rejects ambiguous TaskNotes views without creating a backup', async () => {
    const paths = await fixture(`${original}\nviews:\n  - type: tasknotesKanban\n    name: 任务总看板\n`);
    const controller = new BoardAppearanceController();

    await expect(controller.applyRecommendedPreset(paths.vaultRoot)).rejects.toThrow(
      '任务总看板配置无效',
    );
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('updates the available managed views when optional category views are absent', async () => {
    const parsed = parse(original) as { views: Array<Record<string, unknown>> };
    parsed.views = parsed.views.filter((view) => (
      view.name !== '工作任务'
      && view.name !== '个人实践'
      && view.name !== '待归类'
    ));
    const paths = await fixture(stringify(parsed, { lineWidth: 0 }));
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: true,
    });
  });

  it('rejects a duplicate optional managed view without writing or creating a backup', async () => {
    const parsed = parse(original) as { views: Array<Record<string, unknown>> };
    const workView = parsed.views.find((view) => view.name === '工作任务');
    if (workView === undefined) throw new Error('missing work view fixture');
    parsed.views.push(structuredClone(workView));
    const duplicate = stringify(parsed, { lineWidth: 0 });
    const paths = await fixture(duplicate);
    const controller = new BoardAppearanceController();

    await expect(controller.applyRecommendedPreset(paths.vaultRoot)).rejects.toThrow(
      '任务总看板配置无效',
    );
    expect(await readFile(paths.basePath, 'utf8')).toBe(duplicate);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports the preset as stale when one managed view still exposes scheduled', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();
    await controller.applyRecommendedPreset(paths.vaultRoot);
    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    const personal = parsed.views.find((view) => view.name === '个人实践');
    if (personal === undefined) throw new Error('missing personal view fixture');
    personal.order = ['project_id', 'scheduled', 'priority'];
    await writeFile(paths.basePath, stringify(parsed, { lineWidth: 0 }), 'utf8');

    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: false,
    });
  });

  it('guards boolean false before checking whether scheduled is empty', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      formulas: Record<string, string>;
    };
    expect(parsed.formulas.atlPlannedAt).toBe(
      'if(scheduled == false, null, if(scheduled.isEmpty(), null, date(scheduled)))',
    );
  });

  it('falls back to file creation time before parsing a malformed created_at', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      formulas: Record<string, string>;
    };
    expect(parsed.formulas.atlCollectedAt).toBe(String.raw`if(created_at.isType("date"), created_at, if(created_at.isType("string") && /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.matches(created_at), date(created_at), file.ctime))`);
  });

  it('rejects a Base path that escapes the Vault through a symlink', async () => {
    const paths = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'atl-board-outside-'));
    roots.push(outsideRoot);
    const outside = join(outsideRoot, 'outside.base');
    await writeFile(outside, original, 'utf8');
    await rm(paths.basePath);
    await symlink(outside, paths.basePath);

    const controller = new BoardAppearanceController();
    await expect(controller.applyRecommendedPreset(paths.vaultRoot)).rejects.toThrow(
      '任务总看板文件不安全',
    );
    expect(await readFile(outside, 'utf8')).toBe(original);
  });
});
