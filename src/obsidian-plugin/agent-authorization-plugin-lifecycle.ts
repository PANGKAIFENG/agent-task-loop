export interface AgentAuthorizationPluginCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

export interface AgentAuthorizationPluginMenuItem {
  setTitle(title: string): AgentAuthorizationPluginMenuItem;
  setIcon(icon: string): AgentAuthorizationPluginMenuItem;
  onClick(callback: () => void): AgentAuthorizationPluginMenuItem;
}

export interface AgentAuthorizationPluginMenu {
  addItem(configure: (item: AgentAuthorizationPluginMenuItem) => void): void;
}

export interface AgentAuthorizationPluginLifecycleDependencies {
  addCommand(command: AgentAuthorizationPluginCommand): void;
  registerFileMenu(
    handler: (menu: AgentAuthorizationPluginMenu, path: string) => void,
  ): void;
  getActiveFilePath(): string | null;
  isEligible(path: string): boolean;
  authorize(path: string): void;
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export function isAgentAuthorizationEligibleMetadata(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.status === 'ready'
    && metadata.review_state === 'confirmed'
    && nonBlank(metadata.project_id)
    && metadata.task_type === 'research'
    && nonBlank(metadata.objective)
    && Array.isArray(metadata.acceptance_criteria)
    && metadata.acceptance_criteria.some(nonBlank)
    && metadata.permission_profile === 'read_only_research';
}

export class AgentAuthorizationPluginLifecycle {
  constructor(
    private readonly dependencies: AgentAuthorizationPluginLifecycleDependencies,
  ) {}

  start(): void {
    this.dependencies.addCommand({
      id: 'authorize-current-task-for-agent',
      name: '授权 Agent 执行当前任务',
      checkCallback: (checking) => {
        const path = this.dependencies.getActiveFilePath();
        const eligible = path !== null && this.dependencies.isEligible(path);
        if (eligible && !checking && path !== null) {
          this.dependencies.authorize(path);
        }
        return eligible;
      },
    });
    this.dependencies.registerFileMenu((menu, path) => {
      if (!this.dependencies.isEligible(path)) return;
      menu.addItem((item) => item
        .setTitle('授权 Agent 执行')
        .setIcon('bot')
        .onClick(() => this.dependencies.authorize(path)));
    });
  }
}
