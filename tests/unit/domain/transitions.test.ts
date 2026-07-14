import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
} from '../../../src/domain/transitions.js';

describe('task transitions', () => {
  it('allows the required lifecycle transitions', () => {
    expect(canTransition('inbox', 'ready')).toBe(true);
    expect(canTransition('ready', 'in_progress')).toBe(true);
    expect(canTransition('review', 'done')).toBe(true);
    expect(canTransition('review', 'ready')).toBe(true);
    expect(canTransition('done', 'ready')).toBe(true);
  });

  it('rejects lifecycle shortcuts', () => {
    expect(canTransition('in_progress', 'done')).toBe(false);
    expect(canTransition('inbox', 'in_progress')).toBe(false);
  });

  it('throws the exact error for an invalid transition', () => {
    expect(() => assertTransition('in_progress', 'done')).toThrowError(
      'Invalid task transition: in_progress -> done',
    );
  });
});
