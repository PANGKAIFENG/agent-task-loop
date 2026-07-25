/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import { CompletionDateBackfillModal } from '../../../src/obsidian-plugin/completion-date-backfill-modal.js';

const tasks = [
  { taskId: 'task-a', title: '补齐首页设计' },
  { taskId: 'task-b', title: '复盘用户反馈' },
];

function action(modal: CompletionDateBackfillModal, taskId: string): HTMLButtonElement {
  return modal.contentEl.querySelector<HTMLButtonElement>(
    `[data-backfill-task-id="${taskId}"] button`,
  )!;
}

function dateInput(modal: CompletionDateBackfillModal, taskId: string): HTMLInputElement {
  return modal.contentEl.querySelector<HTMLInputElement>(
    `[data-backfill-task-id="${taskId}"] input[type="date"]`,
  )!;
}

describe('CompletionDateBackfillModal', () => {
  it('lists every missing task and requires an explicit date', () => {
    const modal = new CompletionDateBackfillModal(
      {} as never,
      tasks,
      vi.fn(async () => undefined),
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain('补齐历史完成日期');
    expect(modal.contentEl.textContent).toContain('补齐首页设计');
    expect(modal.contentEl.textContent).toContain('复盘用户反馈');
    expect(modal.contentEl.querySelectorAll('.atl-completion-backfill-row')).toHaveLength(2);
    expect(action(modal, 'task-a').disabled).toBe(true);

    const input = dateInput(modal, 'task-a');
    input.value = '2026-07-18';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(action(modal, 'task-a').disabled).toBe(false);
  });

  it('blocks duplicate submission and removes only the successfully repaired row', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const onSubmit = vi.fn(async () => pending);
    const modal = new CompletionDateBackfillModal({} as never, tasks, onSubmit);
    modal.open();
    const input = dateInput(modal, 'task-a');
    input.value = '2026-07-18';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    action(modal, 'task-a').click();
    action(modal, 'task-a').click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('task-a', '2026-07-18');
    expect(modal.contentEl.querySelector('[data-backfill-task-id="task-a"]')).not.toBeNull();

    resolve();
    await vi.waitFor(() => {
      expect(modal.contentEl.querySelector('[data-backfill-task-id="task-a"]')).toBeNull();
    });
    expect(modal.contentEl.querySelector('[data-backfill-task-id="task-b"]')).not.toBeNull();
  });

  it('keeps the task and shows a generic retry message after failure', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('sensitive storage detail');
    });
    const modal = new CompletionDateBackfillModal({} as never, tasks, onSubmit);
    modal.open();
    const input = dateInput(modal, 'task-a');
    input.value = '2026-07-18';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    action(modal, 'task-a').click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('补齐失败，请重试');
    });
    expect(modal.contentEl.textContent).not.toContain('sensitive storage detail');
    expect(modal.contentEl.querySelector('[data-backfill-task-id="task-a"]')).not.toBeNull();
  });

  it('rechecks Vault management permission immediately before submitting', () => {
    let allowed = true;
    const onSubmit = vi.fn(async () => undefined);
    const modal = new CompletionDateBackfillModal(
      {} as never,
      tasks,
      onSubmit,
      () => allowed,
    );
    modal.open();
    const input = dateInput(modal, 'task-a');
    input.value = '2026-07-18';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    allowed = false;
    action(modal, 'task-a').click();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('Vault 管理权限已关闭');
    expect(modal.contentEl.querySelector('[data-backfill-task-id="task-a"]')).not.toBeNull();
  });
});
