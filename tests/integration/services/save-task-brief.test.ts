import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureTask } from '../../../src/services/capture-task.js';
import {
  InvalidTaskBriefInputError,
  saveTaskBrief,
  TaskBriefAuditFailedError,
} from '../../../src/services/save-task-brief.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../../../src/storage/frontmatter.js';
import {
  TaskConflictError,
  TaskSavedIndexStaleError,
} from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext({
    now: new Date('2026-07-26T08:30:00.000Z'),
  });
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('saveTaskBrief', () => {
  it('persists an independent brief without changing TaskNotes management fields', async () => {
    const { ctx, root } = await makeContext();
    const task = await captureTask(ctx, {
      title: '梳理任务面板字段',
      body: '对照现有字段形成一期建议。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-preserves-management',
      priority: 'high',
    });
    const path = join(
      root,
      '10_Tasks/Inbox/2026-07-26',
      `${task.taskId}.md`,
    );
    const before = parseTaskDocument(await readFile(path, 'utf8'));
    await writeFile(path, serializeTaskDocument({
      ...before.data,
      scheduled: '2026-07-27T14:00:00+08:00',
      due: '2026-07-30',
      projects: ['个人工作台'],
    }, before.body));

    const saved = await saveTaskBrief(ctx, task.taskId, {
      objective: '明确一期任务面板需要保留的核心字段。',
      nextAction: '逐项对照现有字段并给出保留或隐藏建议。',
      completionCriteria: '形成一份可评审的字段清单。',
    }, null);

    expect(saved).toMatchObject({
      status: 'inbox',
      priority: 'high',
      projectId: null,
      taskBrief: {
        schemaVersion: 1,
        objective: '明确一期任务面板需要保留的核心字段。',
        nextAction: '逐项对照现有字段并给出保留或隐藏建议。',
        completionCriteria: '形成一份可评审的字段清单。',
        updatedAt: '2026-07-26T08:30:00.000Z',
      },
    });

    const after = parseTaskDocument(await readFile(path, 'utf8'));
    expect(after.body).toBe(before.body);
    expect(after.data).toMatchObject({
      status: 'inbox',
      priority: 'high',
      project_id: null,
      scheduled: '2026-07-27T14:00:00+08:00',
      due: '2026-07-30',
      projects: ['个人工作台'],
      task_brief: {
        schema_version: 1,
        objective: '明确一期任务面板需要保留的核心字段。',
        next_action: '逐项对照现有字段并给出保留或隐藏建议。',
        completion_criteria: '形成一份可评审的字段清单。',
        updated_at: '2026-07-26T08:30:00.000Z',
      },
    });
    await expect(ctx.audit.count({
      event: 'task.brief_saved',
      localDate: '2026-07-26',
    })).resolves.toBe(1);
  });

  it('reopens the same saved brief and rejects incomplete manual input', async () => {
    const { ctx } = await makeContext();
    const task = await captureTask(ctx, {
      title: '准备用户访谈',
      body: '先明确访谈目的。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-reopen',
      priority: 'normal',
    });

    await saveTaskBrief(ctx, task.taskId, {
      objective: '明确访谈要验证的问题。',
      nextAction: '列出三个核心访谈问题。',
      completionCriteria: '访谈提纲可以直接使用。',
    }, null);

    await expect(ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      taskBrief: {
        objective: '明确访谈要验证的问题。',
        nextAction: '列出三个核心访谈问题。',
        completionCriteria: '访谈提纲可以直接使用。',
      },
    });
    await expect(saveTaskBrief(ctx, task.taskId, {
      objective: ' ',
      nextAction: '列问题',
      completionCriteria: '可使用',
    }, null)).rejects.toBeInstanceOf(InvalidTaskBriefInputError);
  });

  it('rejects a stale task brief draft instead of overwriting a newer brief', async () => {
    const { ctx } = await makeContext();
    const task = await captureTask(ctx, {
      title: '并发完善任务',
      body: '两个窗口不能互相覆盖任务简报。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-version-conflict',
      priority: 'normal',
    });

    await saveTaskBrief(ctx, task.taskId, {
      objective: '保存较新的目标。',
      nextAction: '先完成新窗口的编辑。',
      completionCriteria: '较新的简报已经保存。',
    }, null);

    await expect(saveTaskBrief(ctx, task.taskId, {
      objective: '旧窗口目标。',
      nextAction: '旧窗口下一步。',
      completionCriteria: '旧窗口完成条件。',
    }, null)).rejects.toBeInstanceOf(TaskConflictError);

    await expect(ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      taskBrief: {
        objective: '保存较新的目标。',
      },
    });
  });

  it('restores all task data when the audit append fails', async () => {
    const { ctx, root } = await makeContext();
    const task = await captureTask(ctx, {
      title: '整理访谈结论',
      body: '保留原始任务内容和 TaskNotes 字段。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-audit-rollback',
      priority: 'normal',
    });
    const path = join(
      root,
      '10_Tasks/Inbox/2026-07-26',
      `${task.taskId}.md`,
    );
    const before = parseTaskDocument(await readFile(path, 'utf8'));
    ctx.audit.append = async () => {
      throw new Error('audit unavailable');
    };

    await expect(saveTaskBrief(ctx, task.taskId, {
      objective: '形成可复用的访谈结论。',
      nextAction: '按主题整理访谈原文。',
      completionCriteria: '结论可回溯到原始访谈。',
    }, null)).rejects.toBeInstanceOf(TaskBriefAuditFailedError);

    const after = parseTaskDocument(await readFile(path, 'utf8'));
    expect(after).toEqual(before);
    await expect(ctx.tasks.get(task.taskId)).resolves.not.toHaveProperty(
      'taskBrief',
    );
  });

  it('keeps the saved brief and audit when only the task index is stale', async () => {
    const { ctx, root } = await makeContext();
    const task = await captureTask(ctx, {
      title: '确认下一步行动',
      body: '任务文件应优先于派生索引。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-stale-index',
      priority: 'normal',
    });
    const save = ctx.tasks.save.bind(ctx.tasks);
    ctx.tasks.save = async (candidate) => {
      const saved = await save(candidate);
      if (candidate.taskBrief !== undefined) {
        throw new TaskSavedIndexStaleError();
      }
      return saved;
    };

    await expect(saveTaskBrief(ctx, task.taskId, {
      objective: '明确本任务的下一步行动。',
      nextAction: '整理一个可以立即开始的动作。',
      completionCriteria: '下一步行动清晰且可以执行。',
    }, null)).rejects.toBeInstanceOf(TaskSavedIndexStaleError);

    const path = join(
      root,
      '10_Tasks/Inbox/2026-07-26',
      `${task.taskId}.md`,
    );
    expect(parseTaskDocument(await readFile(path, 'utf8')).data).toMatchObject({
      task_brief: {
        schema_version: 1,
        objective: '明确本任务的下一步行动。',
        next_action: '整理一个可以立即开始的动作。',
        completion_criteria: '下一步行动清晰且可以执行。',
      },
    });
    await expect(ctx.audit.count({
      event: 'task.brief_saved',
      localDate: '2026-07-26',
    })).resolves.toBe(1);
  });

  it('reports audit failure after rollback even when only the rebuilt index is stale', async () => {
    const { ctx, root } = await makeContext();
    const task = await captureTask(ctx, {
      title: '回滚任务简报',
      body: '派生索引失败不代表任务文件回滚失败。',
      origin: 'synthetic_test',
      sourceDate: '2026-07-26',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'synthetic:task-brief-rollback-stale-index',
      priority: 'normal',
    });
    const path = join(
      root,
      '10_Tasks/Inbox/2026-07-26',
      `${task.taskId}.md`,
    );
    const before = parseTaskDocument(await readFile(path, 'utf8'));
    const save = ctx.tasks.save.bind(ctx.tasks);
    ctx.tasks.save = async (candidate) => {
      const result = await save(candidate);
      if (candidate.taskBrief === null) {
        throw new TaskSavedIndexStaleError();
      }
      return result;
    };
    ctx.audit.append = async () => {
      throw new Error('audit unavailable');
    };

    await expect(saveTaskBrief(ctx, task.taskId, {
      objective: '保存后应完整回滚。',
      nextAction: '模拟回滚时索引失败。',
      completionCriteria: '任务文件恢复且错误语义准确。',
    }, null)).rejects.toBeInstanceOf(TaskBriefAuditFailedError);

    expect(parseTaskDocument(await readFile(path, 'utf8'))).toEqual(before);
  });
});
