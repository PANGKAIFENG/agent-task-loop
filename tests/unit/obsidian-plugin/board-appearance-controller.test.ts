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
  it('applies the manual-first four-column preset and preserves the original backup', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    expect(parsed.views[0]).toMatchObject({
      type: 'tasknotesKanban',
      name: '任务总看板',
      order: ['project_id', 'scheduled', 'due', 'priority'],
      columnWidth: 320,
      cardLayout: 'compact',
      hideEmptyColumns: true,
      groupBy: { property: 'status', direction: 'ASC' },
      pinnedColumns: 'inbox,ready,in_progress,done',
      columnOrder: '{"status":["inbox","ready","in_progress","done"]}',
      sort: [
        { column: 'tasknotes_manual_order', direction: 'DESC' },
        { column: 'formula.atlPriorityRank', direction: 'ASC' },
      ],
    });
    expect(parsed.views[1]).toMatchObject({
      type: 'tasknotesCalendar',
      name: '日历',
      calendarView: 'timeGridWeek',
      options: {
        showScheduled: true,
        slotEventOverlap: false,
      },
    });
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

  it('treats a legacy overlapping calendar as not applied until the preset is reapplied', async () => {
    const paths = await fixture();
    const controller = new BoardAppearanceController();
    await controller.applyRecommendedPreset(paths.vaultRoot);

    const document = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    const calendar = document.views.find((view) => view.name === '日历');
    expect(calendar).toBeDefined();
    if (calendar === undefined) throw new Error('missing calendar fixture');
    calendar.options = { showScheduled: true };
    await writeFile(paths.basePath, stringify(document, { lineWidth: 0 }), 'utf8');

    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: false,
    });

    await controller.applyRecommendedPreset(paths.vaultRoot);
    await expect(controller.status(paths.vaultRoot)).resolves.toMatchObject({
      available: true,
      applied: true,
    });
  });

  it('updates the supported 日历视图 name and preserves its other fields', async () => {
    const paths = await fixture(original.replace('name: 日历', 'name: 日历视图'));
    const controller = new BoardAppearanceController();

    await controller.applyRecommendedPreset(paths.vaultRoot);

    const parsed = parse(await readFile(paths.basePath, 'utf8')) as {
      views: Array<Record<string, unknown>>;
    };
    expect(parsed.views[1]).toMatchObject({
      type: 'tasknotesCalendar',
      name: '日历视图',
      calendarView: 'timeGridWeek',
      options: {
        showScheduled: true,
        slotEventOverlap: false,
      },
    });
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
    expect(parsed.views).toHaveLength(1);
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

  it('rejects ambiguous supported calendar views without writing or creating a backup', async () => {
    const ambiguous = `${original}  - type: tasknotesCalendar\n    name: 日历视图\n`;
    const paths = await fixture(ambiguous);
    const controller = new BoardAppearanceController();

    await expect(controller.applyRecommendedPreset(paths.vaultRoot)).rejects.toThrow(
      '任务总看板配置无效',
    );
    expect(await readFile(paths.basePath, 'utf8')).toBe(ambiguous);
    await expect(readFile(paths.backupPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
