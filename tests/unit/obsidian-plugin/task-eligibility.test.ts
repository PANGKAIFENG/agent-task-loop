import { describe, expect, it } from 'vitest';

import {
  isAtlInboxTaskPath,
  isAtlTaskPath,
  taskIdFromMetadata,
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
    expect(taskIdFromPath('10_Tasks/Active/project/task-example.md')).toBe(
      'task-example',
    );
  });

  it('uses the frontmatter task id when the filename also contains a title slug', () => {
    const path = '10_Tasks/Inbox/2026-07-13/task-20260713-\u8865\u5145\u7528\u6237\u573a\u666f-ee28f992.md';

    expect(taskIdFromMetadata(path, { task_id: 'task-20260713-ee28f992' }))
      .toBe('task-20260713-ee28f992');
    expect(taskIdFromMetadata('\u7b14\u8bb0\u540c\u6b65\u52a9\u624b/task-note.md', { task_id: 'task-note' }))
      .toBeNull();
  });

  it('falls back to task_id in Markdown frontmatter when the metadata cache is cold', () => {
    const path = '10_Tasks/Inbox/2026-07-13/task-20260713-title-ee28f992.md';
    const markdown = [
      '---',
      'task_id: task-20260713-ee28f992',
      'title: Example task',
      '---',
      '',
      '# Example task',
    ].join('\n');

    expect(taskIdFromMetadata(path, markdown as never))
      .toBe('task-20260713-ee28f992');
  });

  it.each([
    '10_Tasks/Inbox/2026-07-16/task-inbox.md',
    '10_Tasks/Active/unassigned/task-ready.md',
    '10_Tasks/Active/product/task-progress.md',
    '10_Tasks/Archive/2026/task-done.md',
  ])('accepts an ATL task in any lifecycle folder: %s', (path) => {
    expect(isAtlTaskPath(path)).toBe(true);
  });

  it.each([
    '10_Tasks/Projects/task-project.md',
    '10_Tasks/Artifacts/task-example/report.md',
    '10_Tasks/Active/../Archive/task-unsafe.md',
    '10_Tasks/Active/project/note.md',
  ])('rejects a non-task lifecycle path: %s', (path) => {
    expect(isAtlTaskPath(path)).toBe(false);
  });
});
