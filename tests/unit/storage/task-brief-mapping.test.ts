import { describe, expect, it } from 'vitest';

import {
  InvalidTaskDataError,
  taskFromDocument,
} from '../../../src/storage/markdown-task-repository.js';

function taskWithBrief(taskBrief: Record<string, unknown>) {
  return taskFromDocument({
    path: '10_Tasks/Inbox/2026-07-26/task-brief-mapping.md',
    data: {
      task_id: 'task-brief-mapping',
      title: 'Task brief mapping',
      status: 'inbox',
      review_state: 'candidate',
      priority: 'normal',
      task_brief: taskBrief,
    },
    body: 'Synthetic task body.',
  });
}

describe('task brief frontmatter mapping', () => {
  it('accepts the canonical snake-case object with an offset timestamp', () => {
    expect(taskWithBrief({
      schema_version: 1,
      objective: 'Clarify the task.',
      next_action: 'Review the current fields.',
      completion_criteria: 'A brief is saved.',
      updated_at: '2026-07-26T16:30:00+08:00',
    }).taskBrief).toEqual({
      schemaVersion: 1,
      objective: 'Clarify the task.',
      nextAction: 'Review the current fields.',
      completionCriteria: 'A brief is saved.',
      updatedAt: '2026-07-26T16:30:00+08:00',
    });
  });

  it.each([
    {},
    { schema_version: 2 },
    { schemaVersion: 2 },
    { schema_version: 1, schemaVersion: 2 },
  ])('rejects a missing, unsupported, or conflicting schema version: %j', (version) => {
    expect(() => taskWithBrief({
      ...version,
      objective: 'Clarify the task.',
      next_action: 'Review the current fields.',
      completion_criteria: 'A brief is saved.',
      updated_at: '2026-07-26T08:30:00.000Z',
    })).toThrowError(InvalidTaskDataError);
  });
});
