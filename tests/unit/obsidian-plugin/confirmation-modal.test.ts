/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskConfirmationModal } from '../../../src/obsidian-plugin/confirmation-modal.js';

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
    const element = document.createElement(tag);
    const info = typeof options === 'string' ? { text: options } : options;
    if (info.cls !== undefined) {
      element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    }
    if (info.text instanceof DocumentFragment) element.append(info.text);
    else if (info.text !== undefined) element.textContent = info.text;
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    this.append(element);
    callback?.(element);
    return element;
  };
});

function prepared(status: 'inbox' | 'ready') {
  return {
    task: {
      taskId: `task-${status}`,
      title: '梳理执行上下文',
      body: '补齐目标与验收标准。',
      status,
      reviewState: status === 'inbox' ? 'candidate' : 'ready_for_confirm',
      projectId: null,
      objective: null,
      acceptanceCriteria: [],
      priority: 'normal',
    },
    projects: [],
  } as never;
}

describe('TaskConfirmationModal', () => {
  it.each([
    ['inbox', '移到待办', '项目、目标和完成条件都可以稍后补充。'],
    ['ready', '完善待办', '完整的执行上下文可继续授权给 Agent。'],
  ] as const)('renders the %s action consistently', (status, action, subtitle) => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      prepared(status),
    );

    modal.open();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe(action);
    expect(modal.contentEl.textContent).toContain(subtitle);
    expect([...modal.contentEl.querySelectorAll('button')].some((button) => (
      button.textContent === action
    ))).toBe(true);
  });
});
