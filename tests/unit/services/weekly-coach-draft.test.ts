import { describe, expect, it } from 'vitest';

import {
  acceptWeeklyCoachSuggestion,
  createManualWeeklyCoachDraftItem,
  createWeeklyCoachSessionDraft,
  editWeeklyCoachDraftField,
  emptyWeeklyCoachDraftCollection,
  getWeeklyCoachSessionDraft,
  mergeWeeklyCoachDraftOperations,
  normalizeWeeklyCoachDraftCollection,
  protectRestoredWeeklyCoachDraft,
  putWeeklyCoachSessionDraft,
  removeWeeklyCoachDraftItem,
  removeWeeklyCoachSessionDraft,
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

function persistedDraft(
  week = '2026-W32',
  updatedAt = UPDATED_AT,
): WeeklyCoachSessionDraft {
  return {
    ...draftWith(completeItem('focus-1')),
    week,
    topic: '判断本周是否应该发布插件',
    selectedSources: ['目标', '项目', '任务'],
    keyAnswers: ['希望用户不使用终端也能完成安装。'],
    sessionSummary: '已确认一个候选方向。',
    pendingQuestion: '什么证据能证明安装体验已经成立？',
    questionReason: '需要补齐完成证据。',
    updatedAt,
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

  it('keeps a user-cleared field locked when AI proposes a replacement', () => {
    const cleared = editWeeklyCoachDraftField(
      draftWith(completeItem('focus-1')),
      'focus-1',
      'outcome',
      '',
    );

    const result = mergeWeeklyCoachDraftOperations(cleared, [{
      action: 'update',
      itemId: 'focus-1',
      fields: { outcome: 'AI 重新补充的结果' },
    }], { nextId: () => 'focus-2', focusedItemId: null });

    expect(result.draft.items[0]).toMatchObject({
      outcome: '',
      suggestions: { outcome: 'AI 重新补充的结果' },
      fieldSources: { outcome: 'user' },
    });
    expect(result.conflicts).toEqual([{
      itemId: 'focus-1',
      field: 'outcome',
      suggestion: 'AI 重新补充的结果',
    }]);
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

  it('records opaque deletion tombstones and blocks equivalent AI recreation', () => {
    const original = draftWith(completeItem('focus-1', '发布插件！'));
    const removed = removeWeeklyCoachDraftItem(original, 'focus-1');
    const recreated = mergeWeeklyCoachDraftOperations(removed, [{
      action: 'create',
      itemId: null,
      fields: { focus: ' 发布 插件 ' },
    }], { nextId: () => 'focus-2', focusedItemId: null }).draft;

    expect(removed.deletedItems).toHaveLength(1);
    expect(removed.deletedItems[0]?.id).toBe('focus-1');
    expect(removed.deletedItems[0]?.focusKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(removed.deletedItems[0]?.focusKey).not.toContain('发布插件');
    expect(recreated.items).toHaveLength(0);
  });

  it('does not persist credential content in deletion tombstones', () => {
    const original = draftWith(completeItem(
      'focus-1',
      'api_key=weekly-coach-private-value',
    ));

    const removed = removeWeeklyCoachDraftItem(original, 'focus-1');
    const serialized = JSON.stringify(removed.deletedItems);

    expect(serialized).not.toContain('weekly-coach-private-value');
    expect(serialized).not.toContain('apikeyweeklycoachprivatevalue');
    expect(removed.deletedItems[0]?.focusKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
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

  it('redacts credentials before formal Markdown conversion', () => {
    const secrets = [
      'sk-abcdefghijklmnop',
      'Bearer abc.def.ghi-jkl',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'password=weekly-coach-private-value',
    ];
    const sensitive = {
      ...persistedDraft(),
      topic: secrets[0]!,
      pendingQuestion: secrets[1]!,
      sessionSummary: secrets[2]!,
      keyAnswers: [secrets[3]!],
      items: [{
        ...completeItem('focus-1'),
        focus: secrets[0]!,
        outcome: secrets[1]!,
        whyThisWeek: secrets[2]!,
        evidence: secrets[3]!,
      }],
      background: {
        facts: [secrets[0]!],
        assumptions: [secrets[1]!],
        gaps: [secrets[2]!],
        sources: [secrets[3]!],
      },
    };

    const serialized = JSON.stringify(weeklyCoachDraftToFocusInput(sensitive));
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('stores, reads, and removes session drafts without mutating prior collections', () => {
    const empty = emptyWeeklyCoachDraftCollection();
    const draft = persistedDraft();
    const stored = putWeeklyCoachSessionDraft(empty, draft);

    expect(empty.byWeek).toEqual({});
    expect(getWeeklyCoachSessionDraft(stored, '2026-W32')).toEqual(draft);
    expect(getWeeklyCoachSessionDraft(stored, '2026-W31')).toBeNull();

    const removed = removeWeeklyCoachSessionDraft(stored, '2026-W32');
    expect(removed.byWeek).toEqual({});
    expect(stored.byWeek['2026-W32']).toEqual(draft);
  });

  it('rejects an oversized draft without dropping the previously saved week', () => {
    const previous = persistedDraft();
    const collection = putWeeklyCoachSessionDraft(emptyWeeklyCoachDraftCollection(), previous);
    const oversized = { ...previous, topic: 'x'.repeat(4_001) };

    expect(() => putWeeklyCoachSessionDraft(collection, oversized)).toThrow(
      '草稿包含超出保存限制的内容',
    );
    expect(collection.byWeek['2026-W32']).toEqual(previous);
  });

  it('redacts credentials before persisting the plugin session draft', () => {
    const secrets = [
      'sk-abcdefghijklmnop',
      'Bearer abc.def.ghi-jkl',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'api_key=weekly-coach-private-value',
    ];
    const sensitive = {
      ...persistedDraft(),
      topic: secrets[0]!,
      pendingInput: secrets[1]!,
      keyAnswers: [secrets[2]!],
      sessionSummary: secrets[3]!,
      items: [{
        ...completeItem('focus-1'),
        focus: secrets[0]!,
        outcome: secrets[1]!,
        suggestions: { evidence: secrets[2]! },
      }],
    };

    const collection = putWeeklyCoachSessionDraft(
      emptyWeeklyCoachDraftCollection(),
      sensitive,
    );
    const serialized = JSON.stringify(collection);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('normalizes only the latest twelve bounded session drafts', () => {
    const oversized = 'x'.repeat(4_001);
    const byWeek: Record<string, unknown> = Object.fromEntries(Array.from(
      { length: 14 }, (_, index) => {
      const week = `2026-W${String(index + 1).padStart(2, '0')}`;
      const draft = persistedDraft(
        week,
        `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
      );
      return [week, {
        ...draft,
        keyAnswers: [...draft.keyAnswers, ...Array.from({ length: 10 }, () => '保留回答')],
        items: [
          ...draft.items,
          completeItem('focus-2', '整理复盘'),
          completeItem('focus-3', '梳理目标'),
          completeItem('focus-4', '不应保留'),
        ],
        messages: [{ role: 'user', text: '不得持久化' }],
        sourceDocuments: [{ path: 'private.md', content: '不得持久化' }],
        unknown: '不得持久化',
      }];
      },
    ));
    byWeek['not-a-week'] = persistedDraft('not-a-week');
    byWeek['2026-W53'] = { ...persistedDraft('2026-W53'), topic: oversized };

    const normalized = normalizeWeeklyCoachDraftCollection({
      collectionVersion: 1,
      byWeek,
      messages: ['不得持久化'],
    });

    expect(Object.keys(normalized.byWeek)).toHaveLength(12);
    expect(Object.keys(normalized.byWeek)).not.toContain('2026-W01');
    expect(Object.keys(normalized.byWeek)).not.toContain('2026-W02');
    expect(Object.keys(normalized.byWeek)).not.toContain('not-a-week');
    expect(Object.keys(normalized.byWeek)).not.toContain('2026-W53');
    const saved = normalized.byWeek['2026-W14'] as unknown as Record<string, unknown>;
    expect((saved.items as unknown[])).toHaveLength(3);
    expect((saved.keyAnswers as unknown[])).toHaveLength(8);
    expect(saved).not.toHaveProperty('messages');
    expect(saved).not.toHaveProperty('sourceDocuments');
    expect(saved).not.toHaveProperty('unknown');
    expect(normalized).toEqual({
      collectionVersion: 1,
      byWeek: normalized.byWeek,
    });
  });

  it('migrates legacy plaintext deletion tombstones to opaque digests', () => {
    const legacy = {
      ...persistedDraft(),
      deletedItems: [{ id: 'focus-2', focusKey: '发布插件' }],
    };

    const normalized = normalizeWeeklyCoachDraftCollection({
      collectionVersion: 1,
      byWeek: { '2026-W32': legacy },
    });
    const serialized = JSON.stringify(normalized.byWeek['2026-W32']?.deletedItems);

    expect(serialized).not.toContain('发布插件');
    expect(normalized.byWeek['2026-W32']?.deletedItems[0]?.focusKey)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('drops malformed nested values and undeclared fields', () => {
    const raw = {
      ...persistedDraft(),
      selectedSources: ['目标', '私密原文'],
      pendingInput: 42,
      keyAnswers: ['有效回答', 'x'.repeat(4_001)],
      items: [{
        ...completeItem('focus-1'),
        fieldSources: { focus: 'user', outcome: 'unsafe', whyThisWeek: 'ai', evidence: 'ai' },
        suggestions: { outcome: '可采用', private: '不得保留' },
        rawSource: '不得保留',
      }],
      background: {
        facts: ['事实'], assumptions: [], gaps: [], sources: ['path.md'], raw: '不得保留',
      },
      deletedItems: [{ id: 'focus-2', focusKey: '删除项', raw: '不得保留' }],
    };

    const normalized = normalizeWeeklyCoachDraftCollection({
      collectionVersion: 1,
      byWeek: { '2026-W32': raw },
    });

    expect(normalized.byWeek['2026-W32']).toBeUndefined();
  });
});
