export type ConfirmationAction = 'move_to_ready' | 'complete_ready';

export interface ConfirmationPluginCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

export interface ConfirmationPluginMenuItem {
  setTitle(title: string): ConfirmationPluginMenuItem;
  setIcon(icon: string): ConfirmationPluginMenuItem;
  onClick(callback: () => void): ConfirmationPluginMenuItem;
}

export interface ConfirmationPluginMenu {
  addItem(configure: (item: ConfirmationPluginMenuItem) => void): void;
}

export interface ConfirmationPluginLifecycleDependencies {
  addCommand(command: ConfirmationPluginCommand): void;
  registerFileMenu(
    handler: (menu: ConfirmationPluginMenu, path: string) => void,
  ): void;
  getActiveFilePath(): string | null;
  actionFor(path: string): ConfirmationAction | null;
  open(path: string): void;
}

const ACTION_LABELS: Record<ConfirmationAction, string> = {
  move_to_ready: '移到待办',
  complete_ready: '完善待办',
};

const COMMAND_NAMES: Record<ConfirmationAction, string> = {
  move_to_ready: '将当前任务移到待办',
  complete_ready: '完善当前待办',
};

export function confirmationActionFromMetadata(
  isInboxPath: boolean,
  value: unknown,
): ConfirmationAction | null {
  if (isInboxPath) return 'move_to_ready';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return metadata.status === 'ready' && metadata.review_state !== 'confirmed'
    ? 'complete_ready'
    : null;
}

export class ConfirmationPluginLifecycle {
  constructor(private readonly dependencies: ConfirmationPluginLifecycleDependencies) {}

  start(): void {
    this.registerCommand('move_to_ready', 'confirm-current-inbox-task');
    this.registerCommand('complete_ready', 'complete-current-ready-task');
    this.dependencies.registerFileMenu((menu, path) => {
      const action = this.dependencies.actionFor(path);
      if (action === null) return;
      menu.addItem((item) => item
        .setTitle(ACTION_LABELS[action])
        .setIcon(action === 'move_to_ready' ? 'circle-check-big' : 'list-checks')
        .onClick(() => this.dependencies.open(path)));
    });
  }

  private registerCommand(action: ConfirmationAction, id: string): void {
    this.dependencies.addCommand({
      id,
      name: COMMAND_NAMES[action],
      checkCallback: (checking) => {
        const path = this.dependencies.getActiveFilePath();
        const eligible = path !== null && this.dependencies.actionFor(path) === action;
        if (eligible && !checking && path !== null) this.dependencies.open(path);
        return eligible;
      },
    });
  }
}
