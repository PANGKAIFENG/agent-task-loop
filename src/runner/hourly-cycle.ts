function safeErrorCode(error: unknown, fallback: string): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

export async function runHourlyCycle<
  NotificationResult,
  QianwenResult,
  TaskResult,
>(dependencies: {
  retryAcceptanceNotifications: () => Promise<NotificationResult>;
  syncQianwen: () => Promise<QianwenResult>;
  runTask: () => Promise<TaskResult>;
}): Promise<{
  notifications: NotificationResult | { status: 'failed'; errorCode: string };
  qianwen: QianwenResult | { status: 'failed'; errorCode: string };
  task: TaskResult;
}> {
  let notifications: NotificationResult | { status: 'failed'; errorCode: string };
  try {
    notifications = await dependencies.retryAcceptanceNotifications();
  } catch (error) {
    notifications = {
      status: 'failed',
      errorCode: safeErrorCode(error, 'acceptance_notification_retry_failed'),
    };
  }
  let qianwen: QianwenResult | { status: 'failed'; errorCode: string };
  try {
    qianwen = await dependencies.syncQianwen();
  } catch (error) {
    qianwen = {
      status: 'failed',
      errorCode: safeErrorCode(error, 'qianwen_sync_failed'),
    };
  }

  return {
    notifications,
    qianwen,
    task: await dependencies.runTask(),
  };
}
