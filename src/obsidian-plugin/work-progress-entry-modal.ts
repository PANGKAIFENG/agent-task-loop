import {
  App,
  ButtonComponent,
  Modal,
  Setting,
} from 'obsidian';

import {
  PROGRESS_EVIDENCE_KINDS,
  type ProgressDraft,
  type ProgressEvidenceKind,
  type ProgressReportCategory,
  type ProgressStatementKind,
} from '../domain/progress.js';
import type { CreateMaterialGapInput } from '../services/create-material-gap.js';
import type { WorkProgressHubSnapshot } from './work-progress-hub-controller.js';

const REPORT_CATEGORY_LABELS: Record<ProgressReportCategory, string> = {
  product_requirement: '产品需求',
  project_acceptance: '项目验收',
  research_share: '研究分享',
  agent_skill_harness: 'Agent / Skill / Harness',
  routine_check: '例行核对',
};

const STATEMENT_KIND_LABELS: Record<ProgressStatementKind, string> = {
  fact: '事实',
  inference: '推断',
  pending: '待确认',
};

const EVIDENCE_KIND_LABELS: Record<ProgressEvidenceKind, string> = {
  attendance: '参会',
  discussion: '讨论',
  plan: '计划',
  reminder: '提醒',
  future_action: '后续行动',
  task_state_change: '任务状态变化',
  confirmed_decision: '已确认决策',
  artifact: '产物',
  blocker: '阻塞',
};

const MATERIAL_KIND_LABELS = {
  numeric: '数字',
  document: '文档',
  status: '状态',
} as const;

function localDateTimeValue(now: Date): string {
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function normalizedOccurredAt(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export class ProgressEntryModal extends Modal {
  private topic = '';
  private reportCategory: ProgressReportCategory = 'project_acceptance';
  private primaryProjectId = '';
  private occurredAt: string;
  private source = '';
  private statementKind: ProgressStatementKind = 'fact';
  private statement = '';
  private evidenceKind: ProgressEvidenceKind = 'artifact';
  private formError = '';
  private submitting = false;
  private completed = false;

  constructor(
    app: App,
    private readonly onSubmit: (draft: ProgressDraft) => Promise<void>,
    private readonly onCancel?: () => void,
    now: () => Date = () => new Date(),
  ) {
    super(app);
    this.occurredAt = localDateTimeValue(now());
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-work-progress-entry-modal');
    this.render();
  }

  override onClose(): void {
    if (!this.completed) this.onCancel?.();
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '新建工作进展' });
    this.contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: '记录真实变化、输出或卡点；不会创建任务或修改任务状态。',
    });
    if (this.formError !== '') {
      this.contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    new Setting(this.contentEl)
      .setName('进展主题')
      .addText((text) => {
        text.inputEl.setAttribute('aria-label', '进展主题');
        text.setValue(this.topic).onChange((value) => this.change(() => { this.topic = value; }));
      });
    new Setting(this.contentEl)
      .setName('汇报类型')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(REPORT_CATEGORY_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.selectEl.setAttribute('aria-label', '汇报类型');
        dropdown.setValue(this.reportCategory).onChange((value) => this.change(() => {
          this.reportCategory = value as ProgressReportCategory;
        }));
      });
    new Setting(this.contentEl)
      .setName('主项目 ID')
      .setDesc('每条进展只能有一个主汇报归属')
      .addText((text) => {
        text.inputEl.setAttribute('aria-label', '主项目 ID');
        text.setValue(this.primaryProjectId).onChange((value) => this.change(() => {
          this.primaryProjectId = value;
        }));
      });
    new Setting(this.contentEl)
      .setName('发生时间')
      .addText((text) => {
        text.inputEl.type = 'datetime-local';
        text.inputEl.setAttribute('aria-label', '发生时间');
        text.setValue(this.occurredAt).onChange((value) => this.change(() => {
          this.occurredAt = value;
        }));
      });
    new Setting(this.contentEl)
      .setName('来源')
      .setDesc('填写可在 Obsidian 中定位的会议、Artifact 或项目路径')
      .addText((text) => {
        text.inputEl.setAttribute('aria-label', '来源');
        text.setValue(this.source).onChange((value) => this.change(() => { this.source = value; }));
      });
    new Setting(this.contentEl)
      .setName('说明类型')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(STATEMENT_KIND_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.selectEl.setAttribute('aria-label', '说明类型');
        dropdown.setValue(this.statementKind).onChange((value) => this.change(() => {
          this.statementKind = value as ProgressStatementKind;
        }));
      });
    new Setting(this.contentEl)
      .setName('进展说明')
      .setDesc('写清楚发生了什么变化、形成了什么输出或遇到什么卡点')
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.setAttribute('aria-label', '进展说明');
        text.setValue(this.statement).onChange((value) => this.change(() => {
          this.statement = value;
        }));
      });
    new Setting(this.contentEl)
      .setName('证据类型')
      .addDropdown((dropdown) => {
        for (const value of PROGRESS_EVIDENCE_KINDS) {
          dropdown.addOption(value, EVIDENCE_KIND_LABELS[value]);
        }
        dropdown.selectEl.setAttribute('aria-label', '证据类型');
        dropdown.setValue(this.evidenceKind).onChange((value) => this.change(() => {
          this.evidenceKind = value as ProgressEvidenceKind;
        }));
      });

    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button.setCta().setButtonText('创建进展').setDisabled(this.submitting)
        .onClick(() => { void this.submit(submitButton); });
    });
  }

  private change(update: () => void): void {
    update();
    this.formError = '';
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) return;
    const topic = this.topic.trim();
    const projectId = this.primaryProjectId.trim();
    const source = this.source.trim();
    const statement = this.statement.trim();
    const occurredAt = normalizedOccurredAt(this.occurredAt);
    if (
      topic === ''
      || projectId === ''
      || source === ''
      || statement === ''
      || occurredAt === null
    ) {
      this.formError = '请补齐所有必填项';
      this.render();
      return;
    }
    this.submitting = true;
    for (const action of this.contentEl.querySelectorAll('button')) action.disabled = true;
    button.setButtonText('正在创建...');
    try {
      await this.onSubmit({
        topic,
        reportCategory: this.reportCategory,
        primaryProjectId: projectId,
        occurredAt,
        sources: [source],
        statements: [{ kind: this.statementKind, text: statement, sourceRefs: [source] }],
        evidence: [{ kind: this.evidenceKind, summary: statement, sourceRef: source }],
        selfEvidence: [],
        agentEvidence: [],
      });
      this.completed = true;
      this.close();
    } catch {
      this.submitting = false;
      this.formError = '创建进展失败，请重试';
      this.render();
    }
  }
}

export class MaterialGapEntryModal extends Modal {
  private selectedProgress = 0;
  private kind: CreateMaterialGapInput['missing']['kind'] = 'numeric';
  private description = '';
  private purpose = '';
  private formError = '';
  private submitting = false;
  private completed = false;

  constructor(
    app: App,
    private readonly progress: WorkProgressHubSnapshot['progress'],
    private readonly onSubmit: (input: CreateMaterialGapInput) => Promise<void>,
    private readonly onCancel?: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('atl-work-progress-entry-modal');
    this.render();
  }

  override onClose(): void {
    if (!this.completed) this.onCancel?.();
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '登记材料缺口' });
    this.contentEl.createEl('p', {
      cls: 'atl-task-subtitle',
      text: '先登记缺什么和为什么需要；系统不会据此自动联系他人。',
    });
    if (this.formError !== '') {
      this.contentEl.createDiv({
        cls: 'atl-form-error atl-form-error-summary',
        text: this.formError,
      });
    }

    new Setting(this.contentEl)
      .setName('关联进展')
      .addDropdown((dropdown) => {
        this.progress.forEach((item, index) => {
          dropdown.addOption(String(index), `${item.topic} · v${item.version}`);
        });
        dropdown.selectEl.setAttribute('aria-label', '关联进展');
        dropdown.setValue(String(this.selectedProgress)).onChange((value) => {
          this.selectedProgress = Number(value);
          this.formError = '';
        });
      });
    new Setting(this.contentEl)
      .setName('缺口类型')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(MATERIAL_KIND_LABELS)) {
          dropdown.addOption(value, label);
        }
        dropdown.selectEl.setAttribute('aria-label', '缺口类型');
        dropdown.setValue(this.kind).onChange((value) => {
          this.kind = value as CreateMaterialGapInput['missing']['kind'];
          this.formError = '';
        });
      });
    new Setting(this.contentEl)
      .setName('缺口说明')
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.setAttribute('aria-label', '缺口说明');
        text.setValue(this.description).onChange((value) => {
          this.description = value;
          this.formError = '';
        });
      });
    new Setting(this.contentEl)
      .setName('使用目的')
      .setDesc('例如：精恭纺验收周报')
      .addText((text) => {
        text.inputEl.setAttribute('aria-label', '使用目的');
        text.setValue(this.purpose).onChange((value) => {
          this.purpose = value;
          this.formError = '';
        });
      });

    const actions = new Setting(this.contentEl).setClass('atl-modal-actions');
    actions.addButton((button) => button
      .setButtonText('取消')
      .setDisabled(this.submitting)
      .onClick(() => this.close()));
    let submitButton: ButtonComponent;
    actions.addButton((button) => {
      submitButton = button;
      button.setCta().setButtonText('登记缺口').setDisabled(this.submitting)
        .onClick(() => { void this.submit(submitButton); });
    });
  }

  private async submit(button: ButtonComponent): Promise<void> {
    if (this.submitting) return;
    const selected = this.progress[this.selectedProgress];
    const description = this.description.trim();
    const purpose = this.purpose.trim();
    if (selected === undefined || description === '' || purpose === '') {
      this.formError = '请补齐所有必填项';
      this.render();
      return;
    }
    this.submitting = true;
    for (const action of this.contentEl.querySelectorAll('button')) action.disabled = true;
    button.setButtonText('正在登记...');
    try {
      await this.onSubmit({
        progressId: selected.progressId,
        progressVersion: selected.version,
        missing: { kind: this.kind, description, purpose },
        searches: [],
        suggestedContact: null,
      });
      this.completed = true;
      this.close();
    } catch {
      this.submitting = false;
      this.formError = '登记缺口失败，请重试';
      this.render();
    }
  }
}
