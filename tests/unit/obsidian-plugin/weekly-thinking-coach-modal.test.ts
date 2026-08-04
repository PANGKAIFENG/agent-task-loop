/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { WeeklyThinkingCoachModal } from '../../../src/obsidian-plugin/weekly-thinking-coach-modal.js';
import type {
  WeeklyThinkingCoachRunControl,
  WeeklyCoachResult,
} from '../../../src/obsidian-plugin/weekly-thinking-coach.js';
import {
  createWeeklyCoachSessionDraft,
  emptyWeeklyCoachDraftCollection,
  putWeeklyCoachSessionDraft,
  type WeeklyCoachDraftItem,
  type WeeklyCoachSessionDraft,
  type WeeklyThinkingCoachTurn,
} from '../../../src/services/weekly-coach-draft.js';
import type {
  WeeklyFocusDocument,
  WeeklyFocusInput,
} from '../../../src/services/weekly-focus.js';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.createDiv = function createDiv(options = {}): HTMLDivElement {
    return this.createEl('div', options);
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: DomElementInfo | string = {},
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    const info = typeof options === 'string' ? { text: options } : options;
    if (info.cls !== undefined) {
      element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    }
    if (info.text instanceof DocumentFragment) element.append(info.text);
    else if (info.text !== undefined) element.textContent = info.text;
    if (info.type !== undefined) element.setAttribute('type', info.type);
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    this.append(element);
    callback?.(element);
    return element;
  };
});

const NOW = new Date('2026-08-03T09:00:00.000Z');

function emptyInput(overrides: Partial<WeeklyFocusInput> = {}): WeeklyFocusInput {
  return {
    conversationTopic: '',
    selectedSources: ['目标', '项目', '任务', '日历', '周复盘'],
    currentQuestion: '',
    coachSummary: '',
    focuses: [],
    noNewFocus: false,
    notDoing: [],
    background: { facts: [], assumptions: [], gaps: [], sources: [] },
    coachInsights: [],
    consideredDirections: [],
    keyAnswers: [],
    linkedGoals: [],
    linkedTasks: [],
    adjustmentNote: '',
    unassignedDeferredTaskQuestions: [],
    ...overrides,
  };
}

function weeklyDocument(status: '草稿' | '已确认' = '已确认'): WeeklyFocusDocument {
  const input = emptyInput({
    conversationTopic: '判断是否收敛产品边界',
    currentQuestion: '周五前希望出现什么变化？',
    coachSummary: '需要先定义可观察结果。',
    focuses: [{
      focus: '验证产品边界是否可复用',
      outcome: '团队使用同一份边界说明',
      whyThisWeek: '本周有两个真实流程可验证',
      evidence: '两个流程负责人确认采用',
      deferredTaskQuestions: [],
    }],
  });
  return {
    path: '05_Reviews/Weekly/2026-W32 周度重点.md',
    raw: 'synthetic weekly focus',
    record: {
      type: '周度重点',
      week: '2026-W32',
      status,
      linkedGoals: [],
      linkedTasks: [],
      createdBy: 'ATL 思考教练',
      confirmedAt: status === '已确认' ? NOW.toISOString() : null,
      reviewStatus: '待复盘',
      updatedAt: NOW.toISOString(),
      input,
    },
  };
}

function draftItem(id = 'focus-1', overrides: Partial<WeeklyCoachDraftItem> = {}): WeeklyCoachDraftItem {
  return {
    id,
    focus: '验证产品边界是否可复用',
    outcome: '团队使用同一份边界说明',
    whyThisWeek: '本周有两个真实流程可验证',
    evidence: '两个流程负责人确认采用',
    fieldSources: {
      focus: 'ai', outcome: 'ai', whyThisWeek: 'ai', evidence: 'ai',
    },
    suggestions: {},
    readiness: '可确认',
    ...overrides,
  };
}

function sessionDraft(overrides: Partial<WeeklyCoachSessionDraft> = {}): WeeklyCoachSessionDraft {
  return {
    ...createWeeklyCoachSessionDraft('2026-W32', NOW.toISOString()),
    topic: '判断本周是否应该收敛产品边界',
    selectedSources: ['目标', '项目', '任务', '日历', '周复盘'],
    sessionSummary: '已经形成一个候选方向，仍需确认完成证据。',
    pendingQuestion: '什么变化最能证明这件事值得做？',
    questionReason: '这个答案会补齐完成证据。',
    items: [draftItem()],
    ...overrides,
  };
}

const coachResult: WeeklyCoachResult = {
  assistantMessage: '先不要急着列任务。你真正要验证的是边界图是否会被使用。',
  nextQuestion: '如果周五只看到一个变化，什么变化最能证明这件事值得做？',
  questionReason: '这个答案会决定预期结果和完成证据。',
  nextQuestionDimension: '周级结果',
  deferredTaskQuestions: [],
  background: {
    facts: ['边界问题一周内重复出现。'],
    assumptions: ['边界图可能减少重复讨论。'],
    gaps: ['尚未确认验收人。'],
    sources: ['02_Projects/StyleWork.md'],
  },
  draftOperations: [{
    action: 'create',
    itemId: null,
    fields: {
      focus: '验证产品边界是否可复用',
      outcome: '团队使用同一份边界说明',
      whyThisWeek: '本周有两个真实流程可验证',
    },
  }],
  sessionSummary: '用户希望用团队是否采用同一说明判断投入价值。',
  readiness: '继续澄清',
};

function button(modal: WeeklyThinkingCoachModal, label: string): HTMLButtonElement {
  const match = [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (match === undefined) throw new Error(`Missing button: ${label}`);
  return match;
}

function sendMessage(modal: WeeklyThinkingCoachModal, value: string): void {
  const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="给本周思考教练发消息"]',
  );
  if (input === null) throw new Error('Missing weekly coach composer');
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  button(modal, '发送').click();
}

function editField(modal: WeeklyThinkingCoachModal, label: string, value: string): void {
  const input = modal.contentEl.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (input === null) throw new Error(`Missing field: ${label}`);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function setup(options: {
  record?: WeeklyFocusDocument | null;
  loadRecordError?: Error;
  draft?: WeeklyCoachSessionDraft | null;
  coach?: WeeklyCoachResult | Error;
  coachOperation?: (
    turn: WeeklyThinkingCoachTurn,
    control: WeeklyThinkingCoachRunControl,
  ) => Promise<WeeklyCoachResult>;
  saveError?: Error;
  saveOperation?: (draft: WeeklyCoachSessionDraft) => Promise<void>;
  clearError?: Error;
  confirmOperation?: (
    input: WeeklyFocusInput,
    expectedContent: string | null,
  ) => Promise<WeeklyFocusDocument>;
  allowed?: () => boolean;
  currentWeek?: () => string;
  modelLabel?: string;
} = {}) {
  let id = 0;
  const runCoach = vi.fn(async (
    turn: WeeklyThinkingCoachTurn,
    control: WeeklyThinkingCoachRunControl,
  ) => {
    if (options.coachOperation !== undefined) return options.coachOperation(turn, control);
    if (options.coach instanceof Error) throw options.coach;
    return options.coach ?? coachResult;
  });
  const saveSessionDraft = vi.fn(async (draft: WeeklyCoachSessionDraft) => {
    if (options.saveOperation !== undefined) return options.saveOperation(draft);
    if (options.saveError !== undefined) throw options.saveError;
  });
  const clearSessionDraft = vi.fn(async () => {
    if (options.clearError !== undefined) throw options.clearError;
  });
  const confirm = vi.fn(async (input: WeeklyFocusInput, expectedContent: string | null) => (
    options.confirmOperation?.(input, expectedContent) ?? {
      ...weeklyDocument('已确认'),
      record: { ...weeklyDocument('已确认').record, input },
    }
  ));
  const onChanged = vi.fn();
  const openRecord = vi.fn(async () => undefined);
  const notify = vi.fn();
  const modal = new WeeklyThinkingCoachModal({} as never, {
    week: '2026-W32',
    modelLabel: options.modelLabel ?? '沿用 Claude Code / CC-Switch',
    loadRecord: vi.fn(async () => {
      if (options.loadRecordError !== undefined) throw options.loadRecordError;
      return options.record ?? null;
    }),
    loadSessionDraft: vi.fn(() => options.draft ?? null),
    runCoach,
    saveSessionDraft,
    clearSessionDraft,
    confirm,
    canManageVault: options.allowed ?? (() => true),
    onChanged,
    openRecord,
    notify,
    now: () => NOW,
    currentWeek: options.currentWeek ?? (() => '2026-W32'),
    createId: () => `generated-${++id}`,
  });
  return {
    modal,
    runCoach,
    saveSessionDraft,
    clearSessionDraft,
    confirm,
    onChanged,
    openRecord,
    notify,
  };
}

async function open(modal: WeeklyThinkingCoachModal): Promise<void> {
  modal.open();
  await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('本周思考教练'));
}

describe('WeeklyThinkingCoachModal', () => {
  it('opens the confirmed two-column shell with sensitive sources unchecked', async () => {
    const { modal } = setup();
    await open(modal);

    expect(modal.modalEl.classList).toContain('atl-weekly-coach-modal');
    expect(modal.contentEl.querySelector('.atl-weekly-coach-conversation')).not.toBeNull();
    expect(modal.contentEl.querySelector('.atl-weekly-coach-draft-panel')).not.toBeNull();
    expect(modal.contentEl.textContent).toContain('本周重点草稿');
    expect(modal.contentEl.textContent).toContain('0 / 3');
    expect(modal.contentEl.textContent).toContain('2026-W32');
    expect(modal.contentEl.textContent).toContain('沿用 Claude Code / CC-Switch');
    expect(modal.contentEl.textContent).toContain('已配置');
    expect(modal.contentEl.textContent).not.toContain('已连接');
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="授权任务"]')?.checked)
      .toBe(true);
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权笔记同步助手"]',
    )?.checked).toBe(false);
    expect(button(modal, '发送').title).toBe('发送');
    expect(button(modal, '人工添加重点').title).toBe('人工添加重点');
    const sourceList = modal.contentEl.querySelector<HTMLElement>('.atl-weekly-coach-source-list')!;
    expect(sourceList.hidden).toBe(true);
    button(modal, '调整资料').click();
    expect(sourceList.hidden).toBe(false);
  });

  it('keeps the modal open when the backdrop is clicked', async () => {
    const { modal } = setup();
    await open(modal);
    const close = vi.spyOn(modal, 'close');
    modal.containerEl.addEventListener('click', () => modal.close());

    modal.containerEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(close).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('本周思考教练');
  });

  it('does not claim a model connection when configuration is invalid', async () => {
    const { modal } = setup({ modelLabel: '模型配置需检查（可人工整理）' });
    await open(modal);

    expect(modal.contentEl.textContent).toContain('需配置');
    expect(modal.contentEl.textContent).not.toContain('已连接');
  });

  it('updates the conversation and live draft atomically after one AI response', async () => {
    const { modal, runCoach } = setup();
    await open(modal);

    sendMessage(modal, '我希望减少团队重复讨论');

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain(
      '先不要急着列任务。你真正要验证的是边界图是否会被使用。',
    ));
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="重点事项"]')?.value)
      .toBe('验证产品边界是否可复用');
    expect(modal.contentEl.textContent).toContain('1 / 3');
    expect(modal.contentEl.textContent).toContain(coachResult.nextQuestion);
    expect(runCoach).toHaveBeenCalledWith(expect.objectContaining({
      latestAnswer: '我希望减少团队重复讨论',
      draftItems: [],
      focusedItemId: null,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows linked and unassigned deferred questions without task execution actions', async () => {
    const result: WeeklyCoachResult = {
      ...coachResult,
      deferredTaskQuestions: [{
        relatedItemId: null,
        relatedFocus: '验证产品边界是否可复用',
        question: '定义边界说明的内部模板',
      }, {
        relatedItemId: null,
        relatedFocus: '其他方向',
        question: '确认后续任务承载位置',
      }],
    };
    const { modal } = setup({ coach: result });
    await open(modal);

    sendMessage(modal, '我希望减少团队重复讨论');

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('进入任务后待思考（1）'));
    expect(modal.contentEl.textContent).toContain(
      '这里只讨论本周是否值得投入和如何取舍；具体方案会记录下来，留到任务中处理。',
    );
    expect(modal.contentEl.textContent).toContain('待关联的任务问题（1）');
    const actionLabels = [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')]
      .map((item) => item.textContent?.trim() || item.getAttribute('aria-label'));
    expect(actionLabels).not.toContain('创建任务');
    expect(actionLabels).not.toContain('交给 AI');
  });

  it('edits and deletes a deferred question through the draft service', async () => {
    const result: WeeklyCoachResult = {
      ...coachResult,
      deferredTaskQuestions: [{
        relatedItemId: null,
        relatedFocus: '验证产品边界是否可复用',
        question: '定义 Skill 可用标准',
      }],
    };
    const { modal, saveSessionDraft } = setup({ coach: result });
    await open(modal);
    sendMessage(modal, '继续整理');
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('进入任务后待思考（1）'));

    const questionInput = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="编辑进入任务后待思考的问题"]',
    )!;
    questionInput.value = '确认 Skill 可用标准';
    questionInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '删除进入任务后待思考的问题').click();
    button(modal, '保存并离开').click();

    await vi.waitFor(() => expect(saveSessionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ deferredTaskQuestions: [] }),
    ));
  });

  it('keeps complete focuses confirmable when deferred questions reach their limit', async () => {
    const deferredTaskQuestions = Array.from({ length: 5 }, (_, index) => ({
      id: `question-${index + 1}`,
      relatedItemId: 'focus-1',
      relatedFocus: '验证产品边界是否可复用',
      question: `任务阶段问题 ${index + 1}`,
    }));
    const { modal, confirm } = setup({
      draft: sessionDraft({ deferredTaskQuestions }),
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        focuses: [expect.objectContaining({
          deferredTaskQuestions: deferredTaskQuestions.map((item) => item.question),
        })],
      }),
      null,
    ));
  });

  it('restores deferred questions from a formal draft and includes them in the next turn', async () => {
    const record = weeklyDocument('草稿');
    record.record.input.focuses[0]!.deferredTaskQuestions = ['定义兼容范围'];
    record.record.input.unassignedDeferredTaskQuestions = ['确认任务承载位置'];
    const { modal, runCoach } = setup({ record });
    await open(modal);

    expect(modal.contentEl.textContent).toContain('进入任务后待思考（1）');
    expect(modal.contentEl.textContent).toContain('待关联的任务问题（1）');
    sendMessage(modal, '继续做周级取舍');
    await vi.waitFor(() => expect(runCoach).toHaveBeenCalled());
    expect(runCoach.mock.calls[0]?.[0].deferredTaskQuestions).toEqual([
      expect.objectContaining({ relatedFocus: '验证产品边界是否可复用', question: '定义兼容范围' }),
      expect.objectContaining({ relatedItemId: null, question: '确认任务承载位置' }),
    ]);
  });

  it('replaces the composer send action with stop while AI is running', async () => {
    const pending = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal } = setup({ coachOperation: async () => pending });
    await open(modal);

    sendMessage(modal, '等待模型');

    expect(() => button(modal, '发送')).toThrow('Missing button: 发送');
    expect(button(modal, '停止等待').dataset.icon).toBe('square');
    modal.close();
  });

  it('renders partial cards and accessible add and delete icon actions', async () => {
    const partial = sessionDraft({
      items: [draftItem('focus-1', { outcome: '', evidence: '', readiness: '仍需确认' })],
    });
    const { modal } = setup({ draft: partial });
    await open(modal);

    expect(modal.contentEl.textContent).toContain('待补充');
    expect(button(modal, '删除重点').title).toBe('删除重点');
    expect(button(modal, '人工添加重点').dataset.icon).toBe('plus');
    expect(button(modal, '删除重点').dataset.icon).toBe('trash-2');
  });

  it('protects a direct edit and applies an AI replacement only after acceptance', async () => {
    const replacement: WeeklyCoachResult = {
      ...coachResult,
      draftOperations: [{
        action: 'update',
        itemId: 'focus-1',
        fields: { focus: '直接发布完整产品' },
      }],
    };
    const { modal } = setup({ draft: sessionDraft(), coach: replacement });
    await open(modal);

    editField(modal, '重点事项', '先验证两个真实流程');
    sendMessage(modal, '继续想一下');

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('采用建议'));
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="重点事项"]')?.value)
      .toBe('先验证两个真实流程');
    expect(modal.contentEl.textContent).toContain('已由你修改');
    button(modal, '采用建议').click();
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="重点事项"]')?.value)
      .toBe('直接发布完整产品');
  });

  it('isolates focused discussion to one item and allows ending focus mode', async () => {
    const second = draftItem('focus-2', { focus: '整理安装文档' });
    const focusedResult: WeeklyCoachResult = {
      ...coachResult,
      draftOperations: [{
        action: 'update',
        itemId: 'focus-2',
        fields: { outcome: '不应被修改' },
      }],
    };
    const { modal, runCoach } = setup({
      draft: sessionDraft({ items: [draftItem(), second] }),
      coach: focusedResult,
    });
    await open(modal);

    button(modal, '聚焦讨论').click();
    expect(modal.contentEl.textContent).toContain('接下来只讨论：验证产品边界是否可复用');
    sendMessage(modal, '只讨论第一项');
    await vi.waitFor(() => expect(runCoach).toHaveBeenCalled());
    expect(runCoach.mock.calls[0]?.[0]).toMatchObject({ focusedItemId: 'focus-1' });
    expect(modal.contentEl.querySelectorAll<HTMLInputElement>('input[aria-label="预期结果"]')[1]?.value)
      .toBe('团队使用同一份边界说明');
    button(modal, '结束聚焦').click();
    expect(modal.contentEl.textContent).not.toContain('接下来只讨论：');
  });

  it('keeps deferred questions from a focused turn scoped to the focused item', async () => {
    const second = draftItem('focus-2', { focus: '整理安装文档' });
    const focusedResult: WeeklyCoachResult = {
      ...coachResult,
      draftOperations: [],
      deferredTaskQuestions: [{
        relatedItemId: 'focus-2',
        relatedFocus: '整理安装文档',
        question: '通过 focus-2 ID 越界',
      }, {
        relatedItemId: null,
        relatedFocus: '整理安装文档',
        question: '通过 focus-2 名称越界',
      }, {
        relatedItemId: null,
        relatedFocus: '验证产品边界是否可复用',
        question: '定义边界说明模板',
      }],
    };
    const { modal, runCoach, saveSessionDraft } = setup({
      draft: sessionDraft({ items: [draftItem(), second] }),
      coach: focusedResult,
    });
    await open(modal);

    button(modal, '聚焦讨论').click();
    sendMessage(modal, '只讨论第一项');
    await vi.waitFor(() => expect(runCoach).toHaveBeenCalled());
    button(modal, '保存并离开').click();

    await vi.waitFor(() => expect(saveSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
      deferredTaskQuestions: [expect.objectContaining({
        relatedItemId: 'focus-1',
        question: '定义边界说明模板',
      })],
    })));
  });

  it('rerenders after editing a deferred question into a duplicate', async () => {
    const { modal } = setup({
      draft: sessionDraft({
        deferredTaskQuestions: [{
          id: 'question-1',
          relatedItemId: 'focus-1',
          relatedFocus: '验证产品边界是否可复用',
          question: '定义兼容范围',
        }, {
          id: 'question-2',
          relatedItemId: 'focus-1',
          relatedFocus: '验证产品边界是否可复用',
          question: '确认发布渠道',
        }],
      }),
    });
    await open(modal);

    const inputs = modal.contentEl.querySelectorAll<HTMLInputElement>(
      'input[aria-label="编辑进入任务后待思考的问题"]',
    );
    inputs[0]!.value = '确认发布渠道';
    inputs[0]!.dispatchEvent(new window.Event('input', { bubbles: true }));

    const rerenderedInputs = modal.contentEl.querySelectorAll<HTMLInputElement>(
      'input[aria-label="编辑进入任务后待思考的问题"]',
    );
    expect(rerenderedInputs).toHaveLength(1);
    expect(rerenderedInputs[0]?.value).toBe('确认发布渠道');
  });

  it('keeps a deleted direction removed when AI tries to recreate it', async () => {
    const { modal, runCoach } = setup({ draft: sessionDraft() });
    await open(modal);

    button(modal, '删除重点').click();
    expect(modal.contentEl.textContent).toContain('0 / 3');
    sendMessage(modal, '继续');
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain(coachResult.assistantMessage));
    expect(runCoach.mock.calls[0]?.[0].deletedFocuses)
      .toEqual(['验证产品边界是否可复用']);
    expect(modal.contentEl.textContent).toContain('0 / 3');
    expect(modal.contentEl.querySelector('input[aria-label="重点事项"]')).toBeNull();
  });

  it('autosaves plugin draft state after an 800 ms debounce', async () => {
    vi.useFakeTimers();
    try {
      const { modal, saveSessionDraft } = setup();
      modal.open();
      await Promise.resolve();
      const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="给本周思考教练发消息"]',
      )!;
      input.value = '先保存输入';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(799);
      expect(saveSessionDraft).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(saveSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
        pendingInput: '先保存输入',
      }));
      expect(modal.contentEl.textContent).toContain('刚刚暂存');
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a failed autosave when 4,001 characters exceed the draft limit', async () => {
    vi.useFakeTimers();
    try {
      let collection = putWeeklyCoachSessionDraft(
        emptyWeeklyCoachDraftCollection(),
        sessionDraft({ pendingInput: '之前已保存的内容' }),
      );
      const { modal } = setup({
        draft: collection.byWeek['2026-W32'] ?? null,
        saveOperation: async (draft) => {
          collection = putWeeklyCoachSessionDraft(collection, draft);
        },
      });
      modal.open();
      await Promise.resolve();
      const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="给本周思考教练发消息"]',
      )!;
      input.value = 'x'.repeat(4_001);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(800);

      expect(modal.contentEl.textContent).toContain('暂存失败');
      expect(collection.byWeek['2026-W32']?.pendingInput).toBe('之前已保存的内容');
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('save and leave cancels a running request, flushes the draft, and closes', async () => {
    const pending = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach, saveSessionDraft, onChanged } = setup({
      coachOperation: async () => pending,
    });
    await open(modal);
    sendMessage(modal, '还在等待的输入');
    const control = runCoach.mock.calls[0]?.[1];

    button(modal, '保存并离开').click();

    await vi.waitFor(() => expect(saveSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
      keyAnswers: ['还在等待的输入'],
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: '还在等待的输入' }),
      ]),
    })));
    expect(control?.signal.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(onChanged).toHaveBeenCalledOnce();
      expect(modal.contentEl.childElementCount).toBe(0);
    });
  });

  it('flushes a pending plugin draft save when the modal closes', async () => {
    const { modal, saveSessionDraft } = setup();
    await open(modal);
    const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="给本周思考教练发消息"]',
    )!;
    input.value = '关闭后继续';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    modal.close();

    await vi.waitFor(() => expect(saveSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
      pendingInput: '关闭后继续',
    })));
  });

  it('restores only structured progress and requires sensitive source authorization again', async () => {
    const restored = sessionDraft({
      selectedSources: ['目标', '任务', '笔记同步助手', '每日所思'],
      keyAnswers: ['这是结构化关键回答'],
    });
    const { modal, runCoach } = setup({ draft: restored });
    await open(modal);

    expect(modal.contentEl.textContent).toContain('上次进展');
    expect(modal.contentEl.textContent).toContain(restored.sessionSummary);
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权笔记同步助手"]',
    )?.checked).toBe(false);
    sendMessage(modal, '继续讨论');
    await vi.waitFor(() => expect(runCoach).toHaveBeenCalled());
    expect(runCoach.mock.calls[0]?.[0]).toMatchObject({
      selectedSources: ['目标', '任务'],
      previousSummary: null,
    });
  });

  it('restores the persisted conversation transcript before falling back to structured progress', async () => {
    const restored = sessionDraft({
      messages: [{
        id: 'message-user-1',
        role: 'user',
        text: '上次我决定先验证真实流程。',
      }, {
        id: 'message-ai-1',
        role: 'assistant',
        text: '那本周要观察什么变化？',
        question: '什么证据会让你愿意继续投入？',
        questionReason: '需要把投入和结果连起来。',
      }],
    } as WeeklyCoachSessionDraft & {
      messages: Array<Record<string, string>>;
    });
    const { modal } = setup({ draft: restored });

    await open(modal);

    expect(modal.contentEl.textContent).toContain('上次我决定先验证真实流程。');
    expect(modal.contentEl.textContent).toContain('什么证据会让你愿意继续投入？');
    expect(modal.contentEl.textContent).not.toContain('上次进展');
  });

  it('keeps the conversation container and manual scroll position during elapsed updates', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<WeeklyCoachResult>(() => undefined);
      const { modal } = setup({ coachOperation: async () => pending });
      await open(modal);
      sendMessage(modal, '等待期间我要阅读历史');
      const conversation = modal.contentEl.querySelector<HTMLElement>(
        '.atl-weekly-coach-conversation',
      )!;
      Object.defineProperty(conversation, 'scrollHeight', { configurable: true, value: 1_200 });
      Object.defineProperty(conversation, 'clientHeight', { configurable: true, value: 400 });
      conversation.scrollTop = 120;
      conversation.dispatchEvent(new window.Event('scroll'));

      await vi.advanceTimersByTimeAsync(1_000);

      expect(modal.contentEl.querySelector('.atl-weekly-coach-conversation')).toBe(conversation);
      expect(conversation.scrollTop).toBe(120);
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an explicit return-to-latest action after the user reads history', async () => {
    const pending = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach } = setup({ coachOperation: async (_turn, control) => {
      control.onProgress({ stage: 'model_started' });
      return pending;
    } });
    await open(modal);
    sendMessage(modal, '先读历史');
    const conversation = modal.contentEl.querySelector<HTMLElement>(
      '.atl-weekly-coach-conversation',
    )!;
    Object.defineProperty(conversation, 'scrollHeight', { configurable: true, value: 1_200 });
    Object.defineProperty(conversation, 'clientHeight', { configurable: true, value: 400 });
    conversation.scrollTop = 100;
    conversation.dispatchEvent(new window.Event('scroll'));
    runCoach.mock.calls[0]?.[1].onProgress({ stage: 'parsing' });

    expect(button(modal, '回到最新消息').dataset.icon).toBe('arrow-down');
    button(modal, '回到最新消息').click();
    expect(conversation.scrollTop).toBe(1_200);
    modal.close();
  });

  it('restores the plugin draft with a warning when the formal weekly record cannot be read', async () => {
    const restored = sessionDraft({ pendingInput: '继续补充完成证据' });
    const { modal } = setup({
      draft: restored,
      loadRecordError: new Error('vault read failed'),
    });

    await open(modal);

    expect(modal.contentEl.textContent).toContain('上次进展');
    expect(modal.contentEl.textContent).toContain(restored.sessionSummary);
    expect(modal.contentEl.textContent).toContain('本周记录暂时无法读取，已恢复插件草稿');
    expect(modal.contentEl.textContent).not.toContain('vault read failed');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="给本周思考教练发消息"]',
    )?.value).toBe('继续补充完成证据');
  });

  it('preserves legacy weekly draft fields that are not editable in the conversation modal', async () => {
    const record = weeklyDocument('草稿');
    const preserved = {
      notDoing: ['本周不扩展第二套方案'],
      coachInsights: ['先验证是否真的被团队采用'],
      consideredDirections: ['直接发布', '先试跑两个流程'],
      linkedGoals: ['季度目标/验证产品价值'],
      linkedTasks: ['10_Tasks/Active/验证边界.md'],
      adjustmentNote: '周三根据试跑反馈调整范围',
    };
    record.record.input = { ...record.record.input, ...preserved };
    record.record.linkedGoals = [...preserved.linkedGoals];
    record.record.linkedTasks = [...preserved.linkedTasks];
    const { modal, confirm } = setup({ record });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining(preserved),
      record.raw,
    ));
  });

  it('shows inline validation and supports explicit zero-item confirmation', async () => {
    const { modal, confirm, clearSessionDraft } = setup();
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();
    expect(modal.contentEl.textContent).toContain('请至少保留一项重点');
    const noFocus = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="本周暂不新增重点，先完成既有承诺"]',
    )!;
    noFocus.checked = true;
    noFocus.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ focuses: [], noNewFocus: true }),
      null,
    ));
    await vi.waitFor(() => {
      expect(clearSessionDraft).toHaveBeenCalledOnce();
      expect(modal.contentEl.textContent).toContain('这是你确认的本周判断');
    });
  });

  it('keeps the draft and blocks formal confirmation after the week changes', async () => {
    const { modal, confirm, clearSessionDraft } = setup({
      currentWeek: () => '2026-W33',
    });
    await open(modal);

    const noFocus = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="本周暂不新增重点，先完成既有承诺"]',
    )!;
    noFocus.checked = true;
    noFocus.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '确认并写入 Obsidian').click();

    expect(modal.contentEl.textContent).toContain('已进入新的自然周');
    expect(confirm).not.toHaveBeenCalled();
    expect(clearSessionDraft).not.toHaveBeenCalled();
  });

  it('keeps the draft when the service detects a week rollover after the UI check', async () => {
    const { modal, clearSessionDraft } = setup({
      currentWeek: () => '2026-W32',
      draft: sessionDraft(),
      confirmOperation: async () => {
        throw new Error('已进入新的自然周，请重新打开本周思考教练。');
      },
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('已进入新的自然周'));
    expect(clearSessionDraft).not.toHaveBeenCalled();
  });

  it('places missing-field validation beside the affected card', async () => {
    const { modal, confirm } = setup({
      draft: sessionDraft({ items: [draftItem('focus-1', { evidence: '', readiness: '仍需确认' })] }),
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    expect(confirm).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('请补充完成证据');
    expect(modal.contentEl.querySelector('.atl-weekly-coach-field-error')?.textContent)
      .toContain('请补充完成证据');
  });

  it('retains the plugin draft when the formal write conflicts', async () => {
    const { modal, clearSessionDraft } = setup({
      draft: sessionDraft(),
      record: weeklyDocument('草稿'),
      confirmOperation: async () => { throw new Error('本周记录已被其他编辑修改，请重新读取后再保存'); },
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('其他编辑修改'));
    expect(clearSessionDraft).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('本周重点草稿');
  });

  it('keeps the confirmed result when temporary-draft cleanup fails', async () => {
    const { modal, notify, onChanged } = setup({
      draft: sessionDraft(),
      clearError: new Error('settings unavailable'),
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('这是你确认的本周判断'));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('正式记录已确认，临时草稿清理失败');
  });

  it('freezes every editing entry while formal confirmation is in flight', async () => {
    let rejectConfirmation: ((reason: Error) => void) | undefined;
    const pendingConfirmation = new Promise<WeeklyFocusDocument>((_resolve, reject) => {
      rejectConfirmation = reject;
    });
    const draft = sessionDraft({
      items: [draftItem('focus-1', { suggestions: { focus: '直接发布完整产品' } })],
    });
    const { modal, confirm } = setup({
      draft,
      confirmOperation: async () => pendingConfirmation,
    });
    await open(modal);

    button(modal, '确认并写入 Obsidian').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());

    const controls = [...modal.contentEl.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >('button, input, textarea')];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => control.disabled)).toBe(true);
    expect(modal.contentEl.textContent).toContain('正在写入正式记录');

    const composer = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="给本周思考教练发消息"]',
    )!;
    composer.value = '等待期间输入的内容';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    const focus = modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="重点事项"]')!;
    focus.value = '等待期间修改的重点';
    focus.dispatchEvent(new window.Event('input', { bubbles: true }));
    const source = modal.contentEl.querySelector<HTMLInputElement>('input[aria-label="授权目标"]')!;
    source.checked = false;
    source.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '删除重点').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    rejectConfirmation?.(new Error('synthetic confirmation failure'));
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('本周判断未能写入'));
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="给本周思考教练发消息"]',
    )?.value).toBe('');
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="重点事项"]',
    )?.value).toBe('验证产品边界是否可复用');
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权目标"]',
    )?.checked).toBe(true);
    expect(modal.contentEl.textContent).toContain('1 / 3');
    expect(modal.contentEl.textContent).toContain('采用建议');
  });

  it('keeps user input after model failure and still allows manual confirmation', async () => {
    const { modal, confirm } = setup({ coach: new Error('private model detail') });
    await open(modal);
    sendMessage(modal, '需要人工继续的问题');

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('AI 暂时不可用'));
    expect(modal.contentEl.textContent).not.toContain('private model detail');
    button(modal, '人工添加重点').click();
    editField(modal, '重点事项', '人工判断');
    editField(modal, '预期结果', '形成一页判断');
    editField(modal, '为什么是本周', '本周有验证窗口');
    editField(modal, '完成证据', '负责人确认采用');
    button(modal, '确认并写入 Obsidian').click();
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  });

  it('shows real progress, a 45-second slow notice, and a 180-second timeout', async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<WeeklyCoachResult>(() => undefined);
      const { modal, runCoach } = setup({
        coachOperation: async (_turn, control) => {
          control.onProgress({
            stage: 'context_ready',
            sourceCount: 5,
            documentCount: 23,
            totalCharacters: 31_824,
          });
          control.onProgress({ stage: 'model_started' });
          return pending;
        },
      });
      modal.open();
      await Promise.resolve();
      sendMessage(modal, '等待模型');
      const control = runCoach.mock.calls[0]?.[1];

      expect(modal.contentEl.textContent).toContain('5 类 · 23 篇 · 31,824 字');
      expect(modal.contentEl.textContent).toContain('00:00 / 最长 03:00');
      await vi.advanceTimersByTimeAsync(45_000);
      expect(modal.contentEl.textContent).toContain('响应比平时慢');
      await vi.advanceTimersByTimeAsync(135_000);
      expect(control?.signal.aborted).toBe(true);
      expect(modal.contentEl.textContent).toContain('等待已超时');
      expect(modal.contentEl.textContent).toContain('重新尝试');
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an active request without losing the sent message', async () => {
    const pending = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach } = setup({ coachOperation: async () => pending });
    await open(modal);
    sendMessage(modal, '停止后仍要保留');
    const control = runCoach.mock.calls[0]?.[1];

    button(modal, '停止等待').click();

    expect(control?.signal.aborted).toBe(true);
    expect(modal.contentEl.textContent).toContain('已停止 AI 整理');
    expect(modal.contentEl.textContent).toContain('停止后仍要保留');
  });

  it('blocks only formal confirmation when Vault management is disabled', async () => {
    const { modal, saveSessionDraft, confirm } = setup({ allowed: () => false });
    await open(modal);
    button(modal, '人工添加重点').click();
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(saveSessionDraft).toHaveBeenCalled();

    button(modal, '确认并写入 Obsidian').click();
    expect(confirm).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('Vault 管理权限已关闭');
  });

  it('renders a confirmed formal record read-only and opens its Markdown', async () => {
    const confirmed = weeklyDocument('已确认');
    const { modal, runCoach, openRecord } = setup({ record: confirmed });
    await open(modal);

    expect(modal.contentEl.textContent).toContain('这是你确认的本周判断');
    expect(modal.contentEl.textContent).toContain('验证产品边界是否可复用');
    expect(modal.contentEl.querySelector('input[aria-label="重点事项"]')).toBeNull();
    button(modal, '打开 Markdown').click();
    expect(openRecord).toHaveBeenCalledWith(confirmed.path);
    expect(runCoach).not.toHaveBeenCalled();
  });
});
