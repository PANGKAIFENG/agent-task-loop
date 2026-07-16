import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  type TAbstractFile,
} from 'obsidian';

import './styles.css';

import { createVaultWriteAuthorization } from '../storage/task-paths.js';
import {
  BackgroundRuntimeController,
  createBackgroundRuntimeDependencies,
  type BackgroundInspection,
} from './background-runtime-controller.js';
import {
  BoardAppearanceController,
  type BoardPresetStatus,
} from './board-appearance-controller.js';
import { ConfirmationController } from './confirmation-controller.js';
import { TaskConfirmationModal } from './confirmation-modal.js';
import { createObsidianServiceContext } from './service-context.js';
import {
  backgroundActionState,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AtlPluginSettings,
} from './settings.js';
import { isAtlInboxTaskPath, taskIdFromPath } from './task-eligibility.js';

const CARD_THEME_CLASS = 'atl-task-card-theme';

interface LocalPluginPaths {
  root: string;
  runnerPath: string;
}

interface DirectoryDialog {
  showOpenDialog(options: {
    properties: Array<'openDirectory' | 'multiSelections'>;
    title: string;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

type ElectronRequire = (id: '@electron/remote' | 'electron') => unknown;

function getDirectoryDialog(): DirectoryDialog | null {
  const desktopWindow = window as typeof window & { require?: ElectronRequire };
  if (desktopWindow.require === undefined) return null;
  try {
    const remote = desktopWindow.require('@electron/remote') as {
      dialog?: DirectoryDialog;
    };
    if (remote.dialog !== undefined) return remote.dialog;
  } catch {
    // Older Obsidian builds expose the same fixed API through electron.remote.
  }
  try {
    const electron = desktopWindow.require('electron') as {
      remote?: { dialog?: DirectoryDialog };
    };
    return electron.remote?.dialog ?? null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : fallback;
}

export default class AgentTaskLoopPlugin extends Plugin {
  settings: AtlPluginSettings = DEFAULT_SETTINGS;
  readonly boardAppearance = new BoardAppearanceController();

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    if (this.settings.background.claudeConfigDirectory === '') {
      this.settings.background.claudeConfigDirectory = join(homedir(), '.claude');
    }
    this.applyTaskCardTheme();
    this.register(() => document.body.classList.remove(CARD_THEME_CLASS));

    this.registerEvent(this.app.workspace.on(
      'file-menu',
      (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !isAtlInboxTaskPath(file.path)) {
          return;
        }
        menu.addItem((item) => item
          .setTitle('确认并移到待执行')
          .setIcon('circle-check-big')
          .onClick(() => this.openConfirmation(file)));
      },
    ));

    this.addCommand({
      id: 'confirm-current-inbox-task',
      name: '确认当前任务并移到待执行',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible = file !== null && isAtlInboxTaskPath(file.path);
        if (eligible && !checking && file !== null) {
          void this.openConfirmation(file);
        }
        return eligible;
      },
    });

    this.addSettingTab(new AgentTaskLoopSettingTab(this));
  }

  async saveSettings(): Promise<void> {
    this.applyTaskCardTheme();
    await this.saveData(this.settings);
  }

  localPluginPaths(): LocalPluginPaths | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const root = adapter.getBasePath();
    return {
      root,
      runnerPath: join(
        root,
        this.app.vault.configDir,
        'plugins',
        this.manifest.id,
        'atl-runner.mjs',
      ),
    };
  }

  createBackgroundController(): BackgroundRuntimeController | null {
    const paths = this.localPluginPaths();
    if (paths === null) return null;
    return new BackgroundRuntimeController(createBackgroundRuntimeDependencies({
      vaultRoot: paths.root,
      homeDirectory: homedir(),
      runnerPath: paths.runnerPath,
    }));
  }

  private applyTaskCardTheme(): void {
    document.body.classList.toggle(
      CARD_THEME_CLASS,
      this.settings.taskCardThemeEnabled,
    );
  }

  private async openConfirmation(file: TFile): Promise<void> {
    if (!this.settings.allowVaultManagement) {
      new Notice('请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault');
      return;
    }
    const taskId = taskIdFromPath(file.path);
    const adapter = this.app.vault.adapter;
    if (taskId === null || !(adapter instanceof FileSystemAdapter)) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return;
    }

    const root = adapter.getBasePath();
    const authorization = createVaultWriteAuthorization(root);
    const controller = new ConfirmationController(createObsidianServiceContext(
      root,
      authorization,
    ));
    try {
      const prepared = await controller.prepare(taskId);
      new TaskConfirmationModal(this.app, controller, prepared).open();
    } catch {
      new Notice('无法读取这项 Inbox 任务，请刷新看板后重试');
    }
  }
}

const STATE_LABELS: Record<BackgroundInspection['state'], string> = {
  unconfigured: '未配置',
  installable: '待安装',
  ready: '已就绪',
  running: '正在执行',
  error: '配置异常',
};

const CHECK_LABELS = {
  ok: '正常',
  missing: '未找到',
  invalid: '无效',
  logged_out: '未登录',
  absent: '未安装',
  installed: '已安装',
  running: '执行中',
  conflict: '冲突',
  unknown: '待检测',
} as const;

class AgentTaskLoopSettingTab extends PluginSettingTab {
  private inspection: BackgroundInspection | null = null;
  private boardStatus: BoardPresetStatus | null = null;
  private refreshing = false;
  private statusLoaded = false;

  constructor(private readonly atlPlugin: AgentTaskLoopPlugin) {
    super(atlPlugin.app, atlPlugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('atl-settings');
    this.renderVaultAccess(containerEl);
    this.renderBackground(containerEl);
    this.renderBoard(containerEl);
    if (!this.refreshing && !this.statusLoaded) {
      void this.refreshStatus();
    }
  }

  private renderVaultAccess(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Vault 权限' });
    new Setting(containerEl)
      .setName('允许 ATL 管理此 Vault')
      .setDesc('允许确认和移动任务、写入执行结果，并管理本插件的后台配置。默认关闭。')
      .addToggle((toggle) => toggle
        .setValue(this.atlPlugin.settings.allowVaultManagement)
        .onChange(async (value) => {
          this.atlPlugin.settings.allowVaultManagement = value;
          await this.atlPlugin.saveSettings();
          this.display();
        }));
    containerEl.createEl('p', {
      cls: 'setting-item-description atl-settings-note',
      text: 'ATL 只管理 10_Tasks 下的任务数据与自己的后台配置，不会修改其他 Obsidian 笔记。',
    });
  }

  private renderBackground(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '后台执行' });
    const inspection = this.inspection;
    new Setting(containerEl)
      .setName('运行状态')
      .setDesc(inspection === null
        ? '正在检测本机环境…'
        : inspection.errorMessage ?? '每天 08:00 至 22:00 整点检查可执行的调研任务。')
      .then((setting) => setting.controlEl.createSpan({
        cls: `atl-status-badge atl-status-${inspection?.state ?? 'loading'}`,
        text: inspection === null ? '检测中' : STATE_LABELS[inspection.state],
      }));

    if (inspection !== null) {
      const checks = containerEl.createDiv({ cls: 'atl-runtime-checks' });
      this.renderCheck(checks, 'ATL Runner', inspection.checks.runner);
      this.renderCheck(checks, 'Node.js 24+', inspection.checks.node);
      this.renderCheck(checks, 'Claude Code', inspection.checks.claude);
      this.renderCheck(checks, '后台任务', inspection.checks.scheduler);
    }

    new Setting(containerEl)
      .setName('资料来源文件夹')
      .setDesc('Agent 只能读取你在这里选择的本地文件夹。')
      .addButton((button) => button
        .setButtonText('选择文件夹')
        .setIcon('folder-plus')
        .onClick(() => this.pickSourceFolders()));
    const roots = this.atlPlugin.settings.background.allowedLocalRoots;
    const sourceList = containerEl.createDiv({ cls: 'atl-source-list' });
    if (roots.length === 0) {
      sourceList.createSpan({
        cls: 'setting-item-description',
        text: '尚未添加资料来源',
      });
    }
    roots.forEach((path) => {
      new Setting(sourceList)
        .setName(basename(path))
        .setDesc(path)
        .addExtraButton((button) => button
          .setIcon('trash-2')
          .setTooltip('移除资料来源')
          .onClick(async () => {
            this.atlPlugin.settings.background.allowedLocalRoots = roots.filter(
              (candidate) => candidate !== path,
            );
            await this.atlPlugin.saveSettings();
            this.inspection = null;
            this.statusLoaded = false;
            this.display();
          }));
    });

    const actions = new Setting(containerEl)
      .setName('后台操作')
      .setDesc('启用后无需打开终端；试跑只处理符合条件的待执行任务。');
    const actionState = backgroundActionState({
      state: inspection?.state ?? 'unconfigured',
    });
    if (inspection?.state === 'installable'
      || inspection?.state === 'ready'
      || inspection?.state === 'running') {
      actions.addButton((button) => button
        .setCta()
        .setButtonText(actionState.primaryLabel)
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.enableBackground()));
    } else {
      actions.addButton((button) => button
        .setButtonText(actionState.primaryLabel)
        .setIcon('refresh-cw')
        .onClick(() => this.refreshStatus()));
    }
    if (actionState.canRunNow) {
      actions.addButton((button) => button
        .setButtonText('立即试跑')
        .setIcon('play')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.runNow()));
    }
    const schedulerManaged = inspection?.checks.scheduler === 'installed'
      || inspection?.checks.scheduler === 'running';
    if (actionState.canDisable && schedulerManaged) {
      actions.addExtraButton((button) => button
        .setIcon('power')
        .setTooltip('停用后台执行')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.disableBackground()));
    }

    if (inspection !== null) {
      const details = containerEl.createEl('details', { cls: 'atl-technical-details' });
      details.createEl('summary', { text: '技术详情' });
      const nodePath = inspection.detected.nodeExecutable || '未检测到';
      const claudePath = inspection.detected.claudeExecutable || '未检测到';
      details.createEl('p', { text: `Node.js: ${nodePath}` });
      details.createEl('p', { text: `Claude Code: ${claudePath}` });
    }
  }

  private renderBoard(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '任务看板' });
    new Setting(containerEl)
      .setName('ATL 紧凑卡片')
      .setDesc('在 TaskNotes 看板中突出任务标题、确认状态、来源日期和优先级。')
      .addToggle((toggle) => toggle
        .setValue(this.atlPlugin.settings.taskCardThemeEnabled)
        .onChange(async (value) => {
          this.atlPlugin.settings.taskCardThemeEnabled = value;
          await this.atlPlugin.saveSettings();
        }));

    const status = this.boardStatus;
    const setting = new Setting(containerEl)
      .setName('推荐看板布局')
      .setDesc(status === null
        ? '正在读取任务总看板…'
        : status.available
          ? '只显示确认状态与来源日期；首次应用会保留原始备份。'
          : '未找到 10_Tasks/Views/任务总看板.base');
    if (status?.available === true && !status.applied) {
      setting.addButton((button) => button
        .setCta()
        .setButtonText('应用推荐布局')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.applyBoardPreset()));
    }
    if (status?.restorable === true) {
      setting.addButton((button) => button
        .setButtonText('恢复原布局')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.restoreBoardPreset()));
    }
  }

  private renderCheck(
    container: HTMLElement,
    label: string,
    state: keyof typeof CHECK_LABELS,
  ): void {
    const row = container.createDiv({ cls: 'atl-runtime-check' });
    row.createSpan({ text: label });
    row.createSpan({
      cls: `atl-check-value atl-check-${state}`,
      text: CHECK_LABELS[state],
    });
  }

  private async refreshStatus(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const paths = this.atlPlugin.localPluginPaths();
      const controller = this.atlPlugin.createBackgroundController();
      this.inspection = controller === null
        ? null
        : await controller.inspect(this.atlPlugin.settings.background);
      if (this.inspection !== null) {
        const { detected } = this.inspection;
        if (detected.nodeExecutable !== '') {
          this.atlPlugin.settings.background.nodeExecutable = detected.nodeExecutable;
        }
        if (detected.claudeExecutable !== '') {
          this.atlPlugin.settings.background.claudeExecutable = detected.claudeExecutable;
        }
        await this.atlPlugin.saveSettings();
      }
      this.boardStatus = paths === null
        ? { available: false, applied: false, restorable: false }
        : await this.atlPlugin.boardAppearance.status(paths.root);
    } catch (error) {
      new Notice(errorMessage(error, '无法读取 ATL 配置'));
    } finally {
      this.refreshing = false;
      this.statusLoaded = true;
      this.display();
    }
  }

  private async pickSourceFolders(): Promise<void> {
    const dialog = getDirectoryDialog();
    if (dialog === null) {
      new Notice('当前 Obsidian 无法打开系统文件夹选择器');
      return;
    }
    const result = await dialog.showOpenDialog({
      title: '选择 Agent 可以读取的资料文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled) return;
    this.atlPlugin.settings.background.allowedLocalRoots = [...new Set([
      ...this.atlPlugin.settings.background.allowedLocalRoots,
      ...result.filePaths,
    ])];
    await this.atlPlugin.saveSettings();
    this.inspection = null;
    this.statusLoaded = false;
    this.display();
  }

  private async enableBackground(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.enable(this.atlPlugin.settings.background);
      new Notice('ATL 后台执行已启用');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法启用 ATL 后台执行'));
    }
  }

  private async runNow(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.runNow();
      new Notice('已启动一次 ATL 任务检查');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法启动 ATL 任务检查'));
    }
  }

  private async disableBackground(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.disable();
      new Notice('ATL 后台执行已停用');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法停用 ATL 后台执行'));
    }
  }

  private async applyBoardPreset(): Promise<void> {
    const paths = this.atlPlugin.localPluginPaths();
    if (paths === null) return;
    try {
      await this.atlPlugin.boardAppearance.applyRecommendedPreset(paths.root);
      new Notice('已应用 ATL 推荐看板布局，并保留原始备份');
      this.boardStatus = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法应用推荐看板布局'));
    }
  }

  private async restoreBoardPreset(): Promise<void> {
    const paths = this.atlPlugin.localPluginPaths();
    if (paths === null) return;
    try {
      await this.atlPlugin.boardAppearance.restorePreset(paths.root);
      new Notice('已恢复原始任务看板布局');
      this.boardStatus = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法恢复任务看板布局'));
    }
  }
}
