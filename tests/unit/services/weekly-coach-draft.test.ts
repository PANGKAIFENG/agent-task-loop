import { describe, expect, it } from 'vitest';

import {
  acceptWeeklyCoachSuggestion,
  createManualWeeklyCoachDraftItem,
  createWeeklyCoachSessionDraft,
  editWeeklyCoachDraftField,
  mergeWeeklyCoachDraftOperations,
  protectRestoredWeeklyCoachDraft,
  removeWeeklyCoachDraftItem,
  validateWeeklyCoachSessionDraft,
  weeklyCoachDraftToFocusInput,
  type WeeklyCoachDraftItem,
  type WeeklyCoachSessionDraft,
} from '../../../src/services/weekly-coach-draft.js';

const UPDATED_AT = '2026-08-03T09:00:00.000Z';

function completeItem(
  id: string,
  focus = '发布插件',
  source: 'ai' | 'user' = 'ai',
): WeeklyCoachDraftItem {
  return {
    id,
    focus,
    outcome: '用户可以完成安装',
    whyThisWeek: '核心交互已经具备',
    evidence: '两位用户独立安装成功',
    fieldSources: {
      focus: source,
      outcome: source,
      whyThisWeek: source,
      evidence: source,
    },
    suggestions: {},
    readiness: '可确认',
  };
}

function draftWith(...items: WeeklyCoachDraftItem[]): WeeklyCoachSessionDraft {
  return {
    ...createWeeklyCoachSessionDraft('2026-W32', UPDATED_AT),
    items,
  };
}

describe('weekly coach session draft', () => {
  it('creates a bounded empty session and a manual item with stable ownership', () => {
    expect(createWeeklyCoachSessionDraft('2026-W32', UPDATED_AT)).toEqual({
      draftVersion: 1,
      week: '2026-W32',
      topic: '',
      selectedSources: [],
      pendingInput: '',
      keyAnswers: [],
      sessionSummary: '',
      pendingQuestion: '',
      questionReason: '',
      background: { facts: [], assumptions: [], gaps: [], sources: [] },
      items: [],
      deletedItems: [],
      focusedItemId: null,
      noNewFocus: false,
      updatedAt: UPDATED_AT,
    });
    expect(createManualWeeklyCoachDraftItem('focus-1')).toEqual({
      id: 'focus-1',
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
    });
  });

  it('protects non-empty user fields and exposes a conflicting AI value as a suggestion', () => {
    const first = createManualWeeklyCoachDraftItem('focus-1');
    const original = draftWith({
      ...first,
      focus: '发布插件',
      fieldSources: {
        ...first.fieldSources,
        outcome: 'ai',
        whyThisWeek: 'ai',
        evidence: 'ai',
      },
    });

    const result = mergeWeeklyCoachDraftOperations(original, [{
      action: 'update',
      itemId: 'focus-1',
      fields: { focus: '重写插件', outcome: '用户可完成安装' },
    }], { nextId: () => 'focus-2', focusedItemId: null });

    expect(result.draft.items[0]).toMatchObject({
      focus: '发布插件',
      outcome: '用户可完成安装',
      suggestions: { focus: '重写插件' },
      fieldSources: { focus: 'user', outcome: 'ai' },
    });
    expect(result.conflicts).toEqual([{
      itemId: 'focus-1',
      field: 'focus',
      suggestion: '重写插件',
    }]);
    expect(original.items[0]?.outcome).toBe('');
  });

  it('locks direct edits and only adopts an AI replacement after explicit acceptance', () => {
    let draft = draftWith(completeItem('focus-1'));
    draft = editWeeklyCoachDraftField(draft, 'focus-1', 'outcome', '我定义的结果');
    const suggested = mergeWeeklyCoachDraftOperations(draft, [{
      action: 'suggest_replace',
      itemId: 'focus-1',
      fields: { outcome: 'AI 建议的结果' },
    }], { nextId: () => 'focus-2', focusedItemId: null }).draft;

    expect(suggested.items[0]).toMatchObject({
      outcome: '我定义的结果',
      suggestions: { outcome: 'AI 建议的结果' },
      fieldSources: { outcome: 'user' },
    });

    const accepted = acceptWeeklyCoachSuggestion(suggested, 'focus-1', 'outcome');
    expect(accepted.items[0]).toMatchObject({
      outcome: 'AI 建议的结果',
      suggestions: {},
      fieldSources: { outcome: 'user' },
    });
  });

  it('ignores operations for other items while one item is focused', () => {
    const original = draftWith(completeItem('focus-1'), completeItem('focus-2', '整理复盘'));
    const merged = mergeWeeklyCoachDraftOperations(original, [{
      action: 'update',
      itemId: 'focus-2',
      fields: { outcome: '不应变化' },
    }, {
      action: 'update',
      itemId: 'focus-1',
      fields: { evidence: '新的完成证据' },
    }], { nextId: () => 'focus-3', focusedItemId: 'focus-1' }).draft;

    expect(merged.items[1]).toEqual(original.items[1]);
    expect(merged.items[0]?.evidence).toBe('新的完成证据');
  });

  it('records deletion tombstones and blocks equivalent AI recreation', () => {
    const original = draftWith(completeItem('focus-1', '发布插件！'));
    const removed = removeWeeklyCoachDraftItem(original, 'focus-1');
    const recreated = mergeWeeklyCoachDraftOperations(removed, [{
      action: 'create',
      itemId: null,
      fields: { focus: ' 发布 插件 ' },
    }], { nextId: () => 'focus-2', focusedItemId: null }).draft;

    expect(removed.deletedItems).toEqual([{ id: 'focus-1', focusKey: '发布插件' }]);
    expect(recreated.items).toHaveLength(0);
  });

  it('caps AI-created items at three and rejects creations without a focus', () => {
    const original = draftWith(
      completeItem('focus-1'),
      completeItem('focus-2', '整理复盘'),
    );
    let id = 2;
    const merged = mergeWeeklyCoachDraftOperations(original, [{
      action: 'create', itemId: null, fields: { focus: '梳理目标' },
    }, {
      action: 'create', itemId: null, fields: { focus: '第四项' },
    }, {
      action: 'create', itemId: null, fields: { outcome: '没有重点' },
    }], { nextId: () => `focus-${++id}`, focusedItemId: null }).draft;

    expect(merged.items.map((item) => item.focus)).toEqual([
      '发布插件',
      '整理复盘',
      '梳理目标',
    ]);
  });

  it('protects every restored non-empty field as user-owned', () => {
    const restored = protectRestoredWeeklyCoachDraft(draftWith({
      ...createManualWeeklyCoachDraftItem('focus-1'),
      focus: '发布插件',
      outcome: '用户可安装',
      fieldSources: {
        focus: 'ai', outcome: 'ai', whyThisWeek: 'ai', evidence: 'ai',
      },
    }));

    expect(restored.items[0]?.fieldSources).toEqual({
      focus: 'user', outcome: 'user', whyThisWeek: 'ai', evidence: 'ai',
    });
  });

  it('requires either one complete item or an explicit no-new-focus decision', () => {
    const base = createWeeklyCoachSessionDraft('2026-W32', UPDATED_AT);
    expect(validateWeeklyCoachSessionDraft(base)).toEqual([{
      itemId: null,
      field: 'noNewFocus',
      message: '请至少保留一项重点，或明确选择本周暂不新增重点',
    }]);
    expect(validateWeeklyCoachSessionDraft({ ...base, noNewFocus: true })).toEqual([]);

    const partial = draftWith({
      ...createManualWeeklyCoachDraftItem('focus-1'),
      focus: '发布插件',
    });
    expect(validateWeeklyCoachSessionDraft(partial)).toEqual([
      { itemId: 'focus-1', field: 'outcome', message: '请补充预期结果' },
      { itemId: 'focus-1', field: 'whyThisWeek', message: '请补充为什么是本周' },
      { itemId: 'focus-1', field: 'evidence', message: '请补充完成证据' },
    ]);
  });

  it('converts only the formal fields and session summary into a weekly focus input', () => {
    const source = {
      ...draftWith(completeItem('focus-1')),
      topic: '判断本周是否发布插件',
      selectedSources: ['目标', '项目', '任务'] as WeeklyCoachSessionDraft['selectedSources'],
      keyAnswers: ['希望用户不打开终端。'],
      sessionSummary: '已明确安装体验的价值。',
      pendingQuestion: '谁来完成独立安装？',
      background: {
        facts: ['核心交互已经完成。'],
        assumptions: ['用户愿意安装插件。'],
        gaps: ['缺少独立安装人。'],
        sources: ['02_Projects/ATL.md'],
      },
    };

    expect(weeklyCoachDraftToFocusInput(source)).toMatchObject({
      conversationTopic: '判断本周是否发布插件',
      selectedSources: ['目标', '项目', '任务'],
      currentQuestion: '谁来完成独立安装？',
      coachSummary: '已明确安装体验的价值。',
      focuses: [{
        focus: '发布插件',
        outcome: '用户可以完成安装',
        whyThisWeek: '核心交互已经具备',
        evidence: '两位用户独立安装成功',
      }],
      keyAnswers: ['希望用户不打开终端。'],
      noNewFocus: false,
    });
  });
});
