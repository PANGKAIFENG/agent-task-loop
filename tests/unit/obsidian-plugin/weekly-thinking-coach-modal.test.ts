/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { WeeklyThinkingCoachModal } from '../../../src/obsidian-plugin/weekly-thinking-coach-modal.js';
import type { WeeklyCoachResult } from '../../../src/obsidian-plugin/weekly-thinking-coach.js';
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
    ...overrides,
  };
}

function weeklyDocument(status: '草稿' | '已确认' = '草稿'): WeeklyFocusDocument {
  const input = emptyInput({
    conversationTopic: '判断是否收敛产品边界',
    currentQuestion: '周五前希望出现什么变化？',
    coachSummary: '需要先定义可观察结果。',
    focuses: [{
      problem: '收敛产品边界',
      judgment: status === '已确认' ? '先验证两个真实流程' : '',
      outcome: '形成一页边界图',
      evidence: '两个流程共同确认',
      commitment: '周五前完成',
    }],
    background: {
      facts: ['边界问题反复出现'],
      assumptions: ['边界图可能减少讨论'],
      gaps: ['缺少验收人'],
      sources: ['02_Projects/StyleWork.md'],
    },
  });
  return {
    path: '05_Reviews/Weekly/2026-W30 周度重点.md',
    raw: 'synthetic weekly focus',
    record: {
      type: '周度重点',
      week: '2026-W30',
      status,
      linkedGoals: [],
      linkedTasks: [],
      createdBy: 'ATL 思考教练',
      confirmedAt: status === '已确认' ? '2026-07-26T08:00:00.000Z' : null,
      reviewStatus: '待复盘',
      updatedAt: '2026-07-26T08:00:00.000Z',
      input,
    },
  };
}

const coachResult: WeeklyCoachResult = {
  background: {
    facts: ['边界问题一周内重复出现。'],
    assumptions: ['边界图可能减少重复讨论。'],
    gaps: ['尚未确认验收人。'],
    sources: ['02_Projects/StyleWork.md'],
  },
  currentQuestion: '周五前，哪个可观察变化能证明这件事值得做？',
  questionReason: '这个答案会改变本周是否值得投入。',
  directions: [{
    title: '先做低成本验证',
    rationale: '用真实流程验证边界。',
    tradeoff: '推迟新增 Agent 名称。',
    validation: '两条流程使用同一说明。',
  }],
  organizedDraft: {
    problem: '收敛 StyleWork 产品边界。',
    outcome: '减少团队重复讨论。',
    evidence: '两条流程使用同一边界说明。',
    commitment: '周五前完成一页边界图。',
    notDoing: ['不新增 Agent 名称。'],
  },
  summary: '用户希望用可观察结果判断本周投入。',
};

function button(modal: WeeklyThinkingCoachModal, label: string): HTMLButtonElement {
  const match = [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => (
      item.getAttribute('aria-label') === label
      || item.textContent?.trim() === label
    ));
  if (match === undefined) throw new Error(`Missing button: ${label}`);
  return match;
}

function setup(options: {
  initial?: WeeklyFocusDocument | null;
  coach?: WeeklyCoachResult | Error;
  coachOperation?: (control?: {
    signal: AbortSignal;
    onProgress(progress: unknown): void;
  }) => Promise<WeeklyCoachResult>;
  allowed?: () => boolean;
  confirmOperation?: (input: WeeklyFocusInput) => Promise<WeeklyFocusDocument>;
  saveDraftError?: Error;
} = {}) {
  const runCoach = vi.fn(async (_turn: unknown, control?: {
    signal: AbortSignal;
    onProgress(progress: unknown): void;
  }) => {
    if (options.coachOperation !== undefined) return options.coachOperation(control);
    if (options.coach instanceof Error) throw options.coach;
    return options.coach ?? coachResult;
  });
  const saveDraft = vi.fn(async (input: WeeklyFocusInput): Promise<WeeklyFocusDocument> => {
    if (options.saveDraftError !== undefined) throw options.saveDraftError;
    return {
      ...weeklyDocument('草稿'),
      record: { ...weeklyDocument('草稿').record, input },
    };
  });
  const confirm = vi.fn(async (input: WeeklyFocusInput): Promise<WeeklyFocusDocument> => (
    options.confirmOperation?.(input) ?? {
      ...weeklyDocument('已确认'),
      record: { ...weeklyDocument('已确认').record, input },
    }
  ));
  const onChanged = vi.fn();
  const openRecord = vi.fn(async () => undefined);
  const notify = vi.fn();
  const modal = new WeeklyThinkingCoachModal({} as never, {
    week: '2026-W30',
    modelLabel: '沿用 Claude Code / CC-Switch',
    load: vi.fn(async () => options.initial ?? null),
    runCoach,
    saveDraft,
    confirm,
    canManageVault: options.allowed ?? (() => true),
    onChanged,
    openRecord,
    notify,
  });
  return { modal, runCoach, saveDraft, confirm, onChanged, openRecord, notify };
}

describe('WeeklyThinkingCoachModal', () => {
  it('starts in a centered native modal with sensitive sources unchecked', async () => {
    const { modal } = setup();
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    expect(modal.modalEl.classList).toContain('atl-weekly-coach-modal');
    expect(modal.contentEl.textContent).toContain('2026-W30');
    expect(modal.contentEl.textContent).toContain('沿用 Claude Code / CC-Switch');
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权笔记同步助手"]',
    )?.checked).toBe(false);
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权每日所思"]',
    )?.checked).toBe(false);
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权任务"]',
    )?.checked).toBe(true);
  });

  it('sends only selected sources, shows one coaching question, and organizes an editable draft', async () => {
    const { modal, runCoach } = setup();
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '这周是否应该收敛产品边界？';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    button(modal, '确认并开始').click();
    expect(modal.contentEl.textContent).toContain('正在准备本周教练建议');
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain(coachResult.currentQuestion));
    expect(runCoach).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: '这周是否应该收敛产品边界？',
        selectedSources: ['目标', '项目', '任务', '日历', '周复盘'],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(modal.contentEl.textContent).toContain('已确认事实');
    expect(modal.contentEl.textContent).toContain('可考虑方向');

    button(modal, '结束讨论，进入确认').click();
    expect(modal.contentEl.textContent).toContain('这是对你表达的整理，不是 AI 替你决定');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="第1项真正想解决的问题"]',
    )?.value).toBe('收敛 StyleWork 产品边界。');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="第1项用户最终判断"]',
    )?.value).toBe('');
  });

  it('keeps input after a model failure and lets the user continue manually', async () => {
    const { modal } = setup({ coach: new Error('private model detail') });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '需要人工继续的问题';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '确认并开始').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('AI 暂时不可用'));
    expect(modal.contentEl.textContent).not.toContain('private model detail');
    button(modal, '直接人工整理').click();
    expect(modal.contentEl.textContent).toContain('这是对你表达的整理，不是 AI 替你决定');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="第1项真正想解决的问题"]',
    )?.value).toBe('需要人工继续的问题');
  });

  it('distinguishes a three-minute timeout from a general model failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'claude_timeout' });
    const { modal } = setup({ coach: timeout });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));

    button(modal, '确认并开始').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('等待已超时'));
    expect(modal.contentEl.textContent).toContain('达到 3 分钟');
    expect(modal.contentEl.textContent).toContain('重新尝试');
    expect(modal.contentEl.textContent).toContain('直接人工整理');
  });

  it('resumes a saved draft and saves it without requiring AI', async () => {
    const draft = weeklyDocument('草稿');
    const { modal, saveDraft } = setup({ initial: draft });
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('继续本周思考'));
    expect(modal.contentEl.textContent).toContain(draft.record.input.currentQuestion);
    button(modal, '结束讨论，进入确认').click();
    const judgment = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="第1项用户最终判断"]',
    )!;
    judgment.value = '先完成两个真实流程验证。';
    judgment.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '保存草稿').click();

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        focuses: [expect.objectContaining({ judgment: '先完成两个真实流程验证。' })],
      }),
      draft.raw,
    ));
    expect(modal.contentEl.textContent).toContain('草稿已保存');
  });

  it('requires sensitive sources to be re-authorized when a saved draft starts a new session', async () => {
    const draft = weeklyDocument('草稿');
    draft.record.input.selectedSources = [
      ...draft.record.input.selectedSources,
      '笔记同步助手',
      '每日所思',
    ];
    const { modal } = setup({ initial: draft });
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('继续本周思考'));
    button(modal, '修改 AI 读取范围').click();

    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权笔记同步助手"]',
    )?.checked).toBe(false);
    expect(modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="授权每日所思"]',
    )?.checked).toBe(false);
  });

  it('does not resend an AI summary derived from sensitive sources before re-authorization', async () => {
    const draft = weeklyDocument('草稿');
    draft.record.input.selectedSources = [
      ...draft.record.input.selectedSources,
      '笔记同步助手',
      '每日所思',
    ];
    const { modal, runCoach } = setup({ initial: draft });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('继续本周思考'));

    button(modal, '提交回答，继续讨论').click();

    await vi.waitFor(() => expect(runCoach).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedSources: ['目标', '项目', '任务', '日历', '周复盘'],
        previousSummary: null,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });

  it('confirms an explicit no-new-focus decision and closes after refreshing the home', async () => {
    const { modal, confirm, onChanged } = setup();
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    button(modal, '直接人工整理').click();
    const noFocus = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="本周暂不新增重点"]',
    )!;
    noFocus.checked = true;
    noFocus.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '确认本周判断').click();

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ focuses: [], noNewFocus: true }),
      null,
    ));
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({ status: '已确认' }),
    }));
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('blocks persistence when Vault management permission is disabled', async () => {
    const { modal, saveDraft, confirm } = setup({ allowed: () => false });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    button(modal, '直接人工整理').click();
    button(modal, '保存草稿').click();

    expect(saveDraft).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('Vault 管理权限已关闭');
  });

  it('auto-saves a dirty unconfirmed session and refreshes the home when closed', async () => {
    const { modal, saveDraft, onChanged } = setup();
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '关闭后仍要保留';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    modal.close();

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ conversationTopic: '关闭后仍要保留' }),
      null,
    ));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ record: expect.objectContaining({ status: '草稿' }) }),
    ));
  });

  it('does not start a draft save when closed during confirmation', async () => {
    let finishConfirmation: ((document: WeeklyFocusDocument) => void) | undefined;
    const pendingConfirmation = new Promise<WeeklyFocusDocument>((resolve) => {
      finishConfirmation = resolve;
    });
    const { modal, confirm, saveDraft } = setup({
      confirmOperation: async () => pendingConfirmation,
    });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    button(modal, '直接人工整理').click();
    const noFocus = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="本周暂不新增重点"]',
    )!;
    noFocus.checked = true;
    noFocus.dispatchEvent(new window.Event('change', { bubbles: true }));

    button(modal, '确认本周判断').click();
    expect(confirm).toHaveBeenCalledTimes(1);
    modal.close();

    expect(saveDraft).not.toHaveBeenCalled();
    finishConfirmation?.(weeklyDocument('已确认'));
  });

  it('auto-saves user input when closed while the coach is still responding', async () => {
    let finishCoach: ((result: WeeklyCoachResult) => void) | undefined;
    const pendingCoach = new Promise<WeeklyCoachResult>((resolve) => {
      finishCoach = resolve;
    });
    const { modal, saveDraft } = setup({
      coachOperation: async () => pendingCoach,
    });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '等待教练时关闭也要保留';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    button(modal, '确认并开始').click();
    modal.close();

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ conversationTopic: '等待教练时关闭也要保留' }),
      null,
    ));
    finishCoach?.(coachResult);
  });

  it('shows real coach stages, source statistics, elapsed time, and slow-response guidance', async () => {
    vi.useFakeTimers();
    try {
      const pendingCoach = new Promise<WeeklyCoachResult>(() => undefined);
      const { modal } = setup({
        coachOperation: async (control) => {
          control?.onProgress({
            stage: 'context_ready',
            sourceCount: 5,
            documentCount: 23,
            totalCharacters: 31_824,
          });
          control?.onProgress({ stage: 'model_started' });
          return pendingCoach;
        },
      });
      modal.open();
      await Promise.resolve();

      button(modal, '确认并开始').click();

      expect(modal.contentEl.textContent).toContain('已读取授权资料');
      expect(modal.contentEl.textContent).toContain('5 类 · 23 篇 · 31,824 字');
      expect(modal.contentEl.textContent).toContain('Claude Code 已启动');
      expect(modal.contentEl.textContent).toContain('正在等待教练整理');
      expect(modal.contentEl.textContent).toContain('00:00 / 最长 03:00');

      await vi.advanceTimersByTimeAsync(45_000);

      expect(modal.contentEl.textContent).toContain('00:45 / 最长 03:00');
      expect(modal.contentEl.textContent).toContain('响应比平时慢');
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the displayed three-minute limit across the whole coach operation', async () => {
    vi.useFakeTimers();
    try {
      const pendingCoach = new Promise<WeeklyCoachResult>(() => undefined);
      const { modal, runCoach } = setup({ coachOperation: async () => pendingCoach });
      modal.open();
      await Promise.resolve();

      button(modal, '确认并开始').click();
      const control = runCoach.mock.calls[0]?.[1] as { signal: AbortSignal };

      await vi.advanceTimersByTimeAsync(180_000);

      expect(control.signal.aborted).toBe(true);
      expect(modal.contentEl.textContent).toContain('等待已超时');
      expect(modal.contentEl.textContent).toContain('达到 3 分钟');
      expect(modal.contentEl.textContent).toContain('重新尝试');
      expect(modal.contentEl.textContent).not.toContain('停止等待');
      modal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the active coach request and keeps the session input', async () => {
    const pendingCoach = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach } = setup({
      coachOperation: async () => pendingCoach,
    });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '停止后仍要保留的判断';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    button(modal, '确认并开始').click();
    const control = runCoach.mock.calls[0]?.[1] as { signal: AbortSignal };
    button(modal, '停止等待').click();

    expect(control.signal.aborted).toBe(true);
    expect(modal.contentEl.textContent).toContain('已停止 AI 整理');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )?.value).toBe('停止后仍要保留的判断');
  });

  it('aborts the coach and opens manual organization without losing input', async () => {
    const pendingCoach = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach } = setup({ coachOperation: async () => pendingCoach });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '人工继续整理的判断';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    button(modal, '确认并开始').click();
    const control = runCoach.mock.calls[0]?.[1] as { signal: AbortSignal };
    button(modal, '转为人工整理').click();

    expect(control.signal.aborted).toBe(true);
    expect(modal.contentEl.textContent).toContain('这是对你表达的整理');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="第1项真正想解决的问题"]',
    )?.value).toBe('人工继续整理的判断');
  });

  it('aborts the coach process when the modal closes', async () => {
    const pendingCoach = new Promise<WeeklyCoachResult>(() => undefined);
    const { modal, runCoach } = setup({ coachOperation: async () => pendingCoach });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));

    button(modal, '确认并开始').click();
    const control = runCoach.mock.calls[0]?.[1] as { signal: AbortSignal };
    modal.close();

    expect(control.signal.aborted).toBe(true);
  });

  it('explains the result actions and distinguishes analysis from Obsidian persistence', async () => {
    const { modal } = setup({ initial: weeklyDocument('草稿') });
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('继续本周思考'));
    const actionPanel = modal.contentEl.querySelector('.atl-weekly-coach-result-actions');
    const choices = actionPanel?.querySelectorAll('.atl-weekly-coach-choice');

    expect(actionPanel?.textContent).toContain('想调整资料来源？');
    expect(actionPanel?.textContent).toContain('修改 AI 读取范围');
    expect(choices).toHaveLength(2);
    expect(choices?.[0]?.textContent).toContain('提交回答，继续讨论');
    expect(choices?.[0]?.textContent).toContain('AI 会结合当前回答再分析一轮，不会写入 Obsidian');
    expect(choices?.[1]?.textContent).toContain('结束讨论，进入确认');
    expect(choices?.[1]?.textContent).toContain('把当前建议整理成可编辑清单，下一步确认后才写入 Obsidian');
  });

  it('notifies the user when close-triggered draft saving fails', async () => {
    const { modal, notify } = setup({ saveDraftError: new Error('disk full') });
    modal.open();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('从一个困惑开始'));
    const topic = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="本周想讨论的问题"]',
    )!;
    topic.value = '关闭时需要保存';
    topic.dispatchEvent(new window.Event('input', { bubbles: true }));

    modal.close();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      '草稿自动保存失败，请重新打开本周思考后手动保存。',
    ));
  });

  it('shows a confirmed record and opens its Markdown without re-running the coach', async () => {
    const confirmed = weeklyDocument('已确认');
    const { modal, runCoach, openRecord } = setup({ initial: confirmed });
    modal.open();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('这是你确认的本周判断'));
    expect(modal.contentEl.textContent).toContain('先验证两个真实流程');
    button(modal, '打开 Markdown').click();
    expect(openRecord).toHaveBeenCalledWith(confirmed.path);
    expect(runCoach).not.toHaveBeenCalled();
  });
});
