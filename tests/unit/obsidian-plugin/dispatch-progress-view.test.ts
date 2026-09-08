/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  renderDispatchInProgress,
  renderDispatchResult,
} from '../../../src/obsidian-plugin/dispatch-progress-view.js';
import type { DispatchResultView } from '../../../src/obsidian-plugin/dispatch-outcome-view.js';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.setText = function setText(value: string): void {
    this.textContent = value;
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

function renderResult(view: DispatchResultView): HTMLElement {
  const container = document.createElement('div');
  renderDispatchResult(container, {
    view,
    taskTitle: '支持从看板一键重建 Multica 绑定',
    completedAt: '2026-08-22T15:40:00.000Z',
    onClose: vi.fn(),
    onConflictAcknowledge: vi.fn(),
    onRetryFromPalette: vi.fn(),
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => (
    button.textContent === text
  )) as HTMLButtonElement | undefined;
}

describe('renderDispatchInProgress (PRD 4.3)', () => {
  it('locks the view with a single disabled button and the lease expectation', () => {
    const container = document.createElement('div');
    renderDispatchInProgress(container, {
      taskTitle: '支持从看板一键重建 Multica 绑定',
      startedAtMs: 1_000,
      nowMs: 43_000,
    });
    expect(container.querySelector('h2')?.textContent).toBe('正在交给 Multica…');
    expect(container.querySelector('.atl-progress-spinner')).not.toBeNull();
    expect(container.textContent).toContain('00:42');
    expect(container.textContent).toContain('最长约 2 分钟');
    expect(container.textContent).toContain('不会产生第二个 Issue');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.disabled).toBe(true);
  });
});

describe('renderDispatchResult (PRD 4.4)', () => {
  it('renders the success projection with the bound TEP identifier only', () => {
    const container = renderResult({
      status: 'linked',
      issueId: '01234567-89ab-4cde-8f01-234567890abc',
      issueIdentifier: 'TEP-152',
      dispatchedAt: '2026-08-22T15:40:00.000Z',
      recovered: false,
    });
    expect(container.querySelector('h2')?.textContent).toBe('已交给 Multica');
    expect(container.textContent).toContain('TEP-152');
    expect(container.textContent).toContain('agent_executable');
    expect(container.querySelector('.atl-task-brief-banner')?.classList.contains('is-success'))
      .toBe(true);
    expect(buttonByText(container, '完成')?.disabled).toBe(false);
  });

  it('renders reconciling with re-dispatch disabled and the reason it cannot retry', () => {
    const container = renderResult({
      status: 'reconciling',
      reason: 'dispatch already in flight',
    });
    expect(container.querySelector('h2')?.textContent).toBe('对账中');
    expect(container.textContent).toContain('再次投递已禁用');
    expect(container.textContent).toContain('为什么不能再次投递？');
    expect(buttonByText(container, '再次投递')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('TEP-');
  });

  it('renders the conflict state with candidates and a manual next step', () => {
    const container = renderResult({
      status: 'conflict',
      candidateIssueIds: ['TEP-151', 'TEP-149'],
    });
    expect(container.querySelector('h2')?.textContent).toBe('需要人工处理');
    expect(container.textContent).toContain('TEP-151');
    expect(container.textContent).toContain('TEP-149');
    expect(container.textContent).toContain('duplicate_conflict');
    expect(container.querySelector('.atl-task-brief-banner')?.classList.contains('is-error'))
      .toBe(true);
    expect(buttonByText(container, '再次投递')).toBeUndefined();
  });

  it('renders failure with the concrete reason and re-dispatch guidance', () => {
    const container = renderResult({
      status: 'failed',
      reason: 'multica_unreachable',
    });
    expect(container.querySelector('h2')?.textContent).toBe('投递失败');
    expect(container.textContent).toContain('multica_unreachable');
    expect(container.textContent).toContain('不会自动重试');
    expect(container.textContent).toContain('从命令面板重新投递');
    expect(buttonByText(container, '稍后从命令面板重投')).toBeDefined();
  });

  it('never renders a TEP identifier for a non-linked outcome', () => {
    const failed = renderResult({ status: 'failed', reason: 'boom' });
    expect(failed.textContent).not.toContain('TEP-');
    const conflict = renderResult({ status: 'conflict', candidateIssueIds: ['issue-uuid'] });
    expect(conflict.textContent).not.toMatch(/TEP-\d+/u);
  });
});
