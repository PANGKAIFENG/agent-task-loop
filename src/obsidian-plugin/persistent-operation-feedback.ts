export interface PersistentOperationFeedback {
  hide(): void;
}

export async function runWithPersistentFeedback<T>(
  feedback: PersistentOperationFeedback,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    feedback.hide();
  }
}
