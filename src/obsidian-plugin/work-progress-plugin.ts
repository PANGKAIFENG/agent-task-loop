export interface WorkProgressPluginCommand {
  id: string;
  name: string;
  callback: () => void;
}

export interface WorkProgressPluginDependencies {
  addCommand(command: WorkProgressPluginCommand): void;
  addRibbonIcon(icon: string, title: string, callback: () => void): void;
  open(): Promise<void>;
}

const ALLOWED_ROOTS = [
  'TaskNotes/DingTalk/',
  '08_Meetings/',
  '09_Progress/',
] as const;

export function isSafeWorkProgressPath(path: string): boolean {
  if (
    !path.endsWith('.md')
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) return false;
  return ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

export class WorkProgressPluginLifecycle {
  constructor(private readonly dependencies: WorkProgressPluginDependencies) {}

  start(): void {
    const open = () => {
      void this.dependencies.open();
    };
    this.dependencies.addRibbonIcon('notebook-tabs', 'ATL：工作沉淀', open);
    this.dependencies.addCommand({
      id: 'open-work-progress',
      name: '打开工作沉淀',
      callback: open,
    });
  }
}
