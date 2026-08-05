import { App, Modal, setIcon } from 'obsidian';

import type { WeeklyCoachSource } from '../services/weekly-coach-context.js';
import { WEEKLY_COACH_SOURCES } from '../services/weekly-coach-context.js';
import {
  WEEKLY_COACH_DRAFT_FIELDS,
  acceptWeeklyCoachSuggestion,
  createManualWeeklyCoachDraftItem,
  createWeeklyCoachSessionDraft,
  editWeeklyCoachDeferredTaskQuestion,
  editWeeklyCoachDraftField,
  mergeWeeklyCoachDeferredTaskQuestions,
  mergeWeeklyCoachDraftOperations,
  protectRestoredWeeklyCoachDraft,
  removeWeeklyCoachDraftItem,
  removeWeeklyCoachDeferredTaskQuestion,
  validateWeeklyCoachSessionDraft,
  weeklyCoachDraftToFocusInput,
  type WeeklyCoachDraftField,
  type WeeklyCoachDraftValidationIssue,
  type WeeklyCoachSessionDraft,
  type WeeklyCoachTranscriptMessage,
  type WeeklyThinkingCoachTurn,
} from '../services/weekly-coach-draft.js';
import type {
  WeeklyFocusDocument,
  WeeklyFocusInput,
} from '../services/weekly-focus.js';
import type {
  WeeklyCoachResult,
  WeeklyThinkingCoachProgress,
  WeeklyThinkingCoachRunControl,
} from './weekly-thinking-coach.js';

const DEFAULT_SOURCES: WeeklyCoachSource[] = ['目标', '项目', '任务', '日历', '周复盘'];
const SENSITIVE_SOURCES = new Set<WeeklyCoachSource>(['笔记同步助手', '每日所思']);
const AUTOSAVE_DELAY_MS = 800;
const COACH_TIMEOUT_SECONDS = 180;
const SLOW_RESPONSE_SECONDS = 45;
const AUTO_FOLLOW_THRESHOLD_PX = 100;
const MAX_SESSION_MESSAGES = 40;

const FIELD_LABELS: Record<WeeklyCoachDraftField, string> = {
  focus: '重点事项',
  outcome: '预期结果',
  whyThisWeek: '为什么是本周',
  evidence: '完成证据',
};

type CoachMessage = WeeklyCoachTranscriptMessage;

type SaveStatus = '未保存' | '正在暂存' | '刚刚暂存' | '暂存失败' | '正式记录已确认';
type CoachFailure = 'timeout' | 'unavailable' | 'invalid' | 'cancelled' | null;
type CoachProgress = { stage: 'collecting' } | WeeklyThinkingCoachProgress;

export interface WeeklyThinkingCoachModalDependencies {
  week: string;
  modelLabel: string;
  loadRecord(): Promise<WeeklyFocusDocument | null>;
  loadSessionDraft(): WeeklyCoachSessionDraft | null;
  runCoach(
    input: WeeklyThinkingCoachTurn,
    control: WeeklyThinkingCoachRunControl,
  ): Promise<WeeklyCoachResult>;
  saveSessionDraft(draft: WeeklyCoachSessionDraft): Promise<void>;
  clearSessionDraft(): Promise<void>;
  confirm(input: WeeklyFocusInput, expectedContent: string | null): Promise<WeeklyFocusDocument>;
  canManageVault(): boolean;
  onChanged(): void;
  openRecord(path: string): Promise<void>;
  notify(message: string): void;
  now(): Date;
  currentWeek(): string;
  createId(): string;
}

function cloneSession(draft: WeeklyCoachSessionDraft): WeeklyCoachSessionDraft {
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
    items: draft.items.map((item) => ({
      ...item,
      fieldSources: { ...item.fieldSources },
      suggestions: { ...item.suggestions },
    })),
    deferredTaskQuestions: draft.deferredTaskQuestions.map((item) => ({ ...item })),
    protectedDeferredTaskQuestionKeys: [...draft.protectedDeferredTaskQuestionKeys],
    deletedItems: draft.deletedItems.map((item) => ({ ...item })),
    ...(draft.messages === undefined
      ? {}
      : { messages: draft.messages.map((message) => ({ ...message })) }),
  };
}

function sessionFromRecord(
  record: WeeklyFocusDocument,
  createId: () => string,
): WeeklyCoachSessionDraft {
  const input = record.record.input;
  const restoredItems = input.focuses.map((focus) => {
    const item = {
      ...createManualWeeklyCoachDraftItem(createId()),
      focus: focus.focus,
      outcome: focus.outcome,
      whyThisWeek: focus.whyThisWeek,
      evidence: focus.evidence,
      readiness: '可确认' as const,
    };
    return { item, questions: focus.deferredTaskQuestions };
  });
  return protectRestoredWeeklyCoachDraft({
    ...createWeeklyCoachSessionDraft(record.record.week, record.record.updatedAt),
    topic: input.conversationTopic,
    selectedSources: [...input.selectedSources],
    keyAnswers: [...input.keyAnswers].slice(-8),
    sessionSummary: input.coachSummary,
    pendingQuestion: input.currentQuestion,
    background: {
      facts: [...input.background.facts],
      assumptions: [...input.background.assumptions],
      gaps: [...input.background.gaps],
      sources: [...input.background.sources],
    },
    items: restoredItems.map(({ item }) => item),
    deferredTaskQuestions: [
      ...restoredItems.flatMap(({ item, questions }) => questions.map((question) => ({
        id: createId(),
        relatedItemId: item.id,
        relatedFocus: item.focus,
        question,
      }))),
      ...input.unassignedDeferredTaskQuestions.map((question) => ({
        id: createId(),
        relatedItemId: null,
        relatedFocus: '待关联重点',
        question,
      })),
    ],
    noNewFocus: input.noNewFocus,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || error.message === 'weekly_coach_cancelled'
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as Error & { code?: unknown }).code === 'claude_timeout';
}

function isInvalidResultError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ZodError'
    || error.message.toLowerCase().includes('schema')
    || error.message.toLowerCase().includes('json')
  );
}

export class WeeklyThinkingCoachModal extends Modal {
  private loading = true;
  private closed = false;
  private skipCloseSave = false;
  private currentRecord: WeeklyFocusDocument | null = null;
  private session: WeeklyCoachSessionDraft;
  private messages: CoachMessage[] = [];
  private validationIssues: WeeklyCoachDraftValidationIssue[] = [];
  private priorSensitiveSources = new Set<WeeklyCoachSource>();
  private busy = false;
  private persisting = false;
  private saveStatus: SaveStatus = '未保存';
  private dirty = false;
  private mutationVersion = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private coachAbortController: AbortController | null = null;
  private coachFailure: CoachFailure = null;
  private coachProgress: CoachProgress = { stage: 'collecting' };
  private lastContextStatistics: string | null = null;
  private lastAnswer = '';
  private elapsedSeconds = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private error = '';
  private sourcesExpanded = false;
  private conversationScrollTop = 0;
  private conversationAutoFollow = true;
  private readonly preventBackdropDismissal = (event: Event): void => {
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const backdrop = target?.closest?.('.modal-bg');
    const isOwnBackdrop = backdrop !== null
      && backdrop !== undefined
      && backdrop.parentElement === this.containerEl;
    if (event.target !== this.containerEl && !isOwnBackdrop) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  constructor(
    app: App,
    private readonly dependencies: WeeklyThinkingCoachModalDependencies,
  ) {
    super(app);
    this.session = createWeeklyCoachSessionDraft(
      dependencies.week,
      dependencies.now().toISOString(),
    );
    this.session.selectedSources = [...DEFAULT_SOURCES];
  }

  override onOpen(): void {
    this.closed = false;
    this.skipCloseSave = false;
    this.modalEl.classList.add('atl-weekly-coach-modal');
    this.contentEl.classList.add('atl-weekly-coach-content');
    this.containerEl.addEventListener('pointerdown', this.preventBackdropDismissal, true);
    this.containerEl.addEventListener('mousedown', this.preventBackdropDismissal, true);
    this.containerEl.addEventListener('click', this.preventBackdropDismissal, true);
    this.render();
    void this.load();
  }

  override onClose(): void {
    this.closed = true;
    this.abortActiveCoach();
    this.clearAutosaveTimer();
    this.containerEl.removeEventListener('pointerdown', this.preventBackdropDismissal, true);
    this.containerEl.removeEventListener('mousedown', this.preventBackdropDismissal, true);
    this.containerEl.removeEventListener('click', this.preventBackdropDismissal, true);
    if (!this.skipCloseSave && !this.isConfirmed() && this.dirty) {
      void this.persistSessionDraft().catch(() => {
        this.dependencies.notify('草稿自动保存失败，请重新打开本周思考后手动保存。');
      });
    }
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      const record = await this.dependencies.loadRecord();
      if (this.closed) return;
      this.currentRecord = record;
      if (record?.record.status === '已确认') {
        this.saveStatus = '正式记录已确认';
        if (this.dependencies.loadSessionDraft() !== null) {
          void this.dependencies.clearSessionDraft().catch(() => {
            this.dependencies.notify('正式记录已确认，临时草稿清理失败');
          });
        }
      } else {
        const stored = this.dependencies.loadSessionDraft();
        const restored = stored ?? (record?.record.status === '草稿'
          ? sessionFromRecord(record, this.dependencies.createId)
          : null);
        if (restored === null) {
          this.session = createWeeklyCoachSessionDraft(
            this.dependencies.week,
            this.dependencies.now().toISOString(),
          );
          this.session.selectedSources = [...DEFAULT_SOURCES];
          this.messages = [{
            id: this.dependencies.createId(),
            role: 'assistant',
            text: '先说说你本周正在犹豫、最想推进，或最需要取舍的一件事。',
          }];
        } else {
          this.restoreSessionDraft(restored);
        }
      }
    } catch {
      if (this.closed) return;
      let stored: WeeklyCoachSessionDraft | null = null;
      try {
        stored = this.dependencies.loadSessionDraft();
      } catch {
        // The formal read warning below also covers an unavailable plugin draft store.
      }
      if (stored === null) {
        this.error = '本周记录暂时无法读取，你仍可先继续思考。';
        this.messages = [{
          id: this.dependencies.createId(),
          role: 'assistant',
          text: '先说说你本周最需要想清楚的一件事。',
        }];
      } else {
        this.restoreSessionDraft(stored);
        this.error = '本周记录暂时无法读取，已恢复插件草稿。确认写入前请先重试读取。';
      }
    } finally {
      if (!this.closed) {
        this.loading = false;
        this.render();
      }
    }
  }

  private restoreSessionDraft(restored: WeeklyCoachSessionDraft): void {
    this.priorSensitiveSources = new Set(
      restored.selectedSources.filter((source) => SENSITIVE_SOURCES.has(source)),
    );
    this.session = protectRestoredWeeklyCoachDraft({
      ...restored,
      selectedSources: restored.selectedSources.filter((source) => (
        !SENSITIVE_SOURCES.has(source)
      )),
    });
    this.messages = restored.messages === undefined || restored.messages.length === 0
      ? [{
        id: this.dependencies.createId(),
        role: 'assistant',
        text: this.restoredProgressMessage(),
      }]
      : restored.messages.map((message) => ({ ...message }));
  }

  private restoredProgressMessage(): string {
    const parts = [
      '上次进展',
      this.session.sessionSummary,
      `当前已有 ${this.session.items.length} 项重点草稿。`,
      this.session.pendingQuestion === '' ? '' : `尚待回答：${this.session.pendingQuestion}`,
    ].filter(Boolean);
    return parts.join('\n');
  }

  private render(): void {
    this.captureConversationScroll();
    this.contentEl.empty();
    this.modalEl.classList.toggle('atl-weekly-coach-modal--busy', this.busy || this.persisting);
    if (this.loading) {
      this.contentEl.createDiv({
        cls: 'atl-weekly-coach-loading',
        text: '正在读取本周思考...',
      });
      return;
    }

    this.renderHeader();
    const main = this.contentEl.createDiv({
      cls: `atl-weekly-coach-main ${this.session.items.length === 0
        ? 'is-empty-draft'
        : 'has-draft-items'}`,
    });
    const conversation = main.createDiv({ cls: 'atl-weekly-coach-conversation' });
    this.renderConversation(conversation);
    this.attachConversationScroll(conversation);
    this.renderDraftPanel(main.createDiv({ cls: 'atl-weekly-coach-draft-panel' }));
    this.renderFooter();
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: 'atl-weekly-coach-header' });
    const title = header.createDiv({ cls: 'atl-weekly-coach-title' });
    title.createEl('h2', { text: '本周思考教练' });
    title.createEl('p', {
      text: `${this.dependencies.week} · 和 AI 一起想清楚本周真正值得投入的事情`,
    });
    const meta = header.createDiv({ cls: 'atl-weekly-coach-meta' });
    const requiresConfiguration = this.dependencies.modelLabel.startsWith('模型配置需检查');
    meta.createEl('span', {
      cls: `atl-weekly-coach-model-status${requiresConfiguration ? ' is-warning' : ''}`,
      text: requiresConfiguration ? '需配置' : '已配置',
    });
    meta.createEl('span', { text: this.dependencies.modelLabel });
  }

  private renderConversation(container: HTMLElement): void {
    if (this.isConfirmed()) {
      const confirmed = container.createDiv({ cls: 'atl-weekly-coach-confirmed-message' });
      confirmed.createEl('strong', { text: '这是你确认的本周判断' });
      confirmed.createEl('p', { text: '正式记录已写入 Obsidian，可用于本周执行与后续复盘。' });
      return;
    }

    this.renderSources(container);
    const messages = container.createDiv({ cls: 'atl-weekly-coach-messages' });
    for (const message of this.messages) this.renderMessage(messages, message);
    if (this.busy) this.renderProgress(messages);
    if (this.error !== '') {
      const error = messages.createDiv({ cls: 'atl-weekly-coach-error' });
      error.createEl('strong', { text: this.error });
      if (this.coachFailure === 'timeout' || this.coachFailure === 'unavailable' || this.coachFailure === 'invalid') {
        const actions = error.createDiv({ cls: 'atl-weekly-coach-error-actions' });
        this.appendTextButton(actions, '重新尝试', () => { void this.retryCoach(); });
        this.appendTextButton(actions, '继续人工整理', () => {
          this.coachFailure = null;
          this.error = '';
          this.render();
        });
      }
    }
    this.renderComposer(container);
  }

  private renderSources(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'atl-weekly-coach-sources' });
    const heading = section.createDiv({ cls: 'atl-weekly-coach-section-heading' });
    heading.createEl('strong', { text: '本次上下文' });
    const summary = heading.createEl('small', {
      cls: 'atl-weekly-coach-source-summary',
      text: this.sourceSummary(),
    });
    const list = section.createDiv({ cls: 'atl-weekly-coach-source-list' });
    list.hidden = !this.sourcesExpanded;
    const adjust = this.appendIconButton(heading, '调整资料', 'sliders-horizontal', () => {
      this.sourcesExpanded = !this.sourcesExpanded;
      list.hidden = !this.sourcesExpanded;
      adjust.setAttribute('aria-expanded', String(this.sourcesExpanded));
    });
    adjust.setAttribute('aria-expanded', String(this.sourcesExpanded));
    for (const source of WEEKLY_COACH_SOURCES) {
      const label = list.createEl('label', { cls: 'atl-weekly-coach-source' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.session.selectedSources.includes(source);
      checkbox.disabled = this.busy || this.persisting;
      checkbox.setAttribute('aria-label', `授权${source}`);
      checkbox.addEventListener('change', () => {
        if (this.busy || this.persisting) return;
        this.session = {
          ...this.session,
          selectedSources: checkbox.checked
            ? [...new Set([...this.session.selectedSources, source])]
            : this.session.selectedSources.filter((candidate) => candidate !== source),
        };
        summary.textContent = this.sourceSummary();
        this.changed();
      });
      label.createEl('span', { text: source });
    }
  }

  private renderMessage(container: HTMLElement, message: CoachMessage): void {
    const item = container.createDiv({
      cls: `atl-weekly-coach-message atl-weekly-coach-message--${message.role}`,
    });
    item.createEl('small', {
      text: message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI 教练' : '当前范围',
    });
    const body = item.createEl('p');
    for (const [index, line] of message.text.split('\n').entries()) {
      if (index > 0) body.createEl('br');
      body.append(line);
    }
    if (message.question !== undefined && message.question !== '') {
      const question = item.createDiv({ cls: 'atl-weekly-coach-question' });
      question.createEl('strong', { text: message.question });
      if (message.questionReason !== undefined && message.questionReason !== '') {
        question.createEl('small', { text: message.questionReason });
      }
    }
  }

  private renderComposer(container: HTMLElement): void {
    const composer = container.createDiv({ cls: 'atl-weekly-coach-composer' });
    const textarea = composer.createEl('textarea', {
      attr: {
        'aria-label': '给本周思考教练发消息',
        placeholder: this.session.pendingQuestion || '写下你的判断、顾虑或想进一步讨论的方向',
      },
    });
    textarea.rows = 3;
    textarea.value = this.session.pendingInput;
    textarea.disabled = this.persisting;
    const action = this.busy
      ? this.appendIconButton(composer, '停止等待', 'square', () => this.stopCoach())
      : this.appendIconButton(composer, '发送', 'send', () => { void this.send(); });
    action.disabled = this.persisting || (!this.busy && this.session.pendingInput.trim() === '');
    textarea.addEventListener('input', () => {
      if (this.persisting) return;
      this.session = { ...this.session, pendingInput: textarea.value };
      if (!this.busy) action.disabled = textarea.value.trim() === '';
      this.changed();
    });
    const jumpToLatest = this.appendIconButton(
      composer,
      '回到最新消息',
      'arrow-down',
      () => this.scrollConversationToLatest(container),
    );
    jumpToLatest.classList.add('atl-weekly-coach-scroll-latest');
    jumpToLatest.hidden = this.conversationAutoFollow;
    composer.createEl('small', {
      text: '这里只讨论本周是否值得投入和如何取舍；具体方案会记录下来，留到任务中处理。',
    });
  }

  private renderProgress(container: HTMLElement): void {
    const progress = container.createDiv({ cls: 'atl-weekly-coach-progress' });
    progress.createEl('strong', { cls: 'atl-weekly-coach-progress-label' });
    progress.createEl('span', { cls: 'atl-weekly-coach-progress-statistics' });
    progress.createEl('span', { cls: 'atl-weekly-coach-progress-elapsed' });
    progress.createEl('small', { cls: 'atl-weekly-coach-slow-notice' });
    this.updateProgressDisplay();
  }

  private renderDraftPanel(container: HTMLElement): void {
    if (this.isConfirmed()) {
      this.renderConfirmedDraft(container);
      return;
    }
    const heading = container.createDiv({ cls: 'atl-weekly-coach-draft-heading' });
    const title = heading.createDiv();
    title.createEl('h3', { text: '本周重点草稿' });
    title.createEl('span', { text: `${this.session.items.length} / 3` });
    if (this.session.items.length < 3) {
      this.appendIconButton(heading, '人工添加重点', 'plus', () => this.addManualItem());
    }

    const list = container.createDiv({ cls: 'atl-weekly-coach-draft-list' });
    for (const [index, item] of this.session.items.entries()) {
      const card = list.createDiv({
        cls: [
          'atl-weekly-coach-draft-card',
          item.id === this.session.focusedItemId ? 'is-focused' : '',
        ].filter(Boolean).join(' '),
      });
      const cardHeading = card.createDiv({ cls: 'atl-weekly-coach-card-heading' });
      cardHeading.createEl('strong', { text: `重点 ${index + 1}` });
      cardHeading.createEl('span', {
        cls: item.readiness === '可确认' ? 'is-ready' : 'is-pending',
        text: item.readiness,
      });
      this.appendIconButton(cardHeading, '删除重点', 'trash-2', () => {
        this.session = removeWeeklyCoachDraftItem(this.session, item.id);
        this.validationIssues = [];
        this.changed();
        this.render();
      });

      for (const field of WEEKLY_COACH_DRAFT_FIELDS) {
        this.renderDraftField(card, item.id, field);
      }
      this.renderDeferredQuestions(card, item.id, '进入任务后待思考');

      const actions = card.createDiv({ cls: 'atl-weekly-coach-card-actions' });
      if (this.session.focusedItemId === item.id) {
        this.appendTextButton(actions, '结束聚焦', () => {
          this.session = { ...this.session, focusedItemId: null };
          this.messages = this.messages.filter((message) => (
            !(message.role === 'system' && message.text.startsWith('接下来只讨论：'))
          ));
          this.changed();
          this.render();
        });
      } else {
        this.appendTextButton(actions, '聚焦讨论', () => {
          this.session = { ...this.session, focusedItemId: item.id };
          this.messages.push({
            id: this.dependencies.createId(),
            role: 'system',
            text: `接下来只讨论：${item.focus || `重点 ${index + 1}`}`,
          });
          this.changed();
          this.render();
        });
      }
      this.appendTextButton(actions, '直接编辑', () => {
        card.querySelector<HTMLInputElement>('input')?.focus();
      });
    }
    this.renderDeferredQuestions(list, null, '待关联的任务问题');

    if (this.session.items.length < 3) {
      const empty = container.createDiv({ cls: 'atl-weekly-coach-empty-slot' });
      empty.createEl('strong', { text: '保留空位' });
      empty.createEl('p', { text: 'AI 只会在信息充分时形成下一项，不会为了凑满三项生成内容。' });
    }
    if (this.session.items.length === 0) this.renderNoFocusChoice(container);
    container.createEl('small', {
      cls: 'atl-weekly-coach-boundary-note',
      text: '草稿不会自动创建任务、修改任务状态或触发 Agent 执行。',
    });
  }

  private renderDraftField(
    container: HTMLElement,
    itemId: string,
    field: WeeklyCoachDraftField,
  ): void {
    const item = this.session.items.find((candidate) => candidate.id === itemId);
    if (item === undefined) return;
    const wrapper = container.createEl('label', { cls: 'atl-weekly-coach-draft-field' });
    const label = wrapper.createDiv({ cls: 'atl-weekly-coach-field-label' });
    label.createEl('span', { text: FIELD_LABELS[field] });
    if (item.fieldSources[field] === 'user') label.createEl('small', { text: '已由你修改' });
    const input = wrapper.createEl('input', {
      type: 'text',
      attr: {
        'aria-label': FIELD_LABELS[field],
        placeholder: '待补充',
      },
    });
    input.value = item[field];
    input.disabled = this.persisting;
    input.addEventListener('input', () => {
      if (this.persisting) return;
      this.session = editWeeklyCoachDraftField(this.session, itemId, field, input.value);
      this.validationIssues = this.validationIssues.filter((issue) => (
        issue.itemId !== itemId || issue.field !== field
      ));
      this.changed();
    });
    if (item[field].trim() === '') wrapper.createEl('small', { text: '待补充' });
    const issue = this.validationIssues.find((candidate) => (
      candidate.itemId === itemId && candidate.field === field
    ));
    if (issue !== undefined) {
      wrapper.createEl('small', { cls: 'atl-weekly-coach-field-error', text: issue.message });
    }
    const suggestion = item.suggestions[field];
    if (suggestion !== undefined) {
      const suggestionEl = wrapper.createDiv({ cls: 'atl-weekly-coach-suggestion' });
      suggestionEl.createEl('span', { text: `AI 建议：${suggestion}` });
      this.appendTextButton(suggestionEl, '采用建议', () => {
        this.session = acceptWeeklyCoachSuggestion(this.session, itemId, field);
        this.changed();
        this.render();
      });
    }
  }

  private renderDeferredQuestions(
    container: HTMLElement,
    relatedItemId: string | null,
    label: string,
  ): void {
    const questions = this.session.deferredTaskQuestions.filter(
      (question) => question.relatedItemId === relatedItemId,
    );
    if (questions.length === 0) return;
    const details = container.createEl('details', { cls: 'atl-weekly-coach-deferred' });
    details.createEl('summary', { text: `${label}（${questions.length}）` });
    const list = details.createDiv({ cls: 'atl-weekly-coach-deferred-list' });
    for (const question of questions) {
      const row = list.createDiv({ cls: 'atl-weekly-coach-deferred-row' });
      const input = row.createEl('input', {
        type: 'text',
        attr: { 'aria-label': '编辑进入任务后待思考的问题' },
      });
      input.value = question.question;
      input.disabled = this.persisting;
      input.addEventListener('input', () => {
        if (this.persisting) return;
        const updated = editWeeklyCoachDeferredTaskQuestion(
          this.session,
          question.id,
          input.value,
          question.question,
        );
        const removedAsDuplicate = !updated.deferredTaskQuestions.some(
          (candidate) => candidate.id === question.id,
        );
        this.session = updated;
        this.changed();
        if (removedAsDuplicate) this.render();
      });
      this.appendIconButton(row, '删除进入任务后待思考的问题', 'trash-2', () => {
        this.session = removeWeeklyCoachDeferredTaskQuestion(this.session, question.id);
        this.changed();
        this.render();
      });
    }
  }

  private renderReadOnlyDeferredQuestions(
    container: HTMLElement,
    questions: string[],
    label: string,
  ): void {
    if (questions.length === 0) return;
    const details = container.createEl('details', { cls: 'atl-weekly-coach-deferred' });
    details.createEl('summary', { text: `${label}（${questions.length}）` });
    const list = details.createEl('ul', { cls: 'atl-weekly-coach-deferred-readonly' });
    for (const question of questions) list.createEl('li', { text: question });
  }

  private renderNoFocusChoice(container: HTMLElement): void {
    const choice = container.createEl('label', { cls: 'atl-weekly-coach-no-focus' });
    const checkbox = choice.createEl('input', { type: 'checkbox' });
    checkbox.checked = this.session.noNewFocus;
    checkbox.disabled = this.persisting;
    checkbox.setAttribute('aria-label', '本周暂不新增重点，先完成既有承诺');
    checkbox.addEventListener('change', () => {
      if (this.persisting) return;
      this.session = { ...this.session, noNewFocus: checkbox.checked };
      this.validationIssues = this.validationIssues.filter((issue) => issue.field !== 'noNewFocus');
      this.changed();
    });
    choice.createEl('span', { text: '本周暂不新增重点，先完成既有承诺' });
    const issue = this.validationIssues.find((candidate) => candidate.field === 'noNewFocus');
    if (issue !== undefined) {
      container.createEl('small', { cls: 'atl-weekly-coach-field-error', text: issue.message });
    }
  }

  private renderConfirmedDraft(container: HTMLElement): void {
    const document = this.currentRecord;
    if (document === null) return;
    const heading = container.createDiv({ cls: 'atl-weekly-coach-draft-heading' });
    heading.createEl('h3', { text: '本周重点' });
    heading.createEl('span', { text: `${document.record.input.focuses.length} / 3` });
    if (document.record.input.focuses.length === 0) {
      container.createEl('p', { text: '本周暂不新增重点，先完成既有承诺。' });
    }
    for (const [index, focus] of document.record.input.focuses.entries()) {
      const card = container.createDiv({ cls: 'atl-weekly-coach-confirmed-focus' });
      card.createEl('small', { text: `重点 ${index + 1}` });
      card.createEl('strong', { text: focus.focus });
      card.createEl('span', { text: `预期结果：${focus.outcome}` });
      card.createEl('span', { text: `为什么是本周：${focus.whyThisWeek}` });
      card.createEl('span', { text: `完成证据：${focus.evidence}` });
      this.renderReadOnlyDeferredQuestions(
        card,
        focus.deferredTaskQuestions,
        '进入任务后待思考',
      );
    }
    this.renderReadOnlyDeferredQuestions(
      container,
      document.record.input.unassignedDeferredTaskQuestions,
      '其他进入任务后待思考的问题',
    );
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({ cls: 'atl-weekly-coach-footer' });
    footer.createEl('span', {
      cls: 'atl-weekly-coach-save-status',
      text: this.persisting ? '正在写入正式记录' : this.saveStatus,
    });
    const actions = footer.createDiv({ cls: 'atl-weekly-coach-footer-actions' });
    if (this.isConfirmed()) {
      this.appendTextButton(actions, '打开 Markdown', () => {
        if (this.currentRecord !== null) void this.dependencies.openRecord(this.currentRecord.path);
      });
      this.appendTextButton(actions, '关闭', () => {
        this.skipCloseSave = true;
        this.close();
      });
      return;
    }
    this.appendTextButton(actions, '保存并离开', () => { void this.saveAndLeave(); });
    const confirm = this.appendTextButton(
      actions,
      '确认并写入 Obsidian',
      () => { void this.confirm(); },
      true,
    );
    confirm.disabled = this.busy || this.persisting;
  }

  private addManualItem(): void {
    if (this.persisting || this.session.items.length >= 3) return;
    this.session = {
      ...this.session,
      items: [...this.session.items, createManualWeeklyCoachDraftItem(this.dependencies.createId())],
      noNewFocus: false,
    };
    this.validationIssues = [];
    this.changed();
    this.render();
  }

  private async send(): Promise<void> {
    if (this.busy || this.persisting) return;
    const answer = this.session.pendingInput.trim();
    if (answer === '') return;
    this.lastAnswer = answer;
    this.messages.push({ id: this.dependencies.createId(), role: 'user', text: answer });
    this.session = {
      ...this.session,
      topic: this.session.topic || answer,
      pendingInput: '',
      keyAnswers: [...this.session.keyAnswers, answer].slice(-8),
    };
    this.changed();
    await this.runCoach(answer);
  }

  private async retryCoach(): Promise<void> {
    if (this.busy || this.persisting || this.lastAnswer === '') return;
    this.error = '';
    this.coachFailure = null;
    await this.runCoach(this.lastAnswer);
  }

  private async runCoach(answer: string): Promise<void> {
    const controller = new AbortController();
    this.coachAbortController = controller;
    this.coachFailure = null;
    this.error = '';
    this.busy = true;
    this.elapsedSeconds = 0;
    this.coachProgress = { stage: 'collecting' };
    this.lastContextStatistics = null;
    this.startElapsedTimer(controller);
    this.render();

    const turn: WeeklyThinkingCoachTurn = {
      topic: this.session.topic,
      selectedSources: [...this.session.selectedSources],
      latestAnswer: answer,
      keyAnswers: [...this.session.keyAnswers],
      previousSummary: this.canReusePreviousSummary() && this.session.sessionSummary !== ''
        ? this.session.sessionSummary
        : null,
      draftItems: this.session.items.map((item) => ({
        ...item,
        fieldSources: { ...item.fieldSources },
        suggestions: { ...item.suggestions },
      })),
      deletedFocuses: this.session.deletedItems.map((item) => item.focusLabel),
      focusedItemId: this.session.focusedItemId,
      deferredTaskQuestions: this.session.deferredTaskQuestions.map((item) => ({ ...item })),
    };

    try {
      const result = await this.dependencies.runCoach(turn, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.coachAbortController !== controller || this.closed) return;
          this.coachProgress = progress;
          this.updateProgressDisplay();
        },
      });
      if (this.coachAbortController !== controller || controller.signal.aborted || this.closed) return;
      const merged = mergeWeeklyCoachDraftOperations(this.session, result.draftOperations, {
        nextId: this.dependencies.createId,
        focusedItemId: this.session.focusedItemId,
      });
      const withDeferred = mergeWeeklyCoachDeferredTaskQuestions(
        merged.draft,
        result.deferredTaskQuestions,
        {
          nextId: this.dependencies.createId,
          focusedItemId: this.session.focusedItemId,
        },
      );
      this.session = {
        ...withDeferred,
        sessionSummary: result.sessionSummary,
        pendingQuestion: result.nextQuestion ?? '',
        questionReason: result.questionReason ?? '',
        background: {
          facts: [...result.background.facts],
          assumptions: [...result.background.assumptions],
          gaps: [...result.background.gaps],
          sources: [...result.background.sources],
        },
      };
      this.messages.push({
        id: this.dependencies.createId(),
        role: 'assistant',
        text: result.assistantMessage,
        ...(result.nextQuestion === null ? {} : { question: result.nextQuestion }),
        ...(result.questionReason === null ? {} : { questionReason: result.questionReason }),
      });
      this.validationIssues = [];
      this.changed();
    } catch (error) {
      if (this.coachAbortController !== controller || this.closed) return;
      if (controller.signal.aborted || isAbortError(error)) {
        this.coachFailure = 'cancelled';
        this.error = '已停止 AI 整理，你的输入和上一版草稿仍然保留。';
      } else if (isTimeoutError(error)) {
        this.coachFailure = 'timeout';
        this.error = '等待已超时，已达到 3 分钟。你的输入和上一版草稿仍然保留。';
      } else if (isInvalidResultError(error)) {
        this.coachFailure = 'invalid';
        this.error = 'AI 返回内容无法使用，上一版草稿没有变化。';
      } else {
        this.coachFailure = 'unavailable';
        this.error = 'AI 暂时不可用。你可以重试，也可以继续人工整理。';
      }
    } finally {
      if (this.coachAbortController === controller) {
        this.coachAbortController = null;
        this.stopElapsedTimer();
        this.busy = false;
        if (!this.closed) this.render();
      }
    }
  }

  private stopCoach(): void {
    if (this.persisting || this.coachAbortController === null) return;
    this.abortActiveCoach();
    this.busy = false;
    this.coachFailure = 'cancelled';
    this.error = '已停止 AI 整理，你的输入和上一版草稿仍然保留。';
    this.render();
  }

  private async saveAndLeave(): Promise<void> {
    if (this.persisting || this.isConfirmed()) return;
    this.abortActiveCoach();
    this.busy = false;
    try {
      await this.persistSessionDraft();
      this.dependencies.onChanged();
      this.skipCloseSave = true;
      this.close();
    } catch {
      this.error = '草稿暂存失败，请稍后重试。';
      this.render();
    }
  }

  private async confirm(): Promise<void> {
    if (this.busy || this.persisting || this.isConfirmed()) return;
    if (this.dependencies.currentWeek() !== this.dependencies.week) {
      this.error = '已进入新的自然周，请保存后重新打开本周思考教练。';
      this.render();
      return;
    }
    if (!this.dependencies.canManageVault()) {
      this.error = 'Vault 管理权限已关闭，请在 ATL 设置中开启后再确认。';
      this.render();
      return;
    }
    const issues = validateWeeklyCoachSessionDraft(this.session);
    if (issues.length > 0) {
      this.validationIssues = issues;
      this.error = issues[0]?.message ?? '请补齐本周重点后再确认。';
      this.render();
      return;
    }

    this.persisting = true;
    this.error = '';
    this.render();
    try {
      const result = await this.dependencies.confirm(
        weeklyCoachDraftToFocusInput(this.session, this.currentRecord?.record.input),
        this.currentRecord?.raw ?? null,
      );
      this.currentRecord = result;
      this.saveStatus = '正式记录已确认';
      this.dirty = false;
      this.clearAutosaveTimer();
      this.dependencies.onChanged();
      try {
        await this.dependencies.clearSessionDraft();
      } catch {
        this.dependencies.notify('正式记录已确认，临时草稿清理失败');
      }
    } catch (error) {
      this.error = error instanceof Error && (
        error.message.includes('其他编辑') || error.message.includes('新的自然周')
      )
        ? error.message
        : '本周判断未能写入，请稍后重试。插件草稿仍然保留。';
    } finally {
      this.persisting = false;
      if (!this.closed) this.render();
    }
  }

  private changed(): void {
    this.session = {
      ...this.session,
      messages: this.messages.slice(-MAX_SESSION_MESSAGES).map((message) => ({ ...message })),
      updatedAt: this.dependencies.now().toISOString(),
    };
    this.dirty = true;
    this.mutationVersion += 1;
    this.saveStatus = '未保存';
    this.updateSaveStatus();
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    this.clearAutosaveTimer();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.persistSessionDraft().catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
  }

  private clearAutosaveTimer(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  private async persistSessionDraft(): Promise<void> {
    this.clearAutosaveTimer();
    const version = this.mutationVersion;
    this.saveStatus = '正在暂存';
    this.updateSaveStatus();
    try {
      await this.dependencies.saveSessionDraft(cloneSession(this.session));
      if (this.mutationVersion === version) {
        this.dirty = false;
        this.saveStatus = '刚刚暂存';
      } else {
        this.scheduleAutosave();
      }
    } catch (error) {
      this.saveStatus = '暂存失败';
      throw error;
    } finally {
      this.updateSaveStatus();
    }
  }

  private updateSaveStatus(): void {
    const element = this.contentEl.querySelector<HTMLElement>('.atl-weekly-coach-save-status');
    if (element !== null) element.textContent = this.saveStatus;
  }

  private startElapsedTimer(controller: AbortController): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (this.coachAbortController !== controller || this.closed) return;
      this.elapsedSeconds = Math.min(this.elapsedSeconds + 1, COACH_TIMEOUT_SECONDS);
      this.updateProgressDisplay();
    }, 1_000);
    this.deadlineTimer = setTimeout(() => this.timeoutCoach(controller), COACH_TIMEOUT_SECONDS * 1_000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private timeoutCoach(controller: AbortController): void {
    if (this.coachAbortController !== controller || this.closed) return;
    this.coachAbortController = null;
    this.stopElapsedTimer();
    controller.abort();
    this.busy = false;
    this.coachFailure = 'timeout';
    this.error = '等待已超时，已达到 3 分钟。你的输入和上一版草稿仍然保留。';
    this.render();
  }

  private abortActiveCoach(): void {
    const controller = this.coachAbortController;
    this.coachAbortController = null;
    this.stopElapsedTimer();
    controller?.abort();
  }

  private progressLabel(): string {
    if (this.coachProgress.stage === 'collecting') return '正在读取授权资料';
    if (this.coachProgress.stage === 'context_ready') return '授权资料已准备完成';
    if (this.coachProgress.stage === 'model_started') return '模型已启动，正在思考';
    return '正在整理回复与草稿';
  }

  private contextStatistics(): string {
    if (this.coachProgress.stage === 'collecting') return '';
    if (this.coachProgress.stage === 'model_started' || this.coachProgress.stage === 'parsing') {
      return this.lastContextStatistics ?? '授权资料已准备完成';
    }
    const statistics = `${this.coachProgress.sourceCount} 类 · ${this.coachProgress.documentCount} 篇 · ${new Intl.NumberFormat('zh-CN').format(this.coachProgress.totalCharacters)} 字`;
    this.lastContextStatistics = statistics;
    return statistics;
  }

  private formatElapsed(seconds: number): string {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const remaining = (seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remaining}`;
  }

  private updateProgressDisplay(): void {
    const progress = this.contentEl.querySelector<HTMLElement>('.atl-weekly-coach-progress');
    if (progress === null) return;
    const label = progress.querySelector<HTMLElement>('.atl-weekly-coach-progress-label');
    const statistics = progress.querySelector<HTMLElement>('.atl-weekly-coach-progress-statistics');
    const elapsed = progress.querySelector<HTMLElement>('.atl-weekly-coach-progress-elapsed');
    const slowNotice = progress.querySelector<HTMLElement>('.atl-weekly-coach-slow-notice');
    if (label !== null) label.textContent = this.progressLabel();
    if (statistics !== null) {
      statistics.textContent = this.contextStatistics();
      statistics.hidden = statistics.textContent === '';
    }
    if (elapsed !== null) {
      elapsed.textContent = `${this.formatElapsed(this.elapsedSeconds)} / 最长 03:00`;
    }
    if (slowNotice !== null) {
      const isSlow = this.elapsedSeconds >= SLOW_RESPONSE_SECONDS;
      slowNotice.hidden = !isSlow;
      slowNotice.textContent = isSlow
        ? '响应比平时慢，你可以继续等待，也可以停止后人工整理。'
        : '';
    }
  }

  private sourceSummary(): string {
    const count = this.session.selectedSources.length;
    return `${count === 0 ? '未选择资料' : `已选 ${count} 类`} · 敏感资料单次授权`;
  }

  private captureConversationScroll(): void {
    const conversation = this.contentEl.querySelector<HTMLElement>(
      '.atl-weekly-coach-conversation',
    );
    if (conversation === null) return;
    this.conversationScrollTop = conversation.scrollTop;
    const distanceFromBottom = conversation.scrollHeight
      - conversation.clientHeight
      - conversation.scrollTop;
    this.conversationAutoFollow = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
  }

  private attachConversationScroll(conversation: HTMLElement): void {
    conversation.scrollTop = this.conversationAutoFollow
      ? conversation.scrollHeight
      : this.conversationScrollTop;
    const updateScrollState = (): void => {
      this.conversationScrollTop = conversation.scrollTop;
      const distanceFromBottom = conversation.scrollHeight
        - conversation.clientHeight
        - conversation.scrollTop;
      this.conversationAutoFollow = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
      const action = conversation.querySelector<HTMLButtonElement>(
        '.atl-weekly-coach-scroll-latest',
      );
      if (action !== null) action.hidden = this.conversationAutoFollow;
    };
    conversation.addEventListener('scroll', updateScrollState, { passive: true });
    const action = conversation.querySelector<HTMLButtonElement>(
      '.atl-weekly-coach-scroll-latest',
    );
    if (action !== null) action.hidden = this.conversationAutoFollow;
  }

  private scrollConversationToLatest(conversation: HTMLElement): void {
    this.conversationAutoFollow = true;
    conversation.scrollTop = conversation.scrollHeight;
    this.conversationScrollTop = conversation.scrollTop;
    const action = conversation.querySelector<HTMLButtonElement>(
      '.atl-weekly-coach-scroll-latest',
    );
    if (action !== null) action.hidden = true;
  }

  private canReusePreviousSummary(): boolean {
    return [...this.priorSensitiveSources].every((source) => (
      this.session.selectedSources.includes(source)
    ));
  }

  private isConfirmed(): boolean {
    return this.currentRecord?.record.status === '已确认';
  }

  private appendTextButton(
    container: HTMLElement,
    label: string,
    onClick: () => void,
    primary = false,
  ): HTMLButtonElement {
    const button = container.createEl('button', {
      cls: primary ? 'mod-cta' : '',
      text: label,
      type: 'button',
      attr: { 'aria-label': label },
    });
    button.disabled = this.persisting;
    button.addEventListener('click', () => {
      if (this.persisting) return;
      onClick();
    });
    return button;
  }

  private appendIconButton(
    container: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = container.createEl('button', {
      cls: 'clickable-icon',
      type: 'button',
      attr: { 'aria-label': label, title: label },
    });
    setIcon(button, icon);
    button.disabled = this.persisting;
    button.addEventListener('click', () => {
      if (this.persisting) return;
      onClick();
    });
    return button;
  }
}
