/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.createDiv = function createDiv(options = {}): HTMLDivElement {
    return this.createEl('div', options);
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: DomElementInfo | string = {},
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    const info = typeof options === 'string' ? { text: options } : options;
    if (info.cls !== undefined) {
      node.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    }
    if (info.text instanceof DocumentFragment) node.append(info.text);
    else if (info.text !== undefined) node.textContent = info.text;
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) node.setAttribute(name, String(value));
    }
    this.append(node);
    callback?.(node);
    return node;
  };
});

function button(modal: { contentEl: HTMLElement }, label: string): HTMLButtonElement {
  const found = [...modal.contentEl.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('WeeklyFeedbackModal', () => {
  it('requires actionable feedback and submits normalized text', async () => {
    const { WeeklyFeedbackModal } = await import(
      '../../../src/obsidian-plugin/weekly-feedback-modal.js'
    );
    const onSubmit = vi.fn(async () => undefined);
    const modal = new WeeklyFeedbackModal({} as never, {
      weekKey: '2026-W33',
      version: 2,
    }, onSubmit);
    modal.open();

    expect(modal.contentEl.textContent).toContain('2026-W33');
    button(modal, '退回并生成新版').click();
    expect(modal.contentEl.textContent).toContain('请填写修改意见');
    expect(onSubmit).not.toHaveBeenCalled();

    const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="周报修改意见"]',
    )!;
    input.value = '  压缩背景，补充输出。  ';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '退回并生成新版').click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('压缩背景，补充输出。'));
  });

  it('blocks duplicate submits and keeps feedback after a failure', async () => {
    const { WeeklyFeedbackModal } = await import(
      '../../../src/obsidian-plugin/weekly-feedback-modal.js'
    );
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const onSubmit = vi.fn(() => pending);
    const modal = new WeeklyFeedbackModal({} as never, {
      weekKey: '2026-W33',
      version: 2,
    }, onSubmit);
    modal.open();
    const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="周报修改意见"]',
    )!;
    input.value = '保留关键结论';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));

    const submit = button(modal, '退回并生成新版');
    submit.click();
    submit.click();
    expect(onSubmit).toHaveBeenCalledOnce();

    reject(new Error('private implementation detail'));
    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('退回失败，请重试');
    });
    expect(modal.contentEl.textContent).not.toContain('private implementation detail');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="周报修改意见"]',
    )?.value).toBe('保留关键结论');
  });

  it('reports cancellation without treating a successful submit as cancellation', async () => {
    const { WeeklyFeedbackModal } = await import(
      '../../../src/obsidian-plugin/weekly-feedback-modal.js'
    );
    const onCancel = vi.fn();
    const cancelled = new WeeklyFeedbackModal(
      {} as never,
      { weekKey: '2026-W33', version: 2 },
      vi.fn(async () => undefined),
      onCancel,
    );
    cancelled.open();
    button(cancelled, '取消').click();
    expect(onCancel).toHaveBeenCalledOnce();

    const submitted = new WeeklyFeedbackModal(
      {} as never,
      { weekKey: '2026-W33', version: 2 },
      vi.fn(async () => undefined),
      onCancel,
    );
    submitted.open();
    const input = submitted.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="周报修改意见"]',
    )!;
    input.value = '补充输出';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(submitted, '退回并生成新版').click();
    await vi.waitFor(() => expect(submitted.contentEl.childElementCount).toBe(0));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
