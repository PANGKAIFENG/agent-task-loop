import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
} from '../../../src/domain/transitions.js';
import {
  TASK_STATUSES,
  type TaskStatus,
} from '../../../src/domain/task.js';

const expectedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['ready', 'cancelled'],
  ready: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['review', 'ready', 'blocked', 'cancelled'],
  review: ['done', 'ready', 'blocked', 'cancelled'],
  done: ['ready'],
  blocked: ['ready', 'cancelled'],
  cancelled: [],
};

describe('task transitions', () => {
  it('matches the complete transition matrix', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          expectedTransitions[from].includes(to),
        );
      }
    }
  });

  it('throws the exact error for an invalid transition', () => {
    expect(() => assertTransition('in_progress', 'done')).toThrowError(
      'Invalid task transition: in_progress -> done',
    );
  });
});
