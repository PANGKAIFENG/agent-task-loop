import { App, Modal } from 'obsidian';

import type { WeeklyCoachSource } from '../services/weekly-coach-context.js';
import { WEEKLY_COACH_SOURCES } from '../services/weekly-coach-context.js';
import type {
  WeeklyFocusDocument,
  WeeklyFocusInput,
  WeeklyFocusItem,
} from '../services/weekly-focus.js';
import type {
  WeeklyCoachResult,
  WeeklyThinkingCoachProgress,
  WeeklyThinkingCoachRunControl,
} from './weekly-thinking-coach.js';

const DEFAULT_SOURCES: WeeklyCoachSource[] = ['目标', '项目', '任务', '日历', '周复盘'];
const SENSITIVE_SOURCES = new Set<WeeklyCoachSource>(['笔记同步助手', '每日所思']);
const COACH_TIMEOUT_SECONDS = 180;
const SLOW_RESPONSE_SECONDS = 45;

type CoachView = 'loading' | 'start' | 'coaching' | 'organize' | 'confirmed';

export interface WeeklyThinkingCoachTurn {
  topic: string;
  selectedSources: WeeklyCoachSource[];
  latestAnswer: string;
  keyAnswers: string[];
  previousSummary: string | null;
}

export type WeeklyThinkingCoachResult = WeeklyFocusDocument;

export interface WeeklyThinkingCoachModalDependencies {
  week: string;
  modelLabel: string;
  load(): Promise<WeeklyFocusDocument | null>;
  runCoach(
    input: WeeklyThinkingCoachTurn,
    control: WeeklyThinkingCoachRunControl,
  ): Promise<WeeklyCoachResult>;
  saveDraft(
    input: WeeklyFocusInput,
    expectedContent: string | null,
  ): Promise<WeeklyThinkingCoachResult>;
  confirm(
    input: WeeklyFocusInput,
    expectedContent: string | null,
  ): Promise<WeeklyThinkingCoachResult>;
  canManageVault(): boolean;
  onChanged(result: WeeklyThinkingCoachResult): void;
  openRecord(path: string): Promise<void>;
  notify(message: string): void;
}

type CoachProgress =
  | { stage: 'collecting' }
  | WeeklyThinkingCoachProgress;

type CoachFailure = 'timeout' | 'unavailable' | null;

function emptyInput(): WeeklyFocusInput {
  return {
    conversationTopic: '',
    selectedSources: [...DEFAULT_SOURCES],
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
  };
}

function cloneInput(input: WeeklyFocusInput): WeeklyFocusInput {
  return {
    ...input,
    selectedSources: [...input.selectedSources],
    focuses: input.focuses.map((focus) => ({ ...focus })),
    notDoing: [...input.notDoing],
    background: {
      facts: [...input.background.facts],
      assumptions: [...input.background.assumptions],
      gaps: [...input.background.gaps],
      sources: [...input.background.sources],
    },
    coachInsights: [...input.coachInsights],
    consideredDirections: [...input.consideredDirections],
    keyAnswers: [...input.keyAnswers],
    linkedGoals: [...input.linkedGoals],
    linkedTasks: [...input.linkedTasks],
  };
}

function emptyFocus(focus = ''): WeeklyFocusItem {
  return { focus, outcome: '', whyThisWeek: '', evidence: '' };
}

function lines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

export class WeeklyThinkingCoachModal extends Modal {
  private view: CoachView = 'loading';
  private input = emptyInput();
  private currentDocument: WeeklyFocusDocument | null = null;
  private coachResult: WeeklyCoachResult | null = null;
  private latestAnswer = '';
  private message = '';
  private error = '';
  private busy = false;
  private persisting = false;
  private dirty = false;
  private finalized = false;
  private closed = false;
  private priorSensitiveSources = new Set<WeeklyCoachSource>();
  private coachProgress: CoachProgress = { stage: 'collecting' };
  private lastContextStatistics: string | null = null;
  private coachFailure: CoachFailure = null;
  private coachAbortController: AbortController | null = null;
  private elapsedSeconds = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    app: App,
    private readonly dependencies: WeeklyThinkingCoachModalDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.closed = false;
    this.finalized = false;
    this.modalEl.classList.add('atl-weekly-coach-modal');
    this.contentEl.classList.add('atl-weekly-coach-content');
    this.render();
    void this.load();
  }

  override onClose(): void {
    this.closed = true;
    this.abortActiveCoach();
    if (
      !this.finalized
      && !this.persisting
      && this.dirty
      && this.currentDocument?.record.status !== '已确认'
      && this.dependencies.canManageVault()
    ) {
      void this.dependencies.saveDraft(
        cloneInput(this.input),
        this.currentDocument?.raw ?? null,
      ).then((result) => {
        this.dependencies.onChanged(result);
      }).catch(() => {
        this.dependencies.notify('草稿自动保存失败，请重新打开本周思考后手动保存。');
      });
    }
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      const loaded = await this.dependencies.load();
      if (this.closed) return;
      this.currentDocument = loaded;
      if (loaded === null) {
        this.input = emptyInput();
        this.priorSensitiveSources.clear();
        this.view = 'start';
      } else {
        this.input = cloneInput(loaded.record.input);
        this.priorSensitiveSources = new Set(
          this.input.selectedSources.filter((source) => SENSITIVE_SOURCES.has(source)),
        );
        this.input.selectedSources = this.input.selectedSources.filter((source) => (
          !SENSITIVE_SOURCES.has(source)
        ));
        this.view = loaded.record.status === '已确认' ? 'confirmed' : 'coaching';
      }
    } catch {
      if (this.closed) return;
      this.input = emptyInput();
      this.view = 'start';
      this.error = '本周记录暂时无法读取，你仍可先开始思考。';
    }
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.modalEl.classList.toggle('atl-weekly-coach-modal--busy', this.busy);
    if (this.view === 'loading') {
      this.contentEl.createDiv({ cls: 'atl-weekly-coach-loading', text: '正在读取本周判断...' });
      return;
    }
    this.renderHeader();
    const body = this.contentEl.createDiv({ cls: 'atl-weekly-coach-body' });
    if (this.error !== '') {
      body.createDiv({ cls: 'atl-form-error atl-form-error-summary', text: this.error });
    }
    if (this.message !== '') {
      body.createDiv({ cls: 'atl-weekly-coach-message', text: this.message });
    }
    if (this.view === 'start') this.renderStart(body);
    if (this.view === 'coaching') this.renderCoaching(body);
    if (this.view === 'organize') this.renderOrganize(body);
    if (this.view === 'confirmed') this.renderConfirmed(body);
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: 'atl-weekly-coach-header' });
    const title = header.createDiv({ cls: 'atl-weekly-coach-title' });
    title.createEl('h2', {
      text: this.view === 'confirmed'
        ? '查看本周判断'
        : this.currentDocument === null ? '梳理本周重点' : '继续本周思考',
    });
    title.createEl('p', {
      text: 'AI 负责启发与整理，最终判断始终由你确认。',
    });
    const meta = header.createDiv({ cls: 'atl-weekly-coach-meta' });
    meta.createEl('span', { text: this.dependencies.week });
    meta.createEl('span', { text: this.dependencies.modelLabel });
  }

  private renderStart(container: HTMLElement): void {
    const intro = container.createDiv({ cls: 'atl-weekly-coach-intro' });
    intro.createEl('h3', { text: '从一个困惑开始' });
    intro.createEl('p', {
      text: '可以写一个正在犹豫的方向，也可以留空，让教练从你授权的资料开始。',
    });
    this.appendTextArea(
      intro,
      '本周想讨论的问题',
      this.input.conversationTopic,
      '例如：这周是否值得收敛产品边界？',
      (value) => { this.input.conversationTopic = value; },
      4,
    );

    const sourceSection = container.createDiv({ cls: 'atl-weekly-coach-sources' });
    sourceSection.createEl('h3', { text: '选择本次允许读取的资料' });
    sourceSection.createEl('p', {
      text: '只读取本次勾选的范围；笔记同步助手和每日所思默认不授权。',
    });
    const sourceGrid = sourceSection.createDiv({ cls: 'atl-weekly-coach-source-grid' });
    for (const source of WEEKLY_COACH_SOURCES) {
      const label = sourceGrid.createEl('label', { cls: 'atl-weekly-coach-source' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.setAttribute('aria-label', `授权${source}`);
      checkbox.checked = this.input.selectedSources.includes(source);
      checkbox.addEventListener('change', () => {
        this.input.selectedSources = checkbox.checked
          ? [...new Set([...this.input.selectedSources, source])]
          : this.input.selectedSources.filter((item) => item !== source);
        this.markDirty();
      });
      const copy = label.createDiv();
      copy.createEl('strong', { text: source });
      if (SENSITIVE_SOURCES.has(source)) copy.createEl('small', { text: '每次单独授权' });
    }

    const actions = container.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '直接人工整理', () => this.openOrganizer());
    this.appendButton(actions, '确认并开始', () => { void this.runCoach(); }, true);
  }

  private renderCoaching(container: HTMLElement): void {
    if (this.busy) {
      this.renderCoachProgress(container);
      return;
    }

    if (this.error !== '') {
      const failure = container.createDiv({ cls: 'atl-weekly-coach-failure' });
      failure.createEl('h3', {
        text: this.coachFailure === 'timeout' ? '等待已超时' : 'AI 暂时不可用',
      });
      failure.createEl('p', {
        text: this.coachFailure === 'timeout'
          ? '本次等待已达到 3 分钟。你的输入仍保留，可以重试或转为人工整理。'
          : '你的输入仍保留，可以重试，也可以直接人工整理。',
      });
      const actions = failure.createDiv({ cls: 'atl-weekly-coach-actions' });
      this.appendButton(actions, '重新尝试', () => { void this.runCoach(); });
      this.appendButton(actions, '直接人工整理', () => this.openOrganizer(), true);
      return;
    }

    if (this.input.currentQuestion === '') {
      const resume = container.createDiv({ cls: 'atl-weekly-coach-question' });
      resume.createEl('h3', { text: '继续本周思考' });
      resume.createEl('p', { text: '可以继续让教练整理背景，也可以直接编辑本周判断。' });
    } else {
      const question = container.createDiv({ cls: 'atl-weekly-coach-question' });
      question.createEl('span', { cls: 'atl-weekly-coach-eyebrow', text: '当前最值得想清楚的问题' });
      question.createEl('h3', { text: this.input.currentQuestion });
      if (this.coachResult?.questionReason !== undefined) {
        question.createEl('p', { text: this.coachResult.questionReason });
      }
      this.appendTextArea(
        question,
        '回答当前问题',
        this.latestAnswer,
        '写下你的判断、约束或还不确定的地方',
        (value) => { this.latestAnswer = value; },
        4,
      );
    }

    this.renderBackground(container);
    this.renderDirections(container);
    const resultActions = container.createDiv({ cls: 'atl-weekly-coach-result-actions' });
    const scopeAction = resultActions.createDiv({ cls: 'atl-weekly-coach-scope-action' });
    scopeAction.createEl('span', { text: '想调整资料来源？' });
    this.appendButton(scopeAction, '修改 AI 读取范围', () => {
      this.view = 'start';
      this.message = '';
      this.render();
    });
    const choices = resultActions.createDiv({ cls: 'atl-weekly-coach-choice-grid' });
    if (this.input.currentQuestion !== '') {
      this.appendCoachChoice(
        choices,
        '提交回答，继续讨论',
        'AI 会结合当前回答再分析一轮，不会写入 Obsidian',
        () => { void this.runCoach(); },
      );
    } else {
      this.appendCoachChoice(
        choices,
        '让 AI 再分析一轮',
        '重新整理当前背景与方向，不会写入 Obsidian',
        () => { void this.runCoach(); },
      );
    }
    this.appendCoachChoice(
      choices,
      '结束讨论，进入确认',
      '把当前建议整理成可编辑清单，下一步确认后才写入 Obsidian',
      () => this.openOrganizer(),
      true,
    );
  }

  private renderCoachProgress(container: HTMLElement): void {
    const progress = container.createDiv({ cls: 'atl-weekly-coach-progress' });
    const heading = progress.createDiv({ cls: 'atl-weekly-coach-progress-heading' });
    heading.createEl('strong', { text: '正在准备本周教练建议' });
    heading.createEl('span', {
      text: `${this.formatElapsed(this.elapsedSeconds)} / 最长 03:00`,
    });

    const stage = this.progressStageNumber();
    const steps = progress.createDiv({ cls: 'atl-weekly-coach-progress-steps' });
    this.appendProgressStep(
      steps,
      1,
      stage,
      stage > 1 ? '已读取授权资料' : '正在读取授权资料',
      this.coachProgress.stage === 'collecting'
        ? '从本次允许读取的范围中准备背景'
        : this.contextStatistics(),
    );
    this.appendProgressStep(
      steps,
      2,
      stage,
      stage > 2 ? 'Claude Code 已启动' : '正在启动 Claude Code',
      this.dependencies.modelLabel,
    );
    this.appendProgressStep(
      steps,
      3,
      stage,
      stage > 3 ? '教练整理已完成' : '正在等待教练整理',
      '正在区分事实、推测、信息缺口与可考虑方向',
    );
    this.appendProgressStep(
      steps,
      4,
      stage,
      '解析并展示结果',
      '把结构化结果转换为可继续讨论的界面',
    );

    if (this.elapsedSeconds >= SLOW_RESPONSE_SECONDS) {
      progress.createDiv({
        cls: 'atl-weekly-coach-slow-notice',
        text: '响应比平时慢，但仍在 3 分钟等待范围内。你可以继续等待，或转为人工整理。',
      });
    }

    const actions = progress.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '停止等待', () => this.stopCoach(false), false, true);
    this.appendButton(actions, '转为人工整理', () => this.stopCoach(true), false, true);
  }

  private appendProgressStep(
    container: HTMLElement,
    step: number,
    activeStep: number,
    label: string,
    detail: string,
  ): void {
    const status = step < activeStep ? 'complete' : step === activeStep ? 'active' : 'pending';
    const row = container.createDiv({
      cls: `atl-weekly-coach-progress-step is-${status}`,
    });
    row.createEl('span', {
      cls: 'atl-weekly-coach-progress-marker',
      text: status === 'complete' ? '✓' : status === 'active' ? '●' : '○',
    });
    const copy = row.createDiv();
    copy.createEl('strong', { text: label });
    copy.createEl('small', { text: detail });
  }

  private renderBackground(container: HTMLElement): void {
    const background = this.input.background;
    if (
      background.facts.length === 0
      && background.assumptions.length === 0
      && background.gaps.length === 0
      && background.sources.length === 0
    ) return;
    const details = container.createEl('details', { cls: 'atl-weekly-coach-background' });
    details.open = true;
    details.createEl('summary', { text: '背景与判断依据' });
    const grid = details.createDiv({ cls: 'atl-weekly-coach-background-grid' });
    this.appendList(grid, '已确认事实', background.facts);
    this.appendList(grid, '仍是推测', background.assumptions);
    this.appendList(grid, '关键信息缺口', background.gaps);
    this.appendList(grid, '资料来源', background.sources);
  }

  private renderDirections(container: HTMLElement): void {
    if (this.coachResult?.directions.length === 0 || this.coachResult === null) return;
    const section = container.createDiv({ cls: 'atl-weekly-coach-directions' });
    section.createEl('h3', { text: '可考虑方向' });
    for (const direction of this.coachResult.directions) {
      const item = section.createDiv({ cls: 'atl-weekly-coach-direction' });
      item.createEl('strong', { text: direction.title });
      item.createEl('p', { text: direction.rationale });
      item.createEl('small', { text: `代价：${direction.tradeoff} · 验证：${direction.validation}` });
    }
  }

  private renderOrganize(container: HTMLElement): void {
    const notice = container.createDiv({ cls: 'atl-weekly-coach-organize-notice' });
    notice.createEl('strong', { text: '这是对你表达的整理，不是 AI 替你决定' });
    notice.createEl('p', { text: '可确认 0 至 3 项。确认前所有字段都可以修改。' });

    const noFocusLabel = container.createEl('label', { cls: 'atl-weekly-coach-no-focus' });
    const noFocus = noFocusLabel.createEl('input', { type: 'checkbox' });
    noFocus.setAttribute('aria-label', '本周暂不新增重点');
    noFocus.checked = this.input.noNewFocus;
    noFocus.addEventListener('change', () => {
      this.input.noNewFocus = noFocus.checked;
      if (noFocus.checked) this.input.focuses = [];
      this.markDirty();
      this.render();
    });
    noFocusLabel.createEl('span', { text: '本周暂不新增重点，先完成既有承诺' });

    if (!this.input.noNewFocus) {
      const focusList = container.createDiv({ cls: 'atl-weekly-coach-focus-list' });
      for (const [index, focus] of this.input.focuses.entries()) {
        this.renderFocusEditor(focusList, focus, index);
      }
      if (this.input.focuses.length < 3) {
        this.appendButton(focusList, '添加一项判断', () => {
          this.input.focuses.push(emptyFocus());
          this.markDirty();
          this.render();
        });
      }
    }

    this.appendTextArea(
      container,
      '本周不做',
      this.input.notDoing.join('\n'),
      '每行一项，明确本周主动不投入什么',
      (value) => { this.input.notDoing = lines(value); },
      3,
    );

    const actions = container.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '继续讨论', () => {
      this.view = 'coaching';
      this.message = '';
      this.render();
    });
    this.appendButton(actions, '保存草稿', () => { void this.persist(false); });
    this.appendButton(actions, '确认本周判断', () => { void this.persist(true); }, true);
  }

  private renderFocusEditor(
    container: HTMLElement,
    focus: WeeklyFocusItem,
    index: number,
  ): void {
    const card = container.createDiv({ cls: 'atl-weekly-coach-focus-editor' });
    const heading = card.createDiv({ cls: 'atl-weekly-coach-focus-heading' });
    heading.createEl('strong', { text: `本周判断 ${index + 1}` });
    if (this.input.focuses.length > 1) {
      this.appendButton(heading, '移除', () => {
        this.input.focuses.splice(index, 1);
        this.markDirty();
        this.render();
      });
    }
    this.appendTextArea(card, `第${index + 1}项重点事项`, focus.focus, '', (value) => {
      focus.focus = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项预期结果`, focus.outcome, '', (value) => {
      focus.outcome = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项为什么是本周`, focus.whyThisWeek, '', (value) => {
      focus.whyThisWeek = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项完成证据`, focus.evidence, '', (value) => {
      focus.evidence = value;
    }, 2);
  }

  private renderConfirmed(container: HTMLElement): void {
    const document = this.currentDocument;
    if (document === null) return;
    const intro = container.createDiv({ cls: 'atl-weekly-coach-confirmed' });
    intro.createEl('h3', { text: '这是你确认的本周判断' });
    intro.createEl('p', { text: '你可以在周末复盘时用这份记录对照实际结果。' });
    if (this.input.noNewFocus && this.input.focuses.length === 0) {
      intro.createDiv({ cls: 'atl-weekly-coach-empty-decision', text: '本周暂不新增重点，先完成既有承诺。' });
    }
    for (const [index, focus] of this.input.focuses.entries()) {
      const card = intro.createDiv({ cls: 'atl-weekly-coach-confirmed-focus' });
      card.createEl('span', { text: `判断 ${index + 1}` });
      card.createEl('strong', { text: focus.focus });
      card.createEl('p', { text: `${focus.outcome} · ${focus.whyThisWeek}` });
    }
    const actions = container.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '打开 Markdown', () => {
      void this.dependencies.openRecord(document.path);
    }, true);
  }

  private async runCoach(): Promise<void> {
    if (this.busy) return;
    const controller = new AbortController();
    this.coachAbortController = controller;
    this.coachProgress = { stage: 'collecting' };
    this.lastContextStatistics = null;
    this.coachFailure = null;
    this.elapsedSeconds = 0;
    this.busy = true;
    this.error = '';
    this.message = '';
    this.view = 'coaching';
    this.markDirty();
    const answer = this.latestAnswer.trim();
    if (answer !== '') this.input.keyAnswers.push(answer);
    this.latestAnswer = '';
    this.startElapsedTimer(controller);
    this.render();
    try {
      const result = await this.dependencies.runCoach({
        topic: this.input.conversationTopic,
        selectedSources: [...this.input.selectedSources],
        latestAnswer: answer,
        keyAnswers: [...this.input.keyAnswers],
        previousSummary: this.canReusePreviousSummary()
          ? this.input.coachSummary || null
          : null,
      }, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (
            this.closed
            || controller.signal.aborted
            || this.coachAbortController !== controller
          ) return;
          this.coachProgress = progress;
          this.render();
        },
      });
      if (this.closed || controller.signal.aborted) return;
      this.coachResult = result;
      this.input.background = {
        facts: [...result.background.facts],
        assumptions: [...result.background.assumptions],
        gaps: [...result.background.gaps],
        sources: [...result.background.sources],
      };
      this.input.currentQuestion = result.currentQuestion;
      this.input.coachSummary = result.summary;
      this.input.coachInsights = [
        ...this.input.coachInsights,
        `${result.currentQuestion}（${result.questionReason}）`,
      ];
      this.input.consideredDirections = result.directions.map((direction) => (
        `${direction.title}：${direction.rationale}；代价：${direction.tradeoff}；验证：${direction.validation}`
      ));
      this.priorSensitiveSources = new Set(
        this.input.selectedSources.filter((source) => SENSITIVE_SOURCES.has(source)),
      );
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      this.coachResult = null;
      this.coachFailure = this.isTimeoutError(error) ? 'timeout' : 'unavailable';
      this.error = this.coachFailure === 'timeout'
        ? '等待已超过 3 分钟。你的输入没有丢失。'
        : 'AI 暂时不可用。你的输入没有丢失。';
    } finally {
      if (this.coachAbortController === controller) {
        this.coachAbortController = null;
        this.stopElapsedTimer();
        this.busy = false;
        if (!this.closed) this.render();
      }
    }
  }

  private stopCoach(openManualOrganizer: boolean): void {
    if (this.coachAbortController === null) return;
    this.abortActiveCoach();
    this.busy = false;
    this.coachFailure = null;
    if (openManualOrganizer) {
      this.openOrganizer();
      return;
    }
    this.view = 'start';
    this.message = '已停止 AI 整理，你的输入仍保留。';
    this.render();
  }

  private abortActiveCoach(): void {
    const controller = this.coachAbortController;
    this.coachAbortController = null;
    this.stopElapsedTimer();
    controller?.abort();
  }

  private startElapsedTimer(controller: AbortController): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (!this.busy || this.closed) return;
      this.elapsedSeconds = Math.min(this.elapsedSeconds + 1, COACH_TIMEOUT_SECONDS);
      this.render();
    }, 1_000);
    this.deadlineTimer = setTimeout(() => {
      this.timeoutCoach(controller);
    }, COACH_TIMEOUT_SECONDS * 1_000);
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
    this.coachFailure = 'timeout';
    this.error = '等待已超过 3 分钟。你的输入没有丢失。';
    this.busy = false;
    this.render();
  }

  private progressStageNumber(): number {
    if (this.coachProgress.stage === 'collecting') return 1;
    if (this.coachProgress.stage === 'context_ready') return 2;
    if (this.coachProgress.stage === 'model_started') return 3;
    return 4;
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

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error
      && 'code' in error
      && (error as Error & { code?: unknown }).code === 'claude_timeout';
  }

  private openOrganizer(): void {
    if (this.input.focuses.length === 0 && !this.input.noNewFocus) {
      const draft = this.coachResult?.organizedDraft;
      this.input.focuses = [draft === null || draft === undefined
        ? emptyFocus(this.input.conversationTopic)
        : {
          focus: draft.problem,
          outcome: draft.outcome,
          whyThisWeek: draft.commitment,
          evidence: draft.evidence,
        }];
      if (draft !== null && draft !== undefined) this.input.notDoing = [...draft.notDoing];
    }
    this.view = 'organize';
    this.error = '';
    this.message = '';
    this.markDirty();
    this.render();
  }

  private async persist(confirmed: boolean): Promise<void> {
    if (this.busy) return;
    if (!this.dependencies.canManageVault()) {
      this.error = 'Vault 管理权限已关闭，请在 ATL 设置中开启后再保存。';
      this.render();
      return;
    }
    this.busy = true;
    this.persisting = true;
    this.error = '';
    const expected = this.currentDocument?.raw ?? null;
    try {
      const result = confirmed
        ? await this.dependencies.confirm(cloneInput(this.input), expected)
        : await this.dependencies.saveDraft(cloneInput(this.input), expected);
      this.currentDocument = result;
      this.input = cloneInput(result.record.input);
      this.dirty = false;
      this.dependencies.onChanged(result);
      if (confirmed) {
        this.finalized = true;
        this.close();
        return;
      }
      this.message = '草稿已保存';
    } catch (error) {
      this.error = error instanceof Error && error.message.includes('其他编辑')
        ? error.message
        : confirmed
          ? '本周判断未能确认，请检查必填内容后重试。'
          : '草稿保存失败，请稍后重试。';
    } finally {
      this.persisting = false;
      this.busy = false;
      if (!this.closed) this.render();
    }
  }

  private appendTextArea(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
    rows: number,
  ): HTMLTextAreaElement {
    const field = container.createEl('label', { cls: 'atl-weekly-coach-field' });
    field.createEl('span', { text: label });
    const textarea = field.createEl('textarea');
    textarea.rows = rows;
    textarea.value = value;
    textarea.placeholder = placeholder;
    textarea.setAttribute('aria-label', label);
    textarea.addEventListener('input', () => {
      onChange(textarea.value);
      this.markDirty();
    });
    return textarea;
  }

  private appendList(container: HTMLElement, title: string, values: readonly string[]): void {
    const section = container.createDiv({ cls: 'atl-weekly-coach-background-section' });
    section.createEl('strong', { text: title });
    if (values.length === 0) {
      section.createEl('p', { text: '暂无' });
      return;
    }
    const list = section.createEl('ul');
    for (const value of values) list.createEl('li', { text: value });
  }

  private appendButton(
    container: HTMLElement,
    label: string,
    onClick: () => void,
    primary = false,
    allowWhileBusy = false,
  ): HTMLButtonElement {
    const button = container.createEl('button', primary
      ? { cls: 'mod-cta', text: label, type: 'button' }
      : { text: label, type: 'button' });
    button.disabled = this.busy && !allowWhileBusy;
    button.addEventListener('click', onClick);
    return button;
  }

  private appendCoachChoice(
    container: HTMLElement,
    label: string,
    description: string,
    onClick: () => void,
    primary = false,
  ): HTMLButtonElement {
    const button = container.createEl('button', {
      cls: primary ? 'atl-weekly-coach-choice mod-cta' : 'atl-weekly-coach-choice',
      type: 'button',
    });
    button.createEl('strong', { text: label });
    button.createEl('small', { text: description });
    button.setAttribute('aria-label', label);
    button.disabled = this.busy;
    button.addEventListener('click', onClick);
    return button;
  }

  private markDirty(): void {
    this.dirty = true;
    this.message = '';
  }

  private canReusePreviousSummary(): boolean {
    return [...this.priorSensitiveSources].every((source) => (
      this.input.selectedSources.includes(source)
    ));
  }
}
