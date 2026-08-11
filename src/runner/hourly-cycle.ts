function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'qianwen_sync_failed';
}

export async function runHourlyCycle<
  QianwenResult,
  TaskResult,
>(dependencies: {
  syncQianwen: () => Promise<QianwenResult>;
  runTask: () => Promise<TaskResult>;
}): Promise<{
  qianwen: QianwenResult | { status: 'failed'; errorCode: string };
  task: TaskResult;
}> {
  let qianwen: QianwenResult | { status: 'failed'; errorCode: string };
  try {
    qianwen = await dependencies.syncQianwen();
  } catch (error) {
    qianwen = {
      status: 'failed',
      errorCode: safeErrorCode(error),
    };
  }

  return {
    qianwen,
    task: await dependencies.runTask(),
  };
}
