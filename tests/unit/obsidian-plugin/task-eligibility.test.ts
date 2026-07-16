import { describe, expect, it } from 'vitest';

import {
  isAtlInboxTaskPath,
  taskIdFromPath,
} from '../../../src/obsidian-plugin/task-eligibility.js';

describe('ATL Inbox task eligibility', () => {
  it.each([
    '10_Tasks/Inbox/2026-07-16/task-20260716-abc12345.md',
    '10_Tasks/Inbox/undated/task-manual.md',
  ])('accepts an ATL Inbox task path: %s', (path) => {
    expect(isAtlInboxTaskPath(path)).toBe(true);
  });

  it.each([
    '10_Tasks/Active/project/task-20260716-abc12345.md',
    '10_Tasks/Inbox/2026-07-16/note.md',
    '10_Tasks/Inbox/../Active/task-unsafe.md',
    '笔记同步助手/2026-07-16/task-example.md',
    '10_Tasks/Inbox/2026-07-16/task-example.txt',
  ])('rejects a non-Inbox task path: %s', (path) => {
    expect(isAtlInboxTaskPath(path)).toBe(false);
  });

  it('extracts the task id from an eligible path only', () => {
    expect(taskIdFromPath(
      '10_Tasks/Inbox/2026-07-16/task-20260716-abc12345.md',
    )).toBe('task-20260716-abc12345');
    expect(taskIdFromPath('10_Tasks/Active/project/task-example.md')).toBeNull();
  });
});
