import {
  App,
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  setIcon,
  setTooltip,
} from 'obsidian';

import type { Task } from '../domain/task.js';
import type { DispatchOutcome } from '../services/dispatch-development-task.js';
import type { PreparedConfirmation } from './confirmation-controller.js';
import {
  ConfirmationController,
  InvalidConfirmationFormError,
} from './confirmation-controller.js';
import { renderDevelopmentContract } from './confirmation-contract-view.js';
import type {
  ConfirmationFormErrors,
  ConfirmationFormInput,
  TaskKind,
} from './confirmation-form.js';
import {
  contractGaps,
  localizeGaps,
  type ContractGap,
} from './development-contract.js';
import {
  admissionErrorSources,
  dispatchFailureView,
  executionLinkEntryView,
  outcomeView,
  type DispatchResultView,
} from './dispatch-outcome-view.js';
import {
  renderDispatchInProgress,
  renderDispatchResult,
} from './dispatch-progress-view.js';
import type {
  TaskEnrichment,
  TaskEnrichmentInput,
} from './task-enrichment.js';

const NEW_PROJECT_VALUE = '__atl_new_project__';
const NO_PROJECT_VALUE = '__atl_no_project__';
// Mirrors the confirmTask schema caps so the form never builds an input the
// service would reject with a generic error.
const MAX_LIST_ENTRIES = 50;

const PRIORITY_LABELS: Record<Task['priority'], string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const coded = error as Error & { code?: string };
    if (coded.code === 'project_already_exists') {
      return '同名项目已经存在，请选择已有项目';
    }
    if (coded.code === 'confirm_task_project_not_found') {
      return '所选项目不存在，请重新选择';
    }
    if (coded.code === 'task_confirmation_invalid_state') {
      return '任务已经不在可确认状态，请刷新看板';
    }
    if (coded.code === 'task_conflict') {
      return '任务刚刚被其他操作修改，请刷新后重试';
    }
    if (coded.code === 'invalid_confirm_task_input') {
      return '任务信息不完整或引用不合法，请逐条修正后重试';
    }
  }
  return '保存失败，任务没有变更。请刷新后重试';
}

// PAW-GOAL-003-V0.5 D1 (PRD 4.1/4.2) + D2 (PRD 4.3/4.4): one Modal, four
// steps — the branchable confirmation form, the Task Contract preview, the
// locked dispatch-in-progress view, and the outcome projection. Research
// tasks keep the previous single-step behavior (confirm → close).
export interface DevelopmentDispatchResult {
  task: Task;
  dispatch: DispatchOutcome;
}

export type DevelopmentDispatcher =
  (taskId: string) => Promise<DevelopmentDispatchResult>;

export interface TaskConfirmationModalOptions {
  /** 补投入口: open directly on the Contract step of a confirmed task. */
  initialStep?: 'contract';
  /** D2 dispatch wiring; absent means the button only reports readiness. */
  dispatch?: DevelopmentDispatcher;
}

export class TaskConfirmationModal extends Modal {
  private projectValue: string;
  private newProjectName = '';
  private newProjectDescription = '';
  private objective: string;
  private acceptanceCriteria: string[];
  private priority: Task['priority'];
  private userIntent = '';
  private enrich?:
    ((input: TaskEnrichmentInput) => Promise<TaskEnrichment>) | undefined;
  private errors: ConfirmationFormErrors = {};
  private formError = '';
  private submitting = false;
  private enriching = false;
  private detailsExpanded: boolean;
  private closed = false;
  private taskKind: TaskKind = 'research';
  private contextRefs: string[] = [''];
  private repoDeliveryAcknowledged = false;
  private step: 'form' | 'contract' | 'dispatching' | 'result' = 'form';
  private confirmedTask: Task | null = null;
  private confirmedProjectName = '';
  private readonly options: TaskConfirmationModalOptions;
  private dispatchResult: DispatchResultView | null = null;
  private dispatchStartedAtMs = 0;
  private dispatchTimer: number | null = null;
  private serviceGaps: ContractGap[] | null = null;

  constructor(
    app: App,
    private readonly controller: ConfirmationController,
    private readonly prepared: PreparedConfirmation,
    enrich?: (input: TaskEnrichmentInput) => Promise<TaskEnrichment>,
    options: TaskConfirmationModalOptions = {},
  ) {
    super(app);
    const knownProject = prepared.task.projectId !== null
      && prepared.projects.some(({ projectId }) => (
        projectId === prepared.task.projectId
      ));
    this.projectValue = knownProject
      ? prepared.task.projectId ?? NO_PROJECT_VALUE
      : NO_PROJECT_VALUE;
    this.objective = prepared.task.objective ?? '';
    this.acceptanceCriteria = prepared.task.acceptanceCriteria.length > 0
      ? [...prepared.task.acceptanceCriteria]
      : [''];
    this.priority = prepared.task.priority;
    this.detailsExpanded = this.objective.trim() !== ''
      || prepared.task.acceptanceCriteria.length > 0;
    this.enrich = enrich ?? undefined;
    this.options = options;
    if (options.initialStep === 'contract') {
      // The补投 entry starts from the persisted task; if its execution link
      // already carries a remote fact, project that fact instead of offering
      // another dispatch (PRD 4.4: the display never impersonates the remote).
      const entry = executionLinkEntryView(prepared.task);
      this.confirmedTask = prepared.task;
      this.taskKind = 'development';
      this.confirmedProjectName = this.initialProjectName();
      // Fresh CR P2: hydrate the dev-only form fields from the persisted
      // declaration so 返回修改 shows (and can amend) the real context refs.
      const persistedRefs = prepared.task.contextRefs ?? [];
      this.contextRefs = persistedRefs.length > 0 ? [...persistedRefs] : [''];
      this.repoDeliveryAcknowledged = false;
      if (entry.kind === 'result') {
        this.dispatchResult = entry.result;
        this.step = 'result';
      } else {
        this.step = 'contract';
      }
    }
  }

  override onOpen(): void {
    this.closed = false;
    this.modalEl.addClass('atl-task-confirmation-modal');
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    this.stopDispatchTimer();
    this.contentEl.empty();
  }

  // While a dispatch is in flight the Modal stays locked: closing it cannot
  // stop the remote ensure, and the single-flight lease plus reconciliation
  // already guarantee no second issue — so Esc only explains that (screen
  // contract state 4).
  override close(): void {
    if (this.step === 'dispatching') {
      new Notice('投递进行中：关闭后由后台对账接手，不会产生第二个 Issue');
      return;
    }
    super.close();
  }

  private initialProjectName(): string {
    const { task, projects } = this.prepared;
    return projects.find(({ projectId }) => projectId === task.projectId)?.name
      ?? task.projectId
      ?? '';
  }

  private isCompletingReadyTask(): boolean {
    return this.prepared.task.status === 'ready';
  }

  private actionLabel(): string {
    if (this.taskKind === 'development') return '确认任务';
    return this.isCompletingReadyTask() ? '完善待办' : '移到待办';
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.syncModalWidth();
    if (this.step === 'dispatching') {
      renderDispatchInProgress(contentEl, {
        taskTitle: (this.confirmedTask ?? this.prepared.task).title,
        startedAtMs: this.dispatchStartedAtMs,
        nowMs: Date.now(),
      });
      return;
    }
    if (this.step === 'result' && this.dispatchResult !== null) {
      renderDispatchResult(contentEl, {
        view: this.dispatchResult,
        taskTitle: (this.confirmedTask ?? this.prepared.task).title,
        completedAt: new Date().toISOString(),
        onClose: () => this.close(),
        onConflictAcknowledge: () => this.close(),
        onRetryFromPalette: () => {
          new Notice('请从命令面板选择「授权开发任务并交给 Multica」重新投递');
          this.close();
        },
      });
      return;
    }
    if (this.step === 'contract' && this.confirmedTask !== null) {
      renderDevelopmentContract(contentEl, {
        task: this.confirmedTask,
        projectName: this.confirmedProjectName,
        repoDeliveryAcknowledged: this.repoDeliveryAcknowledged,
        // Service-returned admission gaps (which can include findings the
        // local computation cannot see, e.g. symlink escapes) take
        // precedence over the locally recomputed list.
        gaps: this.serviceGaps ?? contractGaps(
          this.confirmedTask,
          this.repoDeliveryAcknowledged,
        ),
        canReturnToForm: this.confirmedTask.status === 'ready',
        onBackToForm: () => {
          this.serviceGaps = null;
          this.step = 'form';
          this.render();
        },
        onDefer: () => this.close(),
        onDispatch: () => {
          void this.runDispatch();
        },
        onAcknowledgementChange: (acknowledged) => {
          this.repoDeliveryAcknowledged = acknowledged;
          this.render();
        },
      });
      return;
    }
    contentEl.createEl('h2', { text: this.actionLabel() });
    contentEl.createDiv({
      cls: 'atl-task-title',
      text: this.prepared.task.title,
    });
    contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: this.taskKind === 'development'
        ? '确认后任务进入待办；投递到 Multica 前会先展示完整 Task Contract。'
        : this.isCompletingReadyTask()
        ? '补充任务信息并确认；完整的执行上下文可继续授权给 Agent。'
        : '项目、目标和完成条件都可以稍后补充。',
    });

    if (this.formError !== '') {
      contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    this.renderTaskKind(contentEl);
    this.renderProject(contentEl);
    this.renderPriority(contentEl);
    this.renderEnrichment(contentEl);
    this.renderTaskDetails(contentEl);
    if (this.taskKind === 'development') {
      this.renderContextRefs(contentEl);
      this.renderPermissionDeclaration(contentEl);
    }
    this.renderActions(contentEl);
  }

  // The Contract summary rows need the wider layout (component map); the
  // research form keeps the previous 640px width (PRD 6 rule 4). The lock
  // class hides the close affordance while a dispatch is in flight.
  private syncModalWidth(): void {
    const developmentStep = this.taskKind === 'development'
      || this.step === 'contract'
      || this.step === 'dispatching'
      || this.step === 'result';
    this.modalEl.classList.toggle(
      'atl-task-confirmation-modal--wide',
      developmentStep,
    );
    this.modalEl.classList.toggle(
      'atl-modal-locked',
      this.step === 'dispatching',
    );
  }

  private renderTaskKind(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'atl-task-kind-section setting-item' });
    const info = section.createDiv({ cls: 'setting-item-info' });
    info.createDiv({ cls: 'setting-item-name', text: '任务类型' });
    info.createDiv({
      cls: 'setting-item-description',
      text: '开发任务将由 Multica 承载执行；研究任务保持现有流程',
    });
    const control = section.createDiv({ cls: 'setting-item-control' });
    const segment = control.createDiv({ cls: 'atl-task-kind-segment' });
    // Fresh CR P3: once a development declaration is confirmed, it cannot be
    // turned into a research task — the research option is disabled instead
    // of failing at submit with a confusing state error.
    const kindLocked = this.confirmedTask !== null;
    const options: Array<{ kind: TaskKind; label: string }> = [
      { kind: 'research', label: '研究任务' },
      { kind: 'development', label: '开发任务' },
    ];
    for (const { kind, label } of options) {
      const disabled = kindLocked && kind !== this.taskKind;
      const button = segment.createEl('button', {
        cls: `atl-task-kind-option${this.taskKind === kind ? ' is-active' : ''}`,
        attr: {
          type: 'button',
          'aria-pressed': String(this.taskKind === kind),
          ...(disabled ? { disabled: 'disabled' } : {}),
        },
        text: label,
      });
      button.disabled = disabled;
      button.addEventListener('click', () => this.switchTaskKind(kind));
    }
  }

  // PRD 4.1: switching keeps every shared field (and the typed context
  // refs); only the permission acknowledgement is reset when leaving the
  // development branch so it never leaks into a research task.
  private switchTaskKind(kind: TaskKind): void {
    if (this.taskKind === kind) return;
    this.taskKind = kind;
    if (kind === 'research') {
      this.repoDeliveryAcknowledged = false;
    }
    this.render();
  }

  private renderTaskDetails(container: HTMLElement): void {
    const details = container.createEl('details', { cls: 'atl-task-details' });
    details.open = this.detailsExpanded;
    details.addEventListener('toggle', () => {
      this.detailsExpanded = details.open;
    });
    details.createEl('summary', { text: '任务说明（可选）' });
    const body = details.createDiv({ cls: 'atl-task-details-body' });
    this.renderObjective(body);
    this.renderAcceptanceCriteria(body);
  }

  private renderEnrichment(container: HTMLElement): void {
    if (this.enrich === undefined) return;
    new Setting(container)
      .setName('补充说明')
      .setDesc('可选，用一句话告诉 AI 你最终想得到什么')
      .addTextArea((text) => {
        text.inputEl.rows = 2;
        text
          .setPlaceholder('例如：给出是否值得接入的明确建议')
          .setValue(this.userIntent)
          .onChange((value) => {
            this.userIntent = value;
          });
      });
    new Setting(container)
      .setName('AI 整理')
      .setDesc('只生成目标和完成条件，生成后仍可编辑')
      .addButton((button) => button
        .setButtonText(this.enriching ? '正在整理...' : 'AI 帮我整理')
        .setIcon('sparkles')
        .setDisabled(this.enriching || this.submitting)
        .onClick(() => this.runEnrichment()));
  }

  private renderProject(container: HTMLElement): void {
    const projectSetting = new Setting(container)
      .setName('项目')
      .setDesc('可选，用于归类任务')
      .addDropdown((dropdown) => {
        dropdown.addOption(NO_PROJECT_VALUE, '暂不选择项目');
        for (const project of this.prepared.projects) {
          dropdown.addOption(project.projectId, project.name);
        }
        dropdown
          .addOption(NEW_PROJECT_VALUE, '新建项目...')
          .setValue(this.projectValue)
          .onChange((value) => {
            this.projectValue = value;
            delete this.errors.project;
            this.render();
          });
      });
    this.appendFieldError(projectSetting, this.errors.project);

    if (this.projectValue === NEW_PROJECT_VALUE) {
      new Setting(container)
        .setName('项目名称')
        .addText((text) => text
          .setPlaceholder('例如：AI 产品雷达')
          .setValue(this.newProjectName)
          .onChange((value) => {
            this.newProjectName = value;
          }));
      new Setting(container)
        .setName('项目说明')
        .addTextArea((text) => {
          text.inputEl.rows = 2;
          text
            .setPlaceholder('这个项目持续关注什么？')
            .setValue(this.newProjectDescription)
            .onChange((value) => {
              this.newProjectDescription = value;
            });
        });
    }
  }

  private renderObjective(container: HTMLElement): void {
    const setting = new Setting(container)
      .setName('任务目标')
      .setDesc('可选，说明希望最终得到什么结果')
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text
          .setPlaceholder('例如：梳理产品定位、核心能力和公开定价')
          .setValue(this.objective)
          .onChange((value) => {
            this.objective = value;
          });
      });
    this.appendFieldError(setting, this.errors.objective);
  }

  private renderAcceptanceCriteria(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'atl-criteria-section' });
    section.createDiv({ cls: 'setting-item-name', text: '验收标准' });
    section.createDiv({
      cls: 'setting-item-description',
      text: '每一条都应能在验收时明确判断是否满足',
    });
    const list = section.createDiv({ cls: 'atl-criteria-list' });
    this.acceptanceCriteria.forEach((criterion, index) => {
      const row = list.createDiv({ cls: 'atl-criterion-row' });
      const input = row.createEl('textarea', {
        attr: {
          'aria-label': `验收标准 ${index + 1}`,
          placeholder: `验收标准 ${index + 1}`,
          rows: '2',
        },
      });
      input.value = criterion;
      input.addEventListener('input', () => {
        this.acceptanceCriteria[index] = input.value;
      });
      const removeButton = row.createEl('button', {
        cls: 'clickable-icon atl-icon-button',
        attr: { 'aria-label': '删除这条验收标准' },
      });
      setIcon(removeButton, 'trash-2');
      setTooltip(removeButton, '删除');
      removeButton.disabled = this.acceptanceCriteria.length === 1;
      removeButton.addEventListener('click', () => {
        this.acceptanceCriteria.splice(index, 1);
        this.render();
      });
    });
    if (this.errors.acceptanceCriteria !== undefined) {
      section.createDiv({
        cls: 'atl-form-error',
        text: this.errors.acceptanceCriteria,
      });
    }
    const addButton = section.createEl('button', {
      cls: 'atl-add-criterion-button',
      text: '添加验收标准',
    });
    setIcon(addButton, 'plus');
    addButton.disabled = this.acceptanceCriteria.length >= MAX_LIST_ENTRIES;
    addButton.addEventListener('click', () => {
      if (this.acceptanceCriteria.length >= MAX_LIST_ENTRIES) return;
      this.acceptanceCriteria.push('');
      this.render();
    });
  }

  private renderContextRefs(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'atl-context-refs-section' });
    section.createDiv({ cls: 'setting-item-name', text: '上下文引用' });
    section.createDiv({
      cls: 'setting-item-description',
      text: '至少一条，仅接受执行工作区内的仓库相对路径；Agent 只能读取这些引用',
    });
    const list = section.createDiv({ cls: 'atl-context-ref-list' });
    this.contextRefs.forEach((ref, index) => {
      const row = list.createDiv({ cls: 'atl-context-ref-row' });
      const input = row.createEl('input', {
        cls: 'atl-context-ref-input',
        attr: {
          type: 'text',
          'aria-label': `上下文引用 ${index + 1}`,
          placeholder: '例如：docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md',
        },
      });
      input.value = ref;
      input.addEventListener('input', () => {
        this.contextRefs[index] = input.value;
      });
      const removeButton = row.createEl('button', {
        cls: 'clickable-icon atl-icon-button',
        attr: { 'aria-label': '删除这条上下文引用' },
      });
      setIcon(removeButton, 'trash-2');
      setTooltip(removeButton, '删除');
      removeButton.disabled = this.contextRefs.length === 1;
      removeButton.addEventListener('click', () => {
        this.contextRefs.splice(index, 1);
        this.render();
      });
    });
    if (this.errors.contextRefs !== undefined) {
      section.createDiv({
        cls: 'atl-form-error',
        text: this.errors.contextRefs,
      });
    }
    const addButton = section.createEl('button', {
      cls: 'atl-add-criterion-button atl-add-context-ref-button',
      text: '添加引用',
    });
    setIcon(addButton, 'plus');
    addButton.disabled = this.contextRefs.length >= MAX_LIST_ENTRIES;
    addButton.addEventListener('click', () => {
      if (this.contextRefs.length >= MAX_LIST_ENTRIES) return;
      this.contextRefs.push('');
      this.render();
    });
  }

  private renderPermissionDeclaration(container: HTMLElement): void {
    const section = container.createDiv({
      cls: 'atl-permission-section setting-item',
    });
    const info = section.createDiv({ cls: 'setting-item-info' });
    info.createDiv({ cls: 'setting-item-name', text: '权限声明' });
    const control = section.createDiv({ cls: 'setting-item-control' });
    const label = control.createEl('label', { cls: 'atl-permission-label' });
    const checkbox = label.createEl('input', { attr: { type: 'checkbox' } });
    checkbox.checked = this.repoDeliveryAcknowledged;
    checkbox.addEventListener('change', () => {
      this.repoDeliveryAcknowledged = checkbox.checked;
      this.errors = checkbox.checked
        ? Object.fromEntries(Object.entries(this.errors).filter(([key]) => (
          key !== 'repoDeliveryAcknowledged'
        ))) as ConfirmationFormErrors
        : {
            ...this.errors,
            repoDeliveryAcknowledged: '请先确认 repo_delivery 权限声明',
          };
      this.render();
    });
    const text = label.createSpan({ cls: 'atl-permission-text' });
    text.createEl('strong', { text: 'repo_delivery' });
    text.append('：允许 Agent 在目标仓库内交付代码（分支、提交、PR）。独立 CR 与发布审批仍然必须人工通过。');
    if (this.errors.repoDeliveryAcknowledged !== undefined) {
      section.createDiv({
        cls: 'atl-form-error',
        text: this.errors.repoDeliveryAcknowledged,
      });
    }
  }

  private renderPriority(container: HTMLElement): void {
    new Setting(container)
      .setName('优先级')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(PRIORITY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(this.priority)
          .onChange((value) => {
            this.priority = value as Task['priority'];
          });
      });
  }

  private renderActions(container: HTMLElement): void {
    const actions = new Setting(container).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));

    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button
        .setButtonText(this.submitting ? '正在保存...' : this.actionLabel())
        .setCta()
        .setDisabled(this.submitting)
        .onClick(() => this.submit(submitButton));
    });
  }

  private formInput(): ConfirmationFormInput {
    return {
      project: this.projectValue === NO_PROJECT_VALUE
        ? { mode: 'none' }
        : this.projectValue === NEW_PROJECT_VALUE
        ? {
            mode: 'new',
            name: this.newProjectName,
            description: this.newProjectDescription,
          }
        : { mode: 'existing', projectId: this.projectValue },
      objective: this.objective,
      acceptanceCriteria: this.acceptanceCriteria,
      priority: this.priority,
      taskKind: this.taskKind,
      contextRefs: [...this.contextRefs],
      repoDeliveryAcknowledged: this.repoDeliveryAcknowledged,
    };
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) {
      return;
    }
    this.submitting = true;
    button.setDisabled(true).setButtonText('正在保存...');
    this.formError = '';
    try {
      const confirmed = await this.controller.confirm(
        this.prepared.task.taskId,
        this.formInput(),
      );
      if (this.taskKind === 'development') {
        // Development confirmations continue into the Contract preview in
        // the same Modal (PRD 4.1 → 4.2); the task already rests in `ready`
        // and nothing external has happened yet. If the user closed the
        // Modal mid-save, do not resurrect it.
        this.confirmedTask = confirmed;
        this.confirmedProjectName = this.selectedProjectName() ?? '';
        this.submitting = false;
        if (this.closed) return;
        this.step = 'contract';
        this.render();
        return;
      }
      new Notice(this.isCompletingReadyTask() ? '待办信息已完善' : '任务已移到待办');
      this.close();
    } catch (error) {
      if (error instanceof InvalidConfirmationFormError) {
        this.errors = error.errors;
        this.formError = error.message;
      } else {
        this.errors = {};
        this.formError = errorMessage(error);
      }
      this.submitting = false;
      this.render();
    }
  }

  // PAW-GOAL-003-V0.5 D2 (PRD 4.3): one click authorizes and dispatches.
  // The dispatcher is injected (main.ts binds it to authorizeDevelopmentTask
  // or, for a failed re-dispatch, dispatchDevelopmentTask); this Modal owns
  // only the locked in-progress view and the outcome projection. Repeated
  // clicks are ignored while a dispatch is in flight (single-flight UI
  // guard; the durable guarantee stays in the service lease).
  private async runDispatch(): Promise<void> {
    const dispatch = this.options.dispatch;
    const task = this.confirmedTask;
    if (dispatch === undefined || task === null) {
      new Notice('任务已确认（ready）。投递接线不可用，请从命令面板重试。');
      return;
    }
    if (this.step === 'dispatching') return;
    this.serviceGaps = null;
    this.dispatchResult = null;
    this.step = 'dispatching';
    this.dispatchStartedAtMs = Date.now();
    this.startDispatchTimer();
    this.render();
    try {
      const result = await dispatch(task.taskId);
      this.dispatchResult = outcomeView(result.dispatch, new Date().toISOString());
    } catch (error) {
      // Admission gaps go back to the Contract step with the exact
      // service-reported list (which can include findings beyond the local
      // computation — the service runs the authoritative admission).
      const sources = admissionErrorSources(error);
      if (sources !== null) {
        this.serviceGaps = localizeGaps(sources);
        this.step = 'contract';
        this.stopDispatchTimer();
        if (!this.closed) this.render();
        return;
      }
      this.dispatchResult = dispatchFailureView(error);
    }
    if (this.closed) {
      this.stopDispatchTimer();
      return;
    }
    this.stopDispatchTimer();
    this.step = 'result';
    this.render();
  }

  private startDispatchTimer(): void {
    this.stopDispatchTimer();
    this.dispatchTimer = window.setInterval(() => {
      if (this.closed || this.step !== 'dispatching') {
        this.stopDispatchTimer();
        return;
      }
      this.render();
    }, 1000);
  }

  private stopDispatchTimer(): void {
    if (this.dispatchTimer !== null) {
      window.clearInterval(this.dispatchTimer);
      this.dispatchTimer = null;
    }
  }

  private async runEnrichment(): Promise<void> {
    if (this.enrich === undefined || this.enriching || this.submitting) return;
    this.enriching = true;
    this.formError = '';
    this.render();
    try {
      const result = await this.enrich({
        title: this.prepared.task.title,
        body: this.prepared.task.body,
        userIntent: this.userIntent,
        projectName: this.selectedProjectName(),
      });
      this.objective = result.objective;
      this.acceptanceCriteria = [...result.acceptanceCriteria];
      this.detailsExpanded = true;
    } catch (error) {
      this.formError = error instanceof Error && error.message.trim() !== ''
        ? `AI 整理失败：${error.message}`
        : 'AI 整理失败，请检查模型配置后重试';
    } finally {
      this.enriching = false;
      if (!this.closed) this.render();
    }
  }

  private selectedProjectName(): string | null {
    if (this.projectValue === NO_PROJECT_VALUE) return null;
    if (this.projectValue === NEW_PROJECT_VALUE) {
      return this.newProjectName.trim() || null;
    }
    return this.prepared.projects.find(({ projectId }) => (
      projectId === this.projectValue
    ))?.name ?? null;
  }

  private appendFieldError(setting: Setting, message?: string): void {
    if (message !== undefined) {
      setting.settingEl.createDiv({ cls: 'atl-form-error', text: message });
    }
  }
}
