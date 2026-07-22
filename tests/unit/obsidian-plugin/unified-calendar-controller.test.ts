import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ATL_UNIFIED_CALENDAR_PATH,
  UnifiedCalendarController,
} from '../../../src/obsidian-plugin/unified-calendar-controller.js';

const roots: string[] = [];

function fileSystem() {
  return {
    exists: async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return false;
        }
        throw error;
      }
    },
    mkdir: async (path: string) => {
      await mkdir(path);
    },
    create: async (path: string, content: string) => {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    },
    read: async (path: string) => readFile(path, 'utf8'),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-unified-calendar-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('UnifiedCalendarController', () => {
  it('creates a Base with a unified calendar and an unscheduled task list', async () => {
    const root = await fixture();
    const controller = new UnifiedCalendarController(fileSystem());

    await expect(controller.ensure(root)).resolves.toEqual({
      path: join(root, ATL_UNIFIED_CALENDAR_PATH),
      created: true,
    });

    const parsed = parse(await readFile(join(root, ATL_UNIFIED_CALENDAR_PATH), 'utf8')) as {
      filters: { and: string[] };
      views: Array<Record<string, unknown>>;
    };
    expect(parsed.filters.and).toContain('note["type"] == "task"');
    expect(parsed.views).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tasknotesCalendar',
        name: '统一日历',
        options: expect.objectContaining({ slotEventOverlap: false }),
      }),
      expect.objectContaining({ type: 'tasknotesTaskList', name: '待排期任务' }),
    ]));
    const unscheduledView = JSON.stringify(
      parsed.views.find((view) => view.name === '待排期任务'),
    );
    expect(unscheduledView).toContain('(scheduled == false) || (scheduled == null)');
    expect(unscheduledView).not.toContain('date(scheduled)');
  });

  it('is idempotent and never overwrites an existing user Base', async () => {
    const root = await fixture();
    const path = join(root, ATL_UNIFIED_CALENDAR_PATH);
    await mkdir(dirname(path), { recursive: true });
    const existing = 'filters:\n  and:\n    - note["type"] == "task"\nviews: []\n';
    await writeFile(path, existing, 'utf8');
    const controller = new UnifiedCalendarController(fileSystem());

    await expect(controller.ensure(root)).resolves.toEqual({ path, created: false });
    expect(await readFile(path, 'utf8')).toBe(existing);
  });

  it('coalesces concurrent first-time creation without surfacing EEXIST', async () => {
    const root = await fixture();
    const base = fileSystem();
    const controller = new UnifiedCalendarController({
      ...base,
      mkdir: async (path) => {
        await delay(10);
        await base.mkdir(path);
      },
      create: async (path, content) => {
        await delay(10);
        await base.create(path, content);
      },
    });

    const results = await Promise.all([
      controller.ensure(root),
      controller.ensure(root),
    ]);

    expect(results.map(({ created }) => created).sort()).toEqual([false, true]);
  });

  it('rejects a path that exists but is not a Base document', async () => {
    const root = await fixture();
    const path = join(root, ATL_UNIFIED_CALENDAR_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not: a base\n', 'utf8');
    const controller = new UnifiedCalendarController(fileSystem());

    await expect(controller.ensure(root)).rejects.toThrow('统一日历文件格式无效');
  });

  it('refuses to create the Base through a directory symlink outside the Vault', async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, join(root, '10_Tasks'));
    const controller = new UnifiedCalendarController(fileSystem());

    await expect(controller.ensure(root)).rejects.toThrow('统一日历路径不安全');
    await expect(fileSystem().exists(join(outside, 'Views', '统一日历.base')))
      .resolves.toBe(false);
  });
});
