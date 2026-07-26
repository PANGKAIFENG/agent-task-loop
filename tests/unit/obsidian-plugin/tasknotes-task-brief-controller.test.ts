import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import * as controllerModule from '../../../src/obsidian-plugin/task-brief-controller.js';

const PATH = '10_Tasks/Inbox/实验：工作流skill完善.md';
const RAW = `---
status: ready
priority: normal
scheduled: 2026-07-29
dateCreated: 2026-07-22T11:27:02.466+08:00
type: task
task_scope: work
custom_field: keep-me
---

需要想清楚工具如何友好编排。
`;

type NativeController = {
  prepare(): Promise<{
    task: { taskId: string; title: string; body: string };
    project: null;
  }>;
  save(
    taskId: string,
    input: { objective: string; nextAction: string; completionCriteria: string },
    expectedUpdatedAt: string | null,
  ): Promise<unknown>;
};

interface NativeDependencies {
  path: string;
  read(path: string): Promise<string>;
  process(path: string, update: (current: string) => string): Promise<string>;
  appendAudit(event: Record<string, unknown>): Promise<void>;
  clock(): Date;
}

type NativeControllerConstructor = new (
  dependencies: NativeDependencies,
) => NativeController;

describe('TaskNotesTaskBriefController', () => {
  it('keeps a native TaskNotes task in place and adds only compatible ATL fields', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController?: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW;
    const processedPaths: string[] = [];
    const appendAudit = vi.fn(async () => undefined);
    const controller = new Controller({
      path: PATH,
      read: async () => stored,
      process: async (path, update) => {
        processedPaths.push(path);
        stored = update(stored);
        return stored;
      },
      appendAudit,
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });

    const prepared = await controller.prepare();
    expect(prepared.task.title).toBe('实验：工作流skill完善');
    expect(prepared.task.body).toContain('需要想清楚工具如何友好编排');

    await controller.save(prepared.task.taskId, {
      objective: '明确工具编排的用户交互',
      nextAction: '梳理工具展示与编排流程',
      completionCriteria: '形成可评审的交互方案',
    }, null);

    const match = /^---\n([\s\S]*?)\n---([\s\S]*)$/u.exec(stored);
    expect(match).not.toBeNull();
    const data = YAML.parse(match?.[1] ?? '') as Record<string, unknown>;
    expect(processedPaths).toEqual([PATH]);
    expect(data).toMatchObject({
      status: 'ready',
      scheduled: '2026-07-29',
      task_scope: 'work',
      custom_field: 'keep-me',
      type: 'task',
      schema_version: 1,
      title: '实验：工作流skill完善',
      updated_at: '2026-07-26T12:00:00.000Z',
      task_brief: {
        schema_version: 1,
        objective: '明确工具编排的用户交互',
        next_action: '梳理工具展示与编排流程',
        completion_criteria: '形成可评审的交互方案',
        updated_at: '2026-07-26T12:00:00.000Z',
      },
    });
    expect(data.task_id).toMatch(/^tasknotes-[a-f0-9]{16}$/u);
    expect(match?.[2]).toBe('\n\n需要想清楚工具如何友好编排。\n');
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'task.brief_saved',
      taskId: data.task_id,
    }));
  });

  it('merges the brief into the latest TaskNotes fields and body', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW;
    const controller = new Controller({
      path: PATH,
      read: async () => stored,
      process: async (_path, update) => {
        stored = update(stored);
        return stored;
      },
      appendAudit: async () => undefined,
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const prepared = await controller.prepare();
    stored = RAW
      .replace('priority: normal', 'priority: high')
      .replace('需要想清楚工具如何友好编排。', '用户刚刚补充的任务上下文。');

    await controller.save(prepared.task.taskId, {
      objective: '明确工具编排的用户交互',
      nextAction: '梳理工具展示与编排流程',
      completionCriteria: '形成可评审的交互方案',
    }, null);

    expect(stored).toContain('priority: high');
    expect(stored).toContain('用户刚刚补充的任务上下文。');
  });

  it('rejects a stale task brief instead of overwriting it', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW.replace('type: task', [
      'type: task',
      'task_brief:',
      '  schema_version: 1',
      '  objective: 旧目标',
      '  next_action: 旧动作',
      '  completion_criteria: 旧条件',
      '  updated_at: 2026-07-26T10:00:00.000Z',
    ].join('\n'));
    const process = vi.fn(async (_path: string, update: (current: string) => string) => {
      stored = update(stored);
      return stored;
    });
    const controller = new Controller({
      path: PATH,
      read: async () => stored,
      process,
      appendAudit: async () => undefined,
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const prepared = await controller.prepare();
    stored = stored.replace(
      'updated_at: 2026-07-26T10:00:00.000Z',
      'updated_at: 2026-07-26T11:00:00.000Z',
    );

    await expect(controller.save(prepared.task.taskId, {
      objective: '新目标',
      nextAction: '新动作',
      completionCriteria: '新条件',
    }, '2026-07-26T10:00:00.000Z')).rejects.toMatchObject({
      code: 'task_conflict',
    });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent saves so only one modal can update the same brief version', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW;
    let tail: Promise<void> = Promise.resolve();
    const dependencies = {
      path: PATH,
      read: async () => stored,
      process: (_path: string, update: (current: string) => string) => {
        const operation = tail.then(() => {
          stored = update(stored);
          return stored;
        });
        tail = operation.then(() => undefined, () => undefined);
        return operation;
      },
      appendAudit: async () => undefined,
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    };
    const first = new Controller(dependencies);
    const second = new Controller(dependencies);
    const [{ task: firstTask }, { task: secondTask }] = await Promise.all([
      first.prepare(),
      second.prepare(),
    ]);

    const results = await Promise.allSettled([
      first.save(firstTask.taskId, {
        objective: '第一个目标',
        nextAction: '第一个动作',
        completionCriteria: '第一个条件',
      }, null),
      second.save(secondTask.taskId, {
        objective: '第二个目标',
        nextAction: '第二个动作',
        completionCriteria: '第二个条件',
      }, null),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'task_conflict' }) }),
    ]);
  });

  it('restores the exact Markdown when audit persistence fails', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW;
    const process = vi.fn(async (_path: string, update: (current: string) => string) => {
      stored = update(stored);
      return stored;
    });
    const controller = new Controller({
      path: PATH,
      read: async () => stored,
      process,
      appendAudit: async () => { throw new Error('audit unavailable'); },
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const prepared = await controller.prepare();

    await expect(controller.save(prepared.task.taskId, {
      objective: '明确工具编排的用户交互',
      nextAction: '梳理工具展示与编排流程',
      completionCriteria: '形成可评审的交互方案',
    }, null)).rejects.toMatchObject({ code: 'task_brief_audit_failed' });
    expect(process).toHaveBeenCalledTimes(2);
    expect(stored).toBe(RAW);
  });

  it('does not overwrite a newer user edit when audit rollback is no longer safe', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    let stored = RAW;
    const controller = new Controller({
      path: PATH,
      read: async () => stored,
      process: async (_path, update) => {
        stored = update(stored);
        return stored;
      },
      appendAudit: async () => {
        stored = stored.replace(
          '需要想清楚工具如何友好编排。',
          '用户在保存后补充的新上下文。',
        );
        throw new Error('audit unavailable');
      },
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const prepared = await controller.prepare();

    await expect(controller.save(prepared.task.taskId, {
      objective: '明确工具编排的用户交互',
      nextAction: '梳理工具展示与编排流程',
      completionCriteria: '形成可评审的交互方案',
    }, null)).rejects.toMatchObject({ code: 'task_brief_recovery_error' });
    expect(stored).toContain('用户在保存后补充的新上下文。');
  });

  it('refuses a Markdown note that is not a TaskNotes task', async () => {
    const Controller = (controllerModule as unknown as {
      TaskNotesTaskBriefController: NativeControllerConstructor;
    }).TaskNotesTaskBriefController;
    expect(Controller).toBeTypeOf('function');
    if (Controller === undefined) return;

    const controller = new Controller({
      path: PATH,
      read: async () => RAW.replace('type: task', 'type: note'),
      process: async (_path, update) => update(RAW),
      appendAudit: async () => undefined,
      clock: () => new Date('2026-07-26T12:00:00.000Z'),
    });

    await expect(controller.prepare()).rejects.toMatchObject({
      code: 'task_not_found',
    });
  });
});
