export interface UnifiedCalendarCommand {
  id: string;
  name: string;
  callback: () => void;
}

export interface UnifiedCalendarPluginDependencies {
  addCommand(command: UnifiedCalendarCommand): void;
  addRibbonIcon(icon: string, title: string, callback: () => void): void;
  open(): Promise<void>;
}

export class UnifiedCalendarPluginLifecycle {
  constructor(private readonly dependencies: UnifiedCalendarPluginDependencies) {}

  start(): void {
    const open = () => {
      void this.dependencies.open();
    };
    this.dependencies.addRibbonIcon('calendar-range', 'ATL：统一日历', open);
    this.dependencies.addCommand({
      id: 'open-unified-calendar',
      name: '打开统一日历',
      callback: open,
    });
  }
}
