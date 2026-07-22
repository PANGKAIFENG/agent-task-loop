import { isDingTalkMeetingPath } from './meeting-note.js';

export interface MeetingPluginCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

export interface MeetingPluginMenuItem {
  setTitle(title: string): MeetingPluginMenuItem;
  setIcon(icon: string): MeetingPluginMenuItem;
  onClick(callback: () => void): MeetingPluginMenuItem;
}

export interface MeetingPluginMenu {
  addItem(configure: (item: MeetingPluginMenuItem) => void): void;
}

export interface MeetingPluginLifecycleDependencies {
  addCommand(command: MeetingPluginCommand): void;
  registerFileMenu(
    handler: (menu: MeetingPluginMenu, path: string) => void,
  ): void;
  getActiveFilePath(): string | null;
  open(path: string): void;
}

export class MeetingPluginLifecycle {
  constructor(private readonly dependencies: MeetingPluginLifecycleDependencies) {}

  start(): void {
    this.dependencies.addCommand({
      id: 'add-meeting-transcript',
      name: '为当前钉钉日程添加会议听记',
      checkCallback: (checking) => {
        const path = this.dependencies.getActiveFilePath();
        const eligible = path !== null && isDingTalkMeetingPath(path);
        if (eligible && !checking && path !== null) {
          this.dependencies.open(path);
        }
        return eligible;
      },
    });
    this.dependencies.registerFileMenu((menu, path) => {
      if (!isDingTalkMeetingPath(path)) return;
      menu.addItem((item) => item
        .setTitle('添加会议听记')
        .setIcon('notebook-pen')
        .onClick(() => this.dependencies.open(path)));
    });
  }
}
