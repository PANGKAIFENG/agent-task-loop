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

// PAW-GOAL-003 T1 (TECH §7): the 15-minute cycle runs notification retries,
// then the Multica dispatch reconciliation, then the Qianwen sync, then one
// eligible local research task. Each leg is isolated — a Multica failure can
// never block the other legs. The Multica leg stays optional so deployments
// without the dispatch configuration keep the legacy cycle behavior.
export async function runHourlyCycle<
  NotificationResult,
  MulticaResult,
  QianwenResult,
  TaskResult,
>(dependencies: {
  retryAcceptanceNotifications: () => Promise<NotificationResult>;
  reconcileMultica?: () => Promise<MulticaResult>;
  syncQianwen: () => Promise<QianwenResult>;
  runTask: () => Promise<TaskResult>;
}): Promise<{
  notifications: NotificationResult | { status: 'failed'; errorCode: string };
  multica: MulticaResult | { status: 'skipped' } | { status: 'failed'; errorCode: string };
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
  let multica: MulticaResult | { status: 'skipped' } | { status: 'failed'; errorCode: string };
  if (dependencies.reconcileMultica === undefined) {
    multica = { status: 'skipped' };
  } else {
    try {
      multica = await dependencies.reconcileMultica();
    } catch (error) {
      multica = {
        status: 'failed',
        errorCode: safeErrorCode(error, 'multica_reconcile_failed'),
      };
    }
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
    multica,
    qianwen,
    task: await dependencies.runTask(),
  };
}
