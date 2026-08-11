export interface QianwenSyncPluginCommand {
  id: string;
  name: string;
  callback: () => void;
}

export interface QianwenSyncPluginDependencies<Result> {
  addCommand(command: QianwenSyncPluginCommand): void;
  sync(): Promise<Result>;
  onSuccess(result: Result): void;
  onError(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : '千问听记同步失败';
}

export class QianwenSyncPluginLifecycle<Result> {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly dependencies: QianwenSyncPluginDependencies<Result>) {}

  get running(): boolean {
    return this.inFlight !== null;
  }

  start(): void {
    this.dependencies.addCommand({
      id: 'sync-qianwen-now',
      name: '立即同步千问听记',
      callback: () => {
        void this.run();
      },
    });
  }

  run(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.dependencies.sync()
      .then((result) => this.dependencies.onSuccess(result))
      .catch((error: unknown) => this.dependencies.onError(errorMessage(error)))
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }
}
