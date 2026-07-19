export interface CandidateSelectionState {
  candidateIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  ignoreUnselected: boolean;
  submitting: boolean;
}

export function createCandidateSelection(
  candidateIds: readonly string[],
): CandidateSelectionState {
  const uniqueIds = [...new Set(candidateIds)];
  return {
    candidateIds: uniqueIds,
    selectedIds: new Set(uniqueIds),
    ignoreUnselected: false,
    submitting: false,
  };
}

export function toggleCandidate(
  state: CandidateSelectionState,
  candidateId: string,
): CandidateSelectionState {
  if (!state.candidateIds.includes(candidateId)) return state;
  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(candidateId)) selectedIds.delete(candidateId);
  else selectedIds.add(candidateId);
  return { ...state, selectedIds };
}

export function selectedCandidateIds(
  state: CandidateSelectionState,
): string[] {
  return state.candidateIds.filter((id) => state.selectedIds.has(id));
}

export function ignoredCandidateIds(
  state: CandidateSelectionState,
): string[] {
  return state.ignoreUnselected
    ? state.candidateIds.filter((id) => !state.selectedIds.has(id))
    : [];
}

export function setIgnoreUnselected(
  state: CandidateSelectionState,
  ignoreUnselected: boolean,
): CandidateSelectionState {
  return { ...state, ignoreUnselected };
}

export function setCandidateSelectionSubmitting(
  state: CandidateSelectionState,
  submitting: boolean,
): CandidateSelectionState {
  return { ...state, submitting };
}
