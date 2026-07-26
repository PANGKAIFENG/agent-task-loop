import { isAtlTaskPath } from './task-eligibility.js';

export interface TaskBriefPluginCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

export interface TaskBriefPluginMenuItem {
  setTitle(title: string): TaskBriefPluginMenuItem;
  setIcon(icon: string): TaskBriefPluginMenuItem;
  onClick(callback: () => void): TaskBriefPluginMenuItem;
}

export interface TaskBriefPluginMenu {
  addItem(configure: (item: TaskBriefPluginMenuItem) => void): void;
}

export interface TaskBriefPluginLifecycleDependencies {
  addCommand(command: TaskBriefPluginCommand): void;
  registerFileMenu(
    handler: (menu: TaskBriefPluginMenu, path: string) => void,
  ): void;
  getActiveFilePath(): string | null;
  isTaskPath(path: string): boolean;
  open(path: string): void;
}

export class TaskBriefPluginLifecycle {
  constructor(private readonly dependencies: TaskBriefPluginLifecycleDependencies) {}

  private isTaskPath(path: string): boolean {
    return isAtlTaskPath(path) || this.dependencies.isTaskPath(path);
  }

  start(): void {
    this.dependencies.addCommand({
      id: 'clarify-current-task',
      name: '智能完善当前任务',
      checkCallback: (checking) => {
        const path = this.dependencies.getActiveFilePath();
        const eligible = path !== null && this.isTaskPath(path);
        if (eligible && !checking && path !== null) this.dependencies.open(path);
        return eligible;
      },
    });
    this.dependencies.registerFileMenu((menu, path) => {
      if (!this.isTaskPath(path)) return;
      menu.addItem((item) => item
        .setTitle('智能完善任务')
        .setIcon('sparkles')
        .onClick(() => this.dependencies.open(path)));
    });
  }
}
