import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
} from '../../../src/domain/transitions.js';
import {
  TASK_STATUSES,
  type ControlledTaskStatus,
} from '../../../src/domain/task.js';

const expectedTransitions: Record<
  ControlledTaskStatus,
  readonly ControlledTaskStatus[]
> = {
  inbox: ['ready', 'cancelled'],
  ready: ['agent_executable', 'in_progress', 'blocked', 'cancelled'],
  // PAW-GOAL-003 T1 (TECH §3): externally executed tasks are driven from
  // agent_executable into waiting_for_decision or review by external events.
  agent_executable: [
    'in_progress',
    'waiting_for_decision',
    'review',
    'blocked',
    'cancelled',
  ],
  in_progress: [
    'waiting_for_decision',
    'review',
    'ready',
    'agent_executable',
    'blocked',
    'cancelled',
  ],
  waiting_for_decision: ['agent_executable', 'blocked', 'cancelled'],
  review: ['done', 'ready', 'agent_executable', 'blocked', 'cancelled'],
  done: ['ready'],
  // PAW-GOAL-003 T2 (TECH §3.1): recoverable blocked/failed events can be
  // reworked back to agent_executable from a trusted external reply.
  blocked: ['ready', 'agent_executable', 'cancelled'],
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
