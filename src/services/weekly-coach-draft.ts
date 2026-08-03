import type { WeeklyCoachSource } from './weekly-coach-context.js';
import type {
  WeeklyFocusBackground,
  WeeklyFocusInput,
} from './weekly-focus.js';

export const WEEKLY_COACH_DRAFT_FIELDS = [
  'focus',
  'outcome',
  'whyThisWeek',
  'evidence',
] as const;

export type WeeklyCoachDraftField = typeof WEEKLY_COACH_DRAFT_FIELDS[number];
export type WeeklyCoachDraftFieldSource = 'ai' | 'user';
export type WeeklyCoachDraftReadiness = '仍需确认' | '可确认';

export interface WeeklyCoachDraftItem {
  id: string;
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
  fieldSources: Record<WeeklyCoachDraftField, WeeklyCoachDraftFieldSource>;
  suggestions: Partial<Record<WeeklyCoachDraftField, string>>;
  readiness: WeeklyCoachDraftReadiness;
}

export interface WeeklyCoachSessionDraft {
  draftVersion: 1;
  week: string;
  topic: string;
  selectedSources: WeeklyCoachSource[];
  pendingInput: string;
  keyAnswers: string[];
  sessionSummary: string;
  pendingQuestion: string;
  questionReason: string;
  background: WeeklyFocusBackground;
  items: WeeklyCoachDraftItem[];
  deletedItems: Array<{ id: string; focusKey: string }>;
  focusedItemId: string | null;
  noNewFocus: boolean;
  updatedAt: string;
}

export interface WeeklyCoachDraftValidationIssue {
  itemId: string | null;
  field: WeeklyCoachDraftField | 'noNewFocus';
  message: string;
}

export type WeeklyCoachDraftOperation =
  | {
    action: 'create';
    itemId: null;
    fields: Partial<Record<WeeklyCoachDraftField, string>>;
  }
  | {
    action: 'update' | 'suggest_replace';
    itemId: string;
    fields: Partial<Record<WeeklyCoachDraftField, string>>;
  };

export interface WeeklyThinkingCoachTurn {
  topic: string;
  selectedSources: WeeklyCoachSource[];
  latestAnswer: string;
  keyAnswers: string[];
  previousSummary: string | null;
  draftItems: WeeklyCoachDraftItem[];
  deletedFocuses: string[];
  focusedItemId: string | null;
}

const EMPTY_BACKGROUND: WeeklyFocusBackground = {
  facts: [],
  assumptions: [],
  gaps: [],
  sources: [],
};

function itemReadiness(item: WeeklyCoachDraftItem): WeeklyCoachDraftReadiness {
  return WEEKLY_COACH_DRAFT_FIELDS.every((field) => item[field].trim() !== '')
    ? '可确认'
    : '仍需确认';
}

function cloneItem(item: WeeklyCoachDraftItem): WeeklyCoachDraftItem {
  return {
    ...item,
    fieldSources: { ...item.fieldSources },
    suggestions: { ...item.suggestions },
  };
}

function cloneDraft(draft: WeeklyCoachSessionDraft): WeeklyCoachSessionDraft {
  return {
    ...draft,
    selectedSources: [...draft.selectedSources],
    keyAnswers: [...draft.keyAnswers],
    background: {
      facts: [...draft.background.facts],
      assumptions: [...draft.background.assumptions],
      gaps: [...draft.background.gaps],
      sources: [...draft.background.sources],
    },
    items: draft.items.map(cloneItem),
    deletedItems: draft.deletedItems.map((item) => ({ ...item })),
  };
}

function focusKey(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function setReadiness(item: WeeklyCoachDraftItem): WeeklyCoachDraftItem {
  return { ...item, readiness: itemReadiness(item) };
}

export function createWeeklyCoachSessionDraft(
  week: string,
  updatedAt: string,
): WeeklyCoachSessionDraft {
  return {
    draftVersion: 1,
    week,
    topic: '',
    selectedSources: [],
    pendingInput: '',
    keyAnswers: [],
    sessionSummary: '',
    pendingQuestion: '',
    questionReason: '',
    background: { ...EMPTY_BACKGROUND },
    items: [],
    deletedItems: [],
    focusedItemId: null,
    noNewFocus: false,
    updatedAt,
  };
}

export function createManualWeeklyCoachDraftItem(id: string): WeeklyCoachDraftItem {
  return {
    id,
    focus: '',
    outcome: '',
    whyThisWeek: '',
    evidence: '',
    fieldSources: {
      focus: 'user',
      outcome: 'user',
      whyThisWeek: 'user',
      evidence: 'user',
    },
    suggestions: {},
    readiness: '仍需确认',
  };
}

export function editWeeklyCoachDraftField(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
  field: WeeklyCoachDraftField,
  value: string,
): WeeklyCoachSessionDraft {
  const next = cloneDraft(draft);
  const item = next.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) return draft;
  item[field] = value;
  item.fieldSources[field] = 'user';
  delete item.suggestions[field];
  item.readiness = itemReadiness(item);
  return next;
}

export function acceptWeeklyCoachSuggestion(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
  field: WeeklyCoachDraftField,
): WeeklyCoachSessionDraft {
  const next = cloneDraft(draft);
  const item = next.items.find((candidate) => candidate.id === itemId);
  const suggestion = item?.suggestions[field];
  if (item === undefined || suggestion === undefined) return draft;
  item[field] = suggestion;
  item.fieldSources[field] = 'user';
  delete item.suggestions[field];
  item.readiness = itemReadiness(item);
  return next;
}

export function removeWeeklyCoachDraftItem(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
): WeeklyCoachSessionDraft {
  const item = draft.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) return draft;
  const next = cloneDraft(draft);
  next.items = next.items.filter((candidate) => candidate.id !== itemId);
  const deletedFocusKey = focusKey(item.focus);
  if (
    deletedFocusKey !== ''
    && !next.deletedItems.some((candidate) => candidate.focusKey === deletedFocusKey)
  ) {
    next.deletedItems.push({ id: item.id, focusKey: deletedFocusKey });
  }
  if (next.focusedItemId === itemId) next.focusedItemId = null;
  return next;
}

export function protectRestoredWeeklyCoachDraft(
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachSessionDraft {
  const next = cloneDraft(draft);
  next.items = next.items.map((item) => {
    const protectedItem = cloneItem(item);
    for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
      if (protectedItem[field].trim() !== '') protectedItem.fieldSources[field] = 'user';
    }
    return setReadiness(protectedItem);
  });
  return next;
}

export function mergeWeeklyCoachDraftOperations(
  draft: WeeklyCoachSessionDraft,
  operations: WeeklyCoachDraftOperation[],
  options: { nextId: () => string; focusedItemId: string | null },
): {
  draft: WeeklyCoachSessionDraft;
  conflicts: Array<{
    itemId: string;
    field: WeeklyCoachDraftField;
    suggestion: string;
  }>;
} {
  const next = cloneDraft(draft);
  const conflicts: Array<{
    itemId: string;
    field: WeeklyCoachDraftField;
    suggestion: string;
  }> = [];

  for (const operation of operations) {
    if (options.focusedItemId !== null) {
      if (operation.action === 'create' || operation.itemId !== options.focusedItemId) continue;
    }
    if (operation.action === 'create') {
      if (next.items.length >= 3) continue;
      const proposedFocus = operation.fields.focus?.trim() ?? '';
      if (proposedFocus === '') continue;
      const proposedKey = focusKey(proposedFocus);
      if (next.deletedItems.some((item) => item.focusKey === proposedKey)) continue;
      const item: WeeklyCoachDraftItem = {
        id: options.nextId(),
        focus: '',
        outcome: '',
        whyThisWeek: '',
        evidence: '',
        fieldSources: {
          focus: 'ai',
          outcome: 'ai',
          whyThisWeek: 'ai',
          evidence: 'ai',
        },
        suggestions: {},
        readiness: '仍需确认',
      };
      for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
        const value = operation.fields[field]?.trim();
        if (value !== undefined && value !== '') item[field] = value;
      }
      next.items.push(setReadiness(item));
      next.noNewFocus = false;
      continue;
    }

    const item = next.items.find((candidate) => candidate.id === operation.itemId);
    if (item === undefined) continue;
    for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
      const value = operation.fields[field]?.trim();
      if (value === undefined || value === '' || value === item[field]) continue;
      const mustSuggest = operation.action === 'suggest_replace'
        || (item.fieldSources[field] === 'user' && item[field].trim() !== '');
      if (mustSuggest) {
        item.suggestions[field] = value;
        conflicts.push({ itemId: item.id, field, suggestion: value });
      } else {
        item[field] = value;
        item.fieldSources[field] = 'ai';
        delete item.suggestions[field];
      }
    }
    item.readiness = itemReadiness(item);
  }

  return { draft: next, conflicts };
}

const VALIDATION_LABELS: Record<WeeklyCoachDraftField, string> = {
  focus: '重点事项',
  outcome: '预期结果',
  whyThisWeek: '为什么是本周',
  evidence: '完成证据',
};

export function validateWeeklyCoachSessionDraft(
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachDraftValidationIssue[] {
  if (draft.items.length === 0) {
    return draft.noNewFocus
      ? []
      : [{
        itemId: null,
        field: 'noNewFocus',
        message: '请至少保留一项重点，或明确选择本周暂不新增重点',
      }];
  }
  const issues: WeeklyCoachDraftValidationIssue[] = [];
  for (const item of draft.items) {
    for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
      if (item[field].trim() === '') {
        issues.push({
          itemId: item.id,
          field,
          message: `请补充${VALIDATION_LABELS[field]}`,
        });
      }
    }
  }
  return issues;
}

export function weeklyCoachDraftToFocusInput(
  draft: WeeklyCoachSessionDraft,
): WeeklyFocusInput {
  return {
    conversationTopic: draft.topic,
    selectedSources: [...draft.selectedSources],
    currentQuestion: draft.pendingQuestion,
    coachSummary: draft.sessionSummary,
    focuses: draft.items.map((item) => ({
      focus: item.focus,
      outcome: item.outcome,
      whyThisWeek: item.whyThisWeek,
      evidence: item.evidence,
    })),
    noNewFocus: draft.noNewFocus,
    notDoing: [],
    background: {
      facts: [...draft.background.facts],
      assumptions: [...draft.background.assumptions],
      gaps: [...draft.background.gaps],
      sources: [...draft.background.sources],
    },
    coachInsights: [],
    consideredDirections: [],
    keyAnswers: [...draft.keyAnswers],
    linkedGoals: [],
    linkedTasks: [],
    adjustmentNote: '',
  };
}
