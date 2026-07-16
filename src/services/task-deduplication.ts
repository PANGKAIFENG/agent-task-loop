import type { Task } from '../domain/task.js';

export interface TaskDuplicateInput {
  title: string;
  sourceKey: string;
  sourceNote: string | null;
  sourceQuote: string | null;
}

export interface TaskDuplicateResult {
  existingTaskId: string | null;
  possibleDuplicateIds: string[];
}

function normalizedCharacters(value: string): string[] {
  return [...value.normalize('NFKC').toLowerCase()]
    .filter((character) => /[\p{L}\p{N}]/u.test(character));
}

function normalizedText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizedCharacters(value).join('');
  return normalized === '' ? null : normalized;
}

function characterSet(value: string): Set<string> {
  return new Set(normalizedCharacters(value));
}

function bigrams(value: string): Set<string> | null {
  const characters = normalizedCharacters(value);
  if (characters.length < 4) return null;
  const result = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`);
  }
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function titleEvidenceSimilarity(left: string, right: string): number {
  const leftCharacters = characterSet(left);
  const rightCharacters = characterSet(right);
  if (leftCharacters.size === 0 || rightCharacters.size === 0) return 0;
  return jaccard(leftCharacters, rightCharacters);
}

function titleSoftSimilarity(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams === null || rightBigrams === null) return 0;
  return jaccard(leftBigrams, rightBigrams);
}

function quoteMatches(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizedText(left);
  const normalizedRight = normalizedText(right);
  if (normalizedLeft === null || normalizedRight === null) return false;
  if (
    normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const leftBigrams = bigrams(normalizedLeft);
  const rightBigrams = bigrams(normalizedRight);
  return leftBigrams !== null
    && rightBigrams !== null
    && jaccard(leftBigrams, rightBigrams) >= 0.72;
}

function sameSourceNote(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return left.normalize('NFKC').trim() === right.normalize('NFKC').trim();
}

export function classifyTaskDuplicate(
  input: TaskDuplicateInput,
  tasks: readonly Task[],
): TaskDuplicateResult {
  const sortedTasks = [...tasks].sort((left, right) => (
    left.taskId.localeCompare(right.taskId)
  ));
  const exact = sortedTasks.find((task) => task.sourceKey === input.sourceKey);
  if (exact !== undefined) {
    return { existingTaskId: exact.taskId, possibleDuplicateIds: [] };
  }

  const evidenceMatch = sortedTasks.find((task) => (
    sameSourceNote(input.sourceNote, task.sourceNote)
    && quoteMatches(input.sourceQuote, task.sourceQuote)
    && titleEvidenceSimilarity(input.title, task.title) >= 0.6
  ));
  if (evidenceMatch !== undefined) {
    return { existingTaskId: evidenceMatch.taskId, possibleDuplicateIds: [] };
  }

  const possibleDuplicateIds = sortedTasks
    .filter((task) => titleSoftSimilarity(input.title, task.title) >= 0.8)
    .map((task) => task.taskId);
  return { existingTaskId: null, possibleDuplicateIds };
}
