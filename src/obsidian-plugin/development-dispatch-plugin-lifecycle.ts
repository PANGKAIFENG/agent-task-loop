// PAW-GOAL-003-V0.5 D2 (PRD 4.5): the补投入口 for confirmed development
// tasks, symmetric to AgentAuthorizationPluginLifecycle (command palette +
// file context menu). Eligibility mirrors the research entry but branches on
// the development declaration, and additionally respects the dispatch state:
// while a dispatch is in flight, reconciling, conflicting, or already bound,
// no re-dispatch is offered — the single-flight lease and reconciliation own
// those states.

export interface DevelopmentDispatchPluginCommand {
  id: string;
  name: string;
  checkCallback(checking: boolean): boolean;
}

export interface DevelopmentDispatchPluginMenuItem {
  setTitle(title: string): DevelopmentDispatchPluginMenuItem;
  setIcon(icon: string): DevelopmentDispatchPluginMenuItem;
  onClick(callback: () => void): DevelopmentDispatchPluginMenuItem;
}

export interface DevelopmentDispatchPluginMenu {
  addItem(configure: (item: DevelopmentDispatchPluginMenuItem) => void): void;
}

export interface DevelopmentDispatchPluginLifecycleDependencies {
  addCommand(command: DevelopmentDispatchPluginCommand): void;
  registerFileMenu(
    handler: (menu: DevelopmentDispatchPluginMenu, path: string) => void,
  ): void;
  getActiveFilePath(): string | null;
  isEligible(path: string): boolean;
  open(path: string): void;
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

const RE_DISPATCHABLE_STATES = new Set(['not_requested', 'failed']);

function dispatchMayBeRequested(executionLink: unknown): boolean {
  if (executionLink === null || executionLink === undefined) return true;
  if (typeof executionLink !== 'object' || Array.isArray(executionLink)) {
    return false;
  }
  const dispatchState = (executionLink as Record<string, unknown>).dispatch_state;
  if (dispatchState === null || dispatchState === undefined) return true;
  return typeof dispatchState === 'string'
    && RE_DISPATCHABLE_STATES.has(dispatchState);
}

export function isDevelopmentDispatchEligibleMetadata(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const declarationComplete = (metadata.status === 'ready' || metadata.status === 'agent_executable')
    && metadata.review_state === 'confirmed'
    && nonBlank(metadata.project_id)
    && metadata.task_type === 'development'
    && nonBlank(metadata.objective)
    && Array.isArray(metadata.acceptance_criteria)
    && metadata.acceptance_criteria.some(nonBlank)
    && metadata.permission_profile === 'repo_delivery'
    && metadata.execution_target === 'multica'
    && Array.isArray(metadata.context_refs)
    && metadata.context_refs.some(nonBlank);
  if (!declarationComplete) return false;
  return dispatchMayBeRequested(metadata.execution_link);
}

export class DevelopmentDispatchPluginLifecycle {
  constructor(
    private readonly dependencies: DevelopmentDispatchPluginLifecycleDependencies,
  ) {}

  start(): void {
    this.dependencies.addCommand({
      id: 'authorize-development-task-to-multica',
      name: '授权开发任务并交给 Multica',
      checkCallback: (checking) => {
        const path = this.dependencies.getActiveFilePath();
        const eligible = path !== null && this.dependencies.isEligible(path);
        if (eligible && !checking && path !== null) {
          this.dependencies.open(path);
        }
        return eligible;
      },
    });
    this.dependencies.registerFileMenu((menu, path) => {
      if (!this.dependencies.isEligible(path)) return;
      menu.addItem((item) => item
        .setTitle('授权并交给 Multica')
        .setIcon('send')
        .onClick(() => this.dependencies.open(path)));
    });
  }
}
