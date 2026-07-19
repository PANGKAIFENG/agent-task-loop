import { describe, expect, it } from 'vitest';

import {
  createCandidateSelection,
  ignoredCandidateIds,
  selectedCandidateIds,
  setCandidateSelectionSubmitting,
  setIgnoreUnselected,
  toggleCandidate,
} from '../../../src/obsidian-plugin/capture-candidates-state.js';

describe('candidate selection state', () => {
  it('selects all candidates initially in stable display order', () => {
    const state = createCandidateSelection(['a', 'b', 'a', 'c']);

    expect(selectedCandidateIds(state)).toEqual(['a', 'b', 'c']);
    expect(ignoredCandidateIds(state)).toEqual([]);
    expect(state.ignoreUnselected).toBe(false);
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

  it('only resolves unchecked candidates when ignore unselected is explicit', () => {
    const pending = toggleCandidate(createCandidateSelection(['a', 'b', 'c']), 'b');

    expect(ignoredCandidateIds(pending)).toEqual([]);

    const ignoring = setIgnoreUnselected(pending, true);
    expect(ignoredCandidateIds(ignoring)).toEqual(['b']);
    expect(selectedCandidateIds(ignoring)).toEqual(['a', 'c']);
    expect(ignoredCandidateIds(setIgnoreUnselected(ignoring, false))).toEqual([]);
  });
});
