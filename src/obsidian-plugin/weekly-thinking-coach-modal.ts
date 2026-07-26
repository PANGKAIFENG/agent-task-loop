import { App, Modal } from 'obsidian';

import type { WeeklyCoachSource } from '../services/weekly-coach-context.js';
import { WEEKLY_COACH_SOURCES } from '../services/weekly-coach-context.js';
import type {
  WeeklyFocusDocument,
  WeeklyFocusInput,
  WeeklyFocusItem,
} from '../services/weekly-focus.js';
import type { WeeklyCoachResult } from './weekly-thinking-coach.js';

const DEFAULT_SOURCES: WeeklyCoachSource[] = ['目标', '项目', '任务', '日历', '周复盘'];
const SENSITIVE_SOURCES = new Set<WeeklyCoachSource>(['笔记同步助手', '每日所思']);

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
  runCoach(input: WeeklyThinkingCoachTurn): Promise<WeeklyCoachResult>;
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

function emptyFocus(problem = ''): WeeklyFocusItem {
  return { problem, judgment: '', outcome: '', evidence: '', commitment: '' };
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
      const loading = container.createDiv({ cls: 'atl-weekly-coach-loading' });
      loading.createEl('strong', { text: '正在整理背景' });
      loading.createEl('p', { text: '教练正在区分事实、推测和仍需补充的信息。' });
      return;
    }

    if (this.coachResult === null && this.error !== '') {
      const failure = container.createDiv({ cls: 'atl-weekly-coach-failure' });
      failure.createEl('h3', { text: 'AI 暂时不可用' });
      failure.createEl('p', { text: '你的输入仍保留，可以重试，也可以直接人工整理。' });
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
    const actions = container.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '调整本次授权', () => {
      this.view = 'start';
      this.message = '';
      this.render();
    });
    if (this.input.currentQuestion !== '') {
      this.appendButton(actions, '回答并继续', () => { void this.runCoach(); });
    } else {
      this.appendButton(actions, '重新整理背景', () => { void this.runCoach(); });
    }
    this.appendButton(actions, '整理我的判断', () => this.openOrganizer(), true);
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
    this.appendTextArea(card, `第${index + 1}项真正想解决的问题`, focus.problem, '', (value) => {
      focus.problem = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项用户最终判断`, focus.judgment, '', (value) => {
      focus.judgment = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项希望产生的结果`, focus.outcome, '', (value) => {
      focus.outcome = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项验证证据`, focus.evidence, '', (value) => {
      focus.evidence = value;
    }, 2);
    this.appendTextArea(card, `第${index + 1}项本周承诺`, focus.commitment, '', (value) => {
      focus.commitment = value;
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
      card.createEl('strong', { text: focus.judgment });
      card.createEl('p', { text: `${focus.problem} · ${focus.outcome}` });
    }
    const actions = container.createDiv({ cls: 'atl-weekly-coach-actions' });
    this.appendButton(actions, '打开 Markdown', () => {
      void this.dependencies.openRecord(document.path);
    }, true);
  }

  private async runCoach(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.message = '';
    this.view = 'coaching';
    this.markDirty();
    const answer = this.latestAnswer.trim();
    if (answer !== '') this.input.keyAnswers.push(answer);
    this.latestAnswer = '';
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
      });
      if (this.closed) return;
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
    } catch {
      if (this.closed) return;
      this.coachResult = null;
      this.error = 'AI 暂时不可用。你的输入没有丢失。';
    } finally {
      this.busy = false;
      if (!this.closed) this.render();
    }
  }

  private openOrganizer(): void {
    if (this.input.focuses.length === 0 && !this.input.noNewFocus) {
      const draft = this.coachResult?.organizedDraft;
      this.input.focuses = [draft === null || draft === undefined
        ? emptyFocus(this.input.conversationTopic)
        : {
          problem: draft.problem,
          judgment: '',
          outcome: draft.outcome,
          evidence: draft.evidence,
          commitment: draft.commitment,
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
  ): HTMLButtonElement {
    const button = container.createEl('button', primary
      ? { cls: 'mod-cta', text: label, type: 'button' }
      : { text: label, type: 'button' });
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
