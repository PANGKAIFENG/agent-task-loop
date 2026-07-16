import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  classifyTaskDuplicate,
  type TaskDuplicateInput,
} from '../../../src/services/task-deduplication.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260717-existing',
    title: '调研实时同步助手待办方案',
    body: '\nSynthetic body.',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: null,
    taskType: null,
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'explicit_wechat_todo',
    sourceDate: '2026-07-17',
    sourceNote: '/vault/笔记同步助手/2026-07-17/同步助手_2026-07-17.md',
    sourceQuote: '我想实时从同步助手获取待办，然后让 AI 在下午先跑掉。',
    sourceKey: 'daily-review:existing',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-07-17T02:00:00.000Z',
    updatedAt: '2026-07-17T02:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<TaskDuplicateInput> = {}): TaskDuplicateInput {
  return {
    title: '调研实时同步助手待办方案',
    sourceKey: 'obsidian-sync:candidate',
    sourceNote: '/vault/笔记同步助手/2026-07-17/同步助手_2026-07-17.md',
    sourceQuote: '我想实时从同步助手获取待办，然后让 AI 在下午先跑掉。',
    ...overrides,
  };
}

describe('classifyTaskDuplicate', () => {
  it('returns the existing task for an exact source key', () => {
    const existing = task({ sourceKey: 'shared:key' });

    expect(classifyTaskDuplicate(input({ sourceKey: 'shared:key' }), [existing]))
      .toEqual({
        existingTaskId: existing.taskId,
        possibleDuplicateIds: [],
      });
  });

  it('hard-matches a daily-review task with the same source evidence', () => {
    const existing = task();

    expect(classifyTaskDuplicate(input({
      title: '实时获取同步助手里的待办方案调研',
      sourceQuote: '我想实时从同步助手获取待办，然后让 AI 在下午先跑掉',
    }), [existing])).toEqual({
      existingTaskId: existing.taskId,
      possibleDuplicateIds: [],
    });
  });

  it('keeps two distinct actions from the same note separate', () => {
    const existing = task();

    expect(classifyTaskDuplicate(input({
      title: '整理第二个独立行动',
      sourceQuote: '另外需要给销售团队整理一份完全不同的培训材料。',
    }), [existing])).toEqual({
      existingTaskId: null,
      possibleDuplicateIds: [],
    });
  });

  it('keeps similar titles from different evidence as soft duplicate hints', () => {
    const existing = task();

    expect(classifyTaskDuplicate(input({
      sourceNote: '/vault/笔记同步助手/2026-07-18/同步助手_2026-07-18.md',
      sourceQuote: '第二天重新提出了一个范围不同的方案。',
    }), [existing])).toEqual({
      existingTaskId: null,
      possibleDuplicateIds: [existing.taskId],
    });
  });
});
