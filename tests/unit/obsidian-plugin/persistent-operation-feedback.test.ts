import { describe, expect, it, vi } from 'vitest';

import { runWithPersistentFeedback } from '../../../src/obsidian-plugin/persistent-operation-feedback.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runWithPersistentFeedback', () => {
  it('keeps feedback visible until the operation completes', async () => {
    const operation = deferred<string>();
    const feedback = { hide: vi.fn() };

    const result = runWithPersistentFeedback(
      feedback,
      async () => operation.promise,
    );

    expect(feedback.hide).not.toHaveBeenCalled();
    operation.resolve('done');
    await expect(result).resolves.toBe('done');
    expect(feedback.hide).toHaveBeenCalledOnce();
  });

  it('hides feedback when the operation fails', async () => {
    const feedback = { hide: vi.fn() };

    await expect(runWithPersistentFeedback(feedback, async () => {
      throw new Error('scan failed');
    })).rejects.toThrow('scan failed');
    expect(feedback.hide).toHaveBeenCalledOnce();
  });
});
