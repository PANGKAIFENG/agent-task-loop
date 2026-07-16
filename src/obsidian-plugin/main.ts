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
import { ConfirmationController } from './confirmation-controller.js';
import { TaskConfirmationModal } from './confirmation-modal.js';
import { createObsidianServiceContext } from './service-context.js';
import { isAtlInboxTaskPath, taskIdFromPath } from './task-eligibility.js';

interface AtlPluginSettings {
  allowVaultManagement: boolean;
}

const DEFAULT_SETTINGS: AtlPluginSettings = {
  allowVaultManagement: false,
};

export default class AgentTaskLoopPlugin extends Plugin {
  settings: AtlPluginSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData() as Partial<AtlPluginSettings> | null ?? {}),
    };

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
    await this.saveData(this.settings);
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

class AgentTaskLoopSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: AgentTaskLoopPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('允许 ATL 管理此 Vault')
      .setDesc('允许插件通过 ATL Core 创建项目、确认任务、移动任务文件并写入审计。默认关闭。')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowVaultManagement)
        .onChange(async (value) => {
          this.plugin.settings.allowVaultManagement = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'ATL 只管理 10_Tasks 下的任务、项目、Artifact、索引和审计；不会修改其他 Obsidian 笔记。',
    });
  }
}
