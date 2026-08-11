/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TaskNotesTaskBriefActionBridge,
} from '../../../src/obsidian-plugin/tasknotes-task-brief-action-bridge.js';

const TASK_PATH = '10_Tasks/Inbox/评估 TaskNotes 工作流.md';

function taskNotesModal(options: {
  extraText?: string;
  hiddenPaths?: string[];
  includeOpenNote?: boolean;
  metadataPaths?: string[];
  outsideCta?: HTMLButtonElement;
  path?: string;
} = {}, targetDocument: Document = document): HTMLDivElement {
  const modal = targetDocument.createElement('div');
  modal.className = 'minimalist-task-modal';
  const close = targetDocument.createElement('button');
  close.className = 'modal-close-button';
  close.textContent = 'Close';
  modal.append(close);

  const metadata = targetDocument.createElement('div');
  metadata.className = 'metadata-content';
  for (const path of options.metadataPaths ?? [options.path ?? TASK_PATH]) {
    const item = targetDocument.createElement('div');
    item.className = 'metadata-item';
    const value = targetDocument.createElement('span');
    value.className = 'metadata-value';
    value.textContent = path;
    item.append(value);
    metadata.append(item);
  }
  for (const path of options.hiddenPaths ?? []) {
    const item = targetDocument.createElement('div');
    item.className = 'metadata-item';
    item.hidden = true;
    const value = targetDocument.createElement('span');
    value.className = 'metadata-value';
    value.textContent = path;
    item.append(value);
    metadata.append(item);
  }
  modal.append(metadata);
  if (options.extraText) {
    modal.append(targetDocument.createTextNode(options.extraText));
  }

  if (options.outsideCta) modal.append(options.outsideCta);

  const buttonBar = targetDocument.createElement('div');
  buttonBar.className = 'tn-task-modal__button-bar';

  if (options.includeOpenNote !== false) {
    const openNote = targetDocument.createElement('button');
    openNote.className = 'tn-task-modal__open-note-button';
    openNote.textContent = '打开笔记';
    buttonBar.append(openNote);
  }

  const save = targetDocument.createElement('button');
  save.className = 'mod-cta';
  save.textContent = '保存';
  const cancel = targetDocument.createElement('button');
  cancel.textContent = '取消';
  buttonBar.append(save, cancel);
  modal.append(buttonBar);
  targetDocument.body.append(modal);
  return modal;
}

function fixture(options: {
  taskNotesEnabled?: boolean;
  taskPaths?: string[];
  saveTimeoutMs?: number;
} = {}) {
  const open = vi.fn();
  const notice = vi.fn();
  const setIcon = vi.fn((element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  });
  const bridge = new TaskNotesTaskBriefActionBridge({
    document,
    isTaskNotesEnabled: () => options.taskNotesEnabled ?? true,
    getEligibleTaskPaths: () => options.taskPaths ?? [TASK_PATH],
    open,
    notice,
    setIcon,
    saveTimeoutMs: options.saveTimeoutMs ?? 100,
  });
  return { bridge, open, notice, setIcon };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('TaskNotesTaskBriefActionBridge', () => {
  it('injects one smart action before Open note in an existing edit modal', () => {
    const modal = taskNotesModal();
    const context = fixture();

    context.bridge.start();

    const action = modal.querySelector<HTMLButtonElement>(
      '[data-atl-task-brief-action]',
    );
    const openNote = modal.querySelector('.tn-task-modal__open-note-button');
    expect(action).not.toBeNull();
    expect(action?.textContent).toContain('智能完善');
    expect(action?.classList.contains('mod-cta')).toBe(false);
    expect(action?.nextElementSibling).toBe(openNote);
    expect(context.setIcon).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      'sparkles',
    );

    context.bridge.stop();
  });

  it('injects into an edit modal added after start and remains idempotent', async () => {
    const context = fixture();
    context.bridge.start();

    const modal = taskNotesModal();
    await Promise.resolve();
    modal.append(document.createElement('span'));
    await Promise.resolve();

    expect(modal.querySelectorAll('[data-atl-task-brief-action]')).toHaveLength(1);

    context.bridge.stop();
  });

  it('does not inject into a TaskNotes create modal', () => {
    const modal = taskNotesModal({ includeOpenNote: false });
    const context = fixture();

    context.bridge.start();

    expect(modal.querySelector('[data-atl-task-brief-action]')).toBeNull();
    context.bridge.stop();
  });

  it('does not inject into an ordinary Obsidian modal', () => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = '<div class="modal-button-container"><button>保存</button></div>';
    document.body.append(modal);
    const context = fixture();

    context.bridge.start();

    expect(modal.querySelector('[data-atl-task-brief-action]')).toBeNull();
    context.bridge.stop();
  });

  it('does not start DOM enhancement when TaskNotes is disabled', () => {
    const modal = taskNotesModal();
    const context = fixture({ taskNotesEnabled: false });

    context.bridge.start();

    expect(modal.querySelector('[data-atl-task-brief-action]')).toBeNull();
    context.bridge.stop();
  });

  it('enhances a modal when TaskNotes becomes enabled after ATL starts', async () => {
    let taskNotesEnabled = false;
    const bridge = new TaskNotesTaskBriefActionBridge({
      document,
      isTaskNotesEnabled: () => taskNotesEnabled,
      getEligibleTaskPaths: () => [TASK_PATH],
      open: vi.fn(),
      notice: vi.fn(),
      setIcon: vi.fn(),
    });
    bridge.start();

    taskNotesEnabled = true;
    const modal = taskNotesModal();
    await Promise.resolve();

    expect(modal.querySelector('[data-atl-task-brief-action]')).not.toBeNull();
    bridge.stop();
  });

  it('enhances and cleans up TaskNotes modals in a popout document', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const popoutDocument = iframe.contentDocument!;
    const primaryModal = taskNotesModal();
    const popoutModal = taskNotesModal({}, popoutDocument);
    const context = fixture();

    context.bridge.start();
    context.bridge.addDocument(popoutDocument);

    expect(primaryModal.querySelector('[data-atl-task-brief-action]')).not.toBeNull();
    expect(popoutModal.querySelector('[data-atl-task-brief-action]')).not.toBeNull();

    context.bridge.removeDocument(popoutDocument);

    expect(primaryModal.querySelector('[data-atl-task-brief-action]')).not.toBeNull();
    expect(popoutModal.querySelector('[data-atl-task-brief-action]')).toBeNull();
    context.bridge.stop();
  });

  it('saves the uniquely matched task before opening ATL', async () => {
    const modal = taskNotesModal();
    const save = modal.querySelector<HTMLButtonElement>('button.mod-cta');
    const context = fixture();
    const order: string[] = [];
    save?.addEventListener('click', () => {
      order.push('save');
      modal.remove();
    });
    context.open.mockImplementation(() => order.push('open'));
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();
    await Promise.resolve();

    expect(order).toEqual(['save', 'open']);
    expect(context.open).toHaveBeenCalledWith(TASK_PATH);
    context.bridge.stop();
  });

  it('disables the action while TaskNotes is saving', () => {
    const modal = taskNotesModal();
    const context = fixture();
    context.bridge.start();
    const action = modal.querySelector<HTMLButtonElement>(
      '[data-atl-task-brief-action]',
    );

    action?.click();

    expect(action?.disabled).toBe(true);
    expect(action?.textContent).toContain('正在保存...');
    expect(context.open).not.toHaveBeenCalled();
    context.bridge.stop();
  });

  it('blocks cancel, close, and Escape until the native save finishes', () => {
    vi.useFakeTimers();
    const modal = taskNotesModal();
    const context = fixture({ saveTimeoutMs: 100 });
    const cancel = Array.from(modal.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === '取消')!;
    const close = modal.querySelector<HTMLButtonElement>('.modal-close-button')!;
    cancel.addEventListener('click', () => modal.remove());
    close.addEventListener('click', () => modal.remove());
    modal.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') modal.remove();
    });
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();
    cancel.click();
    close.click();
    modal.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Escape',
    }));

    expect(modal.isConnected).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(context.open).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(cancel.disabled).toBe(false);
    context.bridge.stop();
  });

  it('blocks a sibling modal background from dismissing during native save', async () => {
    vi.useFakeTimers();
    const modalContainer = document.createElement('div');
    modalContainer.className = 'modal-container';
    const modalBackground = document.createElement('div');
    modalBackground.className = 'modal-bg';
    const modal = taskNotesModal();
    modalContainer.append(modalBackground, modal);
    document.body.append(modalContainer);
    modalBackground.addEventListener('click', () => modal.remove());
    const context = fixture({ saveTimeoutMs: 100 });
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();
    modalBackground.click();
    await Promise.resolve();

    expect(modal.isConnected).toBe(true);
    expect(context.open).not.toHaveBeenCalled();
    context.bridge.stop();
  });

  it('matches only the exact visible TaskNotes metadata path', async () => {
    const currentPath = '10_Tasks/Inbox/task.md-copy.md';
    const prefixPath = '10_Tasks/Inbox/task.md';
    const unrelatedPath = '10_Tasks/Inbox/另一个任务.md';
    const modal = taskNotesModal({
      extraText: `详情中提到了 ${unrelatedPath}`,
      hiddenPaths: [prefixPath],
      path: currentPath,
    });
    modal.querySelector<HTMLButtonElement>('button.mod-cta')
      ?.addEventListener('click', () => modal.remove());
    const context = fixture({
      taskPaths: [prefixPath, currentPath, unrelatedPath],
    });
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();
    await Promise.resolve();

    expect(context.open).toHaveBeenCalledWith(currentPath);
    context.bridge.stop();
  });

  it.each([
    { name: 'no eligible path', taskPaths: [] },
    {
      name: 'multiple eligible paths',
      taskPaths: [TASK_PATH, '10_Tasks/Inbox/另一个任务.md'],
    },
  ])('fails closed with $name', ({ taskPaths }) => {
    const modal = taskNotesModal({ metadataPaths: taskPaths });
    const save = modal.querySelector<HTMLButtonElement>('button.mod-cta');
    const saveClick = vi.fn();
    save?.addEventListener('click', saveClick);
    const context = fixture({ taskPaths });
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();

    expect(saveClick).not.toHaveBeenCalled();
    expect(context.open).not.toHaveBeenCalled();
    expect(context.notice).toHaveBeenCalledWith(
      '无法识别当前任务，请使用文件菜单中的智能完善任务',
    );
    expect(modal.isConnected).toBe(true);
    context.bridge.stop();
  });

  it('does not open ATL when the native Save button is unavailable', () => {
    const modal = taskNotesModal();
    modal.querySelector('button.mod-cta')?.remove();
    const context = fixture();
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();

    expect(context.open).not.toHaveBeenCalled();
    expect(context.notice).toHaveBeenCalledWith(
      '任务尚未保存，请检查当前字段后重试',
    );
    expect(modal.isConnected).toBe(true);
    context.bridge.stop();
  });

  it('uses the Save button from the TaskNotes button bar', async () => {
    const outsideCta = document.createElement('button');
    outsideCta.className = 'mod-cta';
    const outsideClick = vi.fn();
    outsideCta.addEventListener('click', outsideClick);
    const modal = taskNotesModal({ outsideCta });
    const nativeSave = modal.querySelector<HTMLButtonElement>(
      '.tn-task-modal__button-bar button.mod-cta',
    );
    nativeSave?.addEventListener('click', () => modal.remove());
    const context = fixture();
    context.bridge.start();

    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();
    await Promise.resolve();

    expect(outsideClick).not.toHaveBeenCalled();
    expect(context.open).toHaveBeenCalledWith(TASK_PATH);
    context.bridge.stop();
  });

  it('restores the action and reports when saving times out', () => {
    vi.useFakeTimers();
    const modal = taskNotesModal();
    const context = fixture({ saveTimeoutMs: 100 });
    context.bridge.start();
    const action = modal.querySelector<HTMLButtonElement>(
      '[data-atl-task-brief-action]',
    );
    action?.click();

    vi.advanceTimersByTime(100);

    expect(action?.disabled).toBe(false);
    expect(action?.textContent).toContain('智能完善');
    expect(context.open).not.toHaveBeenCalled();
    expect(context.notice).toHaveBeenCalledWith(
      '任务尚未保存，请检查当前字段后重试',
    );
    context.bridge.stop();
  });

  it('cancels pending waits and removes actions on stop', () => {
    vi.useFakeTimers();
    const modal = taskNotesModal();
    const context = fixture({ saveTimeoutMs: 100 });
    context.bridge.start();
    modal.querySelector<HTMLButtonElement>('[data-atl-task-brief-action]')?.click();

    context.bridge.stop();
    vi.runAllTimers();
    modal.remove();

    expect(document.querySelector('[data-atl-task-brief-action]')).toBeNull();
    expect(context.notice).not.toHaveBeenCalled();
    expect(context.open).not.toHaveBeenCalled();
  });
});
