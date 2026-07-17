import { describe, expect, it } from 'vitest';

import {
  createCandidateSelection,
  selectedCandidateIds,
  setCandidateSelectionSubmitting,
  toggleCandidate,
} from '../../../src/obsidian-plugin/capture-candidates-state.js';

describe('candidate selection state', () => {
  it('selects all candidates initially in stable display order', () => {
    const state = createCandidateSelection(['a', 'b', 'a', 'c']);

    expect(selectedCandidateIds(state)).toEqual(['a', 'b', 'c']);
    expect(state.submitting).toBe(false);
  });

  it('toggles a known candidate without changing the original state', () => {
    const original = createCandidateSelection(['a', 'b']);
    const toggled = toggleCandidate(original, 'b');

    expect(selectedCandidateIds(toggled)).toEqual(['a']);
    expect(selectedCandidateIds(original)).toEqual(['a', 'b']);
    expect(selectedCandidateIds(toggleCandidate(toggled, 'b'))).toEqual(['a', 'b']);
  });

  it('supports an empty selection and ignores unknown IDs', () => {
    const state = toggleCandidate(
      toggleCandidate(createCandidateSelection(['a', 'b']), 'a'),
      'b',
    );

    expect(selectedCandidateIds(state)).toEqual([]);
    expect(toggleCandidate(state, 'unknown')).toBe(state);
  });

  it('tracks submitting without changing the selection', () => {
    const state = createCandidateSelection(['a', 'b']);
    const submitting = setCandidateSelectionSubmitting(state, true);

    expect(submitting.submitting).toBe(true);
    expect(selectedCandidateIds(submitting)).toEqual(['a', 'b']);
  });
});
