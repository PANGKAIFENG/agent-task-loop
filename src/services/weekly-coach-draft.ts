import { createHash } from 'node:crypto';

import {
  WEEKLY_COACH_SOURCES,
  type WeeklyCoachSource,
} from './weekly-coach-context.js';
import type {
  WeeklyFocusBackground,
  WeeklyFocusInput,
} from './weekly-focus.js';
import { redactSecrets } from '../security/redact-secrets.js';

export const WEEKLY_COACH_DRAFT_FIELDS = [
  'focus',
  'outcome',
  'whyThisWeek',
  'evidence',
] as const;

export type WeeklyCoachDraftField = typeof WEEKLY_COACH_DRAFT_FIELDS[number];
export type WeeklyCoachDraftFieldSource = 'ai' | 'user';
export type WeeklyCoachDraftReadiness = '仍需确认' | '可确认';
export type WeeklyCoachTranscriptRole = 'assistant' | 'user' | 'system';

export interface WeeklyCoachTranscriptMessage {
  id: string;
  role: WeeklyCoachTranscriptRole;
  text: string;
  question?: string;
  questionReason?: string;
}

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

export interface WeeklyCoachDeferredTaskQuestion {
  id: string;
  relatedItemId: string | null;
  relatedFocus: string;
  question: string;
}

export interface WeeklyCoachDeferredTaskQuestionInput {
  relatedItemId: string | null;
  relatedFocus: string;
  question: string;
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
  deferredTaskQuestions: WeeklyCoachDeferredTaskQuestion[];
  deletedItems: Array<{ id: string; focusKey: string; focusLabel: string }>;
  focusedItemId: string | null;
  noNewFocus: boolean;
  updatedAt: string;
  messages?: WeeklyCoachTranscriptMessage[];
}

export interface WeeklyCoachDraftCollection {
  collectionVersion: 1;
  byWeek: Record<string, WeeklyCoachSessionDraft>;
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
  deferredTaskQuestions: WeeklyCoachDeferredTaskQuestion[];
}

const EMPTY_BACKGROUND: WeeklyFocusBackground = {
  facts: [],
  assumptions: [],
  gaps: [],
  sources: [],
};

const MAX_PERSISTED_WEEKS = 12;
const MAX_FIELD_LENGTH = 4_000;
const MAX_LIST_ITEMS = 30;
const MAX_PERSISTED_MESSAGES = 40;
const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_MESSAGE_TEXT_LENGTH = 4_000;
const MAX_MESSAGE_DETAIL_LENGTH = 1_000;
const MAX_DELETED_FOCUS_LABEL_LENGTH = 240;
const DELETION_FOCUS_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LEGACY_NORMALIZED_SECRET_PATTERN = /(?:(?:apikey|access(?:token)?|auth(?:token)?|appsecret|clientsecret|privatekey|password|passwd|credential|token|secret|bearer).+|^(?:sk[a-z0-9]{8,}|gh[pousr][a-z0-9]{20,}|githubpat[a-z0-9]{20,}|xox[baprs][a-z0-9]{10,}|aiza[a-z0-9]{20,}|akia[a-z0-9]{16}|glpat[a-z0-9]{20,}|npm[a-z0-9]{20,}|whsec[a-z0-9]{20,})$)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedPersistedString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH
    ? value
    : null;
}

function boundedPersistedList(value: unknown, maximum = MAX_LIST_ITEMS): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const normalized = value.map(boundedPersistedString);
  return normalized.every((item): item is string => item !== null) ? normalized : null;
}

function normalizedFocus(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function focusKey(value: string): string {
  const normalized = normalizedFocus(value);
  return normalized === ''
    ? ''
    : `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function normalizedPersistedFocusKey(value: string): string {
  return DELETION_FOCUS_KEY_PATTERN.test(value)
    ? value
    : focusKey(value);
}

function safeFocusLabel(value: string): string {
  const redacted = redactSecrets(value).trim().slice(0, MAX_DELETED_FOCUS_LABEL_LENGTH).trim();
  return redacted === '' ? '已删除重点' : redacted;
}

function safeLegacyFocusLabel(value: string): string {
  return LEGACY_NORMALIZED_SECRET_PATTERN.test(value)
    ? '已删除重点'
    : safeFocusLabel(value);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isoWeeksInYear(year: number): number {
  const januaryFirst = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  return januaryFirst === 4 || (januaryFirst === 3 && isLeapYear(year)) ? 53 : 52;
}

function isIsoWeek(value: string): boolean {
  const match = /^(\d{4})-W(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const week = Number(match[2]);
  return year >= 1 && week >= 1 && week <= isoWeeksInYear(year);
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizePersistedBackground(value: unknown): WeeklyFocusBackground | null {
  if (!isRecord(value)) return null;
  const facts = boundedPersistedList(value.facts);
  const assumptions = boundedPersistedList(value.assumptions);
  const gaps = boundedPersistedList(value.gaps);
  const sources = boundedPersistedList(value.sources);
  return facts !== null && assumptions !== null && gaps !== null && sources !== null
    ? { facts, assumptions, gaps, sources }
    : null;
}

function safeTranscriptString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  return redactSecrets(value).slice(0, maximum);
}

function normalizePersistedMessage(value: unknown): WeeklyCoachTranscriptMessage | null {
  if (!isRecord(value)) return null;
  const id = safeTranscriptString(value.id, MAX_MESSAGE_ID_LENGTH);
  const text = safeTranscriptString(value.text, MAX_MESSAGE_TEXT_LENGTH);
  if (
    id === null
    || id.trim() === ''
    || text === null
    || (value.role !== 'assistant' && value.role !== 'user' && value.role !== 'system')
  ) return null;
  const question = value.question === undefined
    ? undefined
    : safeTranscriptString(value.question, MAX_MESSAGE_DETAIL_LENGTH);
  const questionReason = value.questionReason === undefined
    ? undefined
    : safeTranscriptString(value.questionReason, MAX_MESSAGE_DETAIL_LENGTH);
  if (question === null || questionReason === null) return null;
  return {
    id,
    role: value.role,
    text,
    ...(question === undefined ? {} : { question }),
    ...(questionReason === undefined ? {} : { questionReason }),
  };
}

function normalizePersistedMessages(value: unknown): WeeklyCoachTranscriptMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages = value
    .slice(-MAX_PERSISTED_MESSAGES)
    .map(normalizePersistedMessage)
    .filter((message): message is WeeklyCoachTranscriptMessage => message !== null);
  return messages.length === 0 ? undefined : messages;
}

function normalizePersistedDeferredTaskQuestions(
  value: unknown,
): WeeklyCoachDeferredTaskQuestion[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const questions: WeeklyCoachDeferredTaskQuestion[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const id = boundedPersistedString(candidate.id);
    const relatedFocus = boundedPersistedString(candidate.relatedFocus);
    const question = boundedPersistedString(candidate.question);
    const relatedItemId = candidate.relatedItemId === null
      ? null
      : boundedPersistedString(candidate.relatedItemId);
    if (
      id === null
      || id.trim() === ''
      || relatedFocus === null
      || question === null
      || question.trim() === ''
      || (relatedItemId !== null && relatedItemId.trim() === '')
    ) return null;
    questions.push({
      id,
      relatedItemId: relatedItemId?.trim() || null,
      relatedFocus: safeFocusLabel(relatedFocus),
      question: redactSecrets(question).trim(),
    });
  }
  return questions;
}

function normalizePersistedItem(value: unknown): WeeklyCoachDraftItem | null {
  if (!isRecord(value) || !isRecord(value.fieldSources) || !isRecord(value.suggestions)) {
    return null;
  }
  const rawFieldSources = value.fieldSources;
  const rawSuggestions = value.suggestions;
  const id = boundedPersistedString(value.id);
  const fields = Object.fromEntries(WEEKLY_COACH_DRAFT_FIELDS.map((field) => [
    field,
    boundedPersistedString(value[field]),
  ])) as Record<WeeklyCoachDraftField, string | null>;
  const fieldSources = Object.fromEntries(WEEKLY_COACH_DRAFT_FIELDS.map((field) => [
    field,
    rawFieldSources[field],
  ])) as Record<WeeklyCoachDraftField, unknown>;
  if (
    id === null
    || id.trim() === ''
    || WEEKLY_COACH_DRAFT_FIELDS.some((field) => fields[field] === null)
    || WEEKLY_COACH_DRAFT_FIELDS.some((field) => (
      fieldSources[field] !== 'ai' && fieldSources[field] !== 'user'
    ))
  ) return null;

  const suggestions: Partial<Record<WeeklyCoachDraftField, string>> = {};
  for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
    if (!Object.hasOwn(rawSuggestions, field)) continue;
    const suggestion = boundedPersistedString(rawSuggestions[field]);
    if (suggestion === null) return null;
    suggestions[field] = suggestion;
  }
  const item: WeeklyCoachDraftItem = {
    id,
    focus: fields.focus as string,
    outcome: fields.outcome as string,
    whyThisWeek: fields.whyThisWeek as string,
    evidence: fields.evidence as string,
    fieldSources: fieldSources as Record<WeeklyCoachDraftField, WeeklyCoachDraftFieldSource>,
    suggestions,
    readiness: '仍需确认',
  };
  return setReadiness(item);
}

function normalizePersistedDraft(value: unknown, weekKey: string): WeeklyCoachSessionDraft | null {
  if (!isRecord(value) || value.draftVersion !== 1 || value.week !== weekKey || !isIsoWeek(weekKey)) {
    return null;
  }
  const topic = boundedPersistedString(value.topic);
  const pendingInput = boundedPersistedString(value.pendingInput);
  const sessionSummary = boundedPersistedString(value.sessionSummary);
  const pendingQuestion = boundedPersistedString(value.pendingQuestion);
  const questionReason = boundedPersistedString(value.questionReason);
  const keyAnswers = Array.isArray(value.keyAnswers)
    ? boundedPersistedList(value.keyAnswers.slice(-8), 8)
    : null;
  const background = normalizePersistedBackground(value.background);
  const deferredTaskQuestions = normalizePersistedDeferredTaskQuestions(
    value.deferredTaskQuestions,
  );
  const messages = normalizePersistedMessages(value.messages);
  const updatedAt = normalizedTimestamp(value.updatedAt);
  if (
    topic === null
    || pendingInput === null
    || sessionSummary === null
    || pendingQuestion === null
    || questionReason === null
    || keyAnswers === null
    || background === null
    || deferredTaskQuestions === null
    || updatedAt === null
    || !Array.isArray(value.selectedSources)
    || !Array.isArray(value.items)
    || !Array.isArray(value.deletedItems)
  ) return null;

  const selectedSources = [...new Set(value.selectedSources.filter(
    (source): source is WeeklyCoachSource => WEEKLY_COACH_SOURCES.includes(
      source as WeeklyCoachSource,
    ),
  ))];
  const items = value.items.slice(0, 3).map(normalizePersistedItem);
  if (items.some((item) => item === null)) return null;
  const normalizedItems = items as WeeklyCoachDraftItem[];
  if (new Set(normalizedItems.map((item) => item.id)).size !== normalizedItems.length) return null;

  const deletedItems: Array<{ id: string; focusKey: string; focusLabel: string }> = [];
  for (const candidate of value.deletedItems.slice(0, MAX_LIST_ITEMS)) {
    if (!isRecord(candidate)) return null;
    const id = boundedPersistedString(candidate.id);
    const persistedFocusKey = boundedPersistedString(candidate.focusKey);
    if (id === null || id.trim() === '' || persistedFocusKey === null || persistedFocusKey === '') {
      return null;
    }
    const deletedFocusKey = normalizedPersistedFocusKey(persistedFocusKey);
    const legacyFocusLabel = DELETION_FOCUS_KEY_PATTERN.test(persistedFocusKey)
      ? '已删除重点'
      : safeLegacyFocusLabel(persistedFocusKey);
    const persistedFocusLabel = Object.hasOwn(candidate, 'focusLabel')
      ? boundedPersistedString(candidate.focusLabel)
      : legacyFocusLabel;
    if (deletedFocusKey === '') return null;
    if (persistedFocusLabel === null) return null;
    deletedItems.push({
      id,
      focusKey: deletedFocusKey,
      focusLabel: safeFocusLabel(persistedFocusLabel),
    });
  }

  const focusedItemId = typeof value.focusedItemId === 'string'
    && normalizedItems.some((item) => item.id === value.focusedItemId)
    ? value.focusedItemId
    : null;
  return {
    draftVersion: 1,
    week: weekKey,
    topic,
    selectedSources,
    pendingInput,
    keyAnswers,
    sessionSummary,
    pendingQuestion,
    questionReason,
    background,
    items: normalizedItems,
    deferredTaskQuestions,
    deletedItems,
    focusedItemId,
    noNewFocus: value.noNewFocus === true,
    updatedAt,
    ...(messages === undefined ? {} : { messages }),
  };
}

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
    deferredTaskQuestions: draft.deferredTaskQuestions.map((item) => ({ ...item })),
    deletedItems: draft.deletedItems.map((item) => ({ ...item })),
    ...(draft.messages === undefined
      ? {}
      : { messages: draft.messages.map((message) => ({ ...message })) }),
  };
}

function redactStringList(values: string[]): string[] {
  return values.map(redactSecrets);
}

function redactSessionDraft(draft: WeeklyCoachSessionDraft): WeeklyCoachSessionDraft {
  const next = cloneDraft(draft);
  next.topic = redactSecrets(next.topic);
  next.pendingInput = redactSecrets(next.pendingInput);
  next.keyAnswers = redactStringList(next.keyAnswers);
  next.sessionSummary = redactSecrets(next.sessionSummary);
  next.pendingQuestion = redactSecrets(next.pendingQuestion);
  next.questionReason = redactSecrets(next.questionReason);
  next.background = {
    facts: redactStringList(next.background.facts),
    assumptions: redactStringList(next.background.assumptions),
    gaps: redactStringList(next.background.gaps),
    sources: redactStringList(next.background.sources),
  };
  next.items = next.items.map((item) => {
    const redacted = cloneItem(item);
    for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
      redacted[field] = redactSecrets(redacted[field]);
      const suggestion = redacted.suggestions[field];
      if (suggestion !== undefined) redacted.suggestions[field] = redactSecrets(suggestion);
    }
    return setReadiness(redacted);
  });
  next.deletedItems = next.deletedItems.map((item) => ({
    id: redactSecrets(item.id),
    focusKey: normalizedPersistedFocusKey(item.focusKey),
    focusLabel: safeFocusLabel(item.focusLabel),
  }));
  next.deferredTaskQuestions = next.deferredTaskQuestions.map((item) => ({
    id: redactSecrets(item.id),
    relatedItemId: item.relatedItemId === null ? null : redactSecrets(item.relatedItemId),
    relatedFocus: safeFocusLabel(item.relatedFocus),
    question: redactSecrets(item.question).trim(),
  }));
  next.focusedItemId = next.focusedItemId === null
    ? null
    : redactSecrets(next.focusedItemId);
  if (next.messages !== undefined) {
    next.messages = next.messages.map((message) => ({
      ...message,
      id: redactSecrets(message.id).slice(0, MAX_MESSAGE_ID_LENGTH),
      text: redactSecrets(message.text).slice(0, MAX_MESSAGE_TEXT_LENGTH),
      ...(message.question === undefined
        ? {}
        : { question: redactSecrets(message.question).slice(0, MAX_MESSAGE_DETAIL_LENGTH) }),
      ...(message.questionReason === undefined
        ? {}
        : {
          questionReason: redactSecrets(message.questionReason)
            .slice(0, MAX_MESSAGE_DETAIL_LENGTH),
        }),
    })).slice(-MAX_PERSISTED_MESSAGES);
  }
  return next;
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
    deferredTaskQuestions: [],
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
  next.deferredTaskQuestions = next.deferredTaskQuestions.filter(
    (question) => question.relatedItemId !== itemId,
  );
  const deletedFocusKey = focusKey(item.focus);
  if (
    deletedFocusKey !== ''
    && !next.deletedItems.some((candidate) => candidate.focusKey === deletedFocusKey)
  ) {
    next.deletedItems.push({
      id: item.id,
      focusKey: deletedFocusKey,
      focusLabel: safeFocusLabel(item.focus),
    });
  }
  if (next.focusedItemId === itemId) next.focusedItemId = null;
  return next;
}

const MAX_DEFERRED_PER_FOCUS = 5;
const MAX_UNASSIGNED_DEFERRED = 10;

function normalizedQuestion(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function deferredBucketKey(question: WeeklyCoachDeferredTaskQuestion): string {
  return question.relatedItemId ?? 'unassigned';
}

export function mergeWeeklyCoachDeferredTaskQuestions(
  draft: WeeklyCoachSessionDraft,
  questions: WeeklyCoachDeferredTaskQuestionInput[],
  options: { nextId: () => string },
): WeeklyCoachSessionDraft {
  const next = cloneDraft(draft);
  for (const candidate of questions) {
    const question = redactSecrets(candidate.question).trim();
    if (question === '') continue;
    const relatedItem = candidate.relatedItemId === null
      ? next.items.find((item) => normalizedFocus(item.focus)
        === normalizedFocus(candidate.relatedFocus))
      : next.items.find((item) => item.id === candidate.relatedItemId);
    const relatedItemId = relatedItem?.id ?? null;
    const relatedFocus = relatedItem?.focus.trim()
      || safeFocusLabel(candidate.relatedFocus);
    const bucket = relatedItemId ?? 'unassigned';
    const max = relatedItemId === null ? MAX_UNASSIGNED_DEFERRED : MAX_DEFERRED_PER_FOCUS;
    const bucketItems = next.deferredTaskQuestions.filter(
      (item) => deferredBucketKey(item) === bucket,
    );
    if (bucketItems.length >= max) continue;
    const normalized = normalizedQuestion(question);
    if (bucketItems.some((item) => normalizedQuestion(item.question) === normalized)) continue;
    next.deferredTaskQuestions.push({
      id: options.nextId(),
      relatedItemId,
      relatedFocus,
      question,
    });
  }
  return next;
}

export function editWeeklyCoachDeferredTaskQuestion(
  draft: WeeklyCoachSessionDraft,
  questionId: string,
  value: string,
): WeeklyCoachSessionDraft {
  const question = redactSecrets(value).trim();
  if (question === '') return draft;
  const current = draft.deferredTaskQuestions.find((item) => item.id === questionId);
  if (current === undefined) return draft;
  const next = cloneDraft(draft);
  const bucket = deferredBucketKey(current);
  const normalized = normalizedQuestion(question);
  const duplicate = next.deferredTaskQuestions.some((item) => (
    item.id !== questionId
    && deferredBucketKey(item) === bucket
    && normalizedQuestion(item.question) === normalized
  ));
  next.deferredTaskQuestions = duplicate
    ? next.deferredTaskQuestions.filter((item) => item.id !== questionId)
    : next.deferredTaskQuestions.map((item) => (
      item.id === questionId ? { ...item, question } : item
    ));
  return next;
}

export function removeWeeklyCoachDeferredTaskQuestion(
  draft: WeeklyCoachSessionDraft,
  questionId: string,
): WeeklyCoachSessionDraft {
  if (!draft.deferredTaskQuestions.some((item) => item.id === questionId)) return draft;
  const next = cloneDraft(draft);
  next.deferredTaskQuestions = next.deferredTaskQuestions.filter((item) => item.id !== questionId);
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
        || item.fieldSources[field] === 'user';
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
  baseInput?: WeeklyFocusInput,
): WeeklyFocusInput {
  const safeDraft = redactSessionDraft(draft);
  return {
    conversationTopic: safeDraft.topic,
    selectedSources: [...safeDraft.selectedSources],
    currentQuestion: safeDraft.pendingQuestion,
    coachSummary: safeDraft.sessionSummary,
    focuses: safeDraft.items.map((item) => ({
      focus: item.focus,
      outcome: item.outcome,
      whyThisWeek: item.whyThisWeek,
      evidence: item.evidence,
    })),
    noNewFocus: safeDraft.noNewFocus,
    notDoing: redactStringList(baseInput?.notDoing ?? []),
    background: {
      facts: [...safeDraft.background.facts],
      assumptions: [...safeDraft.background.assumptions],
      gaps: [...safeDraft.background.gaps],
      sources: [...safeDraft.background.sources],
    },
    coachInsights: redactStringList(baseInput?.coachInsights ?? []),
    consideredDirections: redactStringList(baseInput?.consideredDirections ?? []),
    keyAnswers: [...safeDraft.keyAnswers],
    linkedGoals: redactStringList(baseInput?.linkedGoals ?? []),
    linkedTasks: redactStringList(baseInput?.linkedTasks ?? []),
    adjustmentNote: redactSecrets(baseInput?.adjustmentNote ?? ''),
  };
}

export function emptyWeeklyCoachDraftCollection(): WeeklyCoachDraftCollection {
  return { collectionVersion: 1, byWeek: {} };
}

export function normalizeWeeklyCoachDraftCollection(
  value: unknown,
): WeeklyCoachDraftCollection {
  if (!isRecord(value) || value.collectionVersion !== 1 || !isRecord(value.byWeek)) {
    return emptyWeeklyCoachDraftCollection();
  }
  const entries = Object.entries(value.byWeek)
    .filter(([week]) => isIsoWeek(week))
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([week, draft]) => [week, normalizePersistedDraft(draft, week)] as const)
    .filter((entry): entry is readonly [string, WeeklyCoachSessionDraft] => entry[1] !== null)
    .slice(0, MAX_PERSISTED_WEEKS);
  return {
    collectionVersion: 1,
    byWeek: Object.fromEntries(entries),
  };
}

export function getWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  week: string,
): WeeklyCoachSessionDraft | null {
  const draft = collection.byWeek[week];
  return draft === undefined ? null : cloneDraft(draft);
}

export function putWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachDraftCollection {
  const normalizedDraft = normalizePersistedDraft(draft, draft.week);
  if (normalizedDraft === null) {
    throw new Error('草稿包含超出保存限制的内容');
  }
  const safeDraft = redactSessionDraft(normalizedDraft);
  return normalizeWeeklyCoachDraftCollection({
    collectionVersion: 1,
    byWeek: { ...collection.byWeek, [draft.week]: safeDraft },
  });
}

export function removeWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  week: string,
): WeeklyCoachDraftCollection {
  const byWeek = { ...collection.byWeek };
  delete byWeek[week];
  return normalizeWeeklyCoachDraftCollection({ collectionVersion: 1, byWeek });
}
