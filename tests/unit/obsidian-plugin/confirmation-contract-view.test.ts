/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import { renderDevelopmentContract } from '../../../src/obsidian-plugin/confirmation-contract-view.js';

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
  HTMLElement.prototype.createSpan = function createSpan(options = {}): HTMLSpanElement {
    return this.createEl('span', options);
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

function developmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260822-dev00001',
    title: 'One-click Multica dispatch entry',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-agent-task-loop',
    taskType: 'development',
    objective: 'Dispatch a development task from Obsidian',
    acceptanceCriteria: ['Exactly one Multica issue per confirmation'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:contract-view-1',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-22T00:00:00.000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function render(
  task: Task,
  repoDeliveryAcknowledged: boolean,
  callbacks: Partial<Parameters<typeof renderDevelopmentContract>[1]> = {},
): HTMLElement {
  const container = document.createElement('div');
  renderDevelopmentContract(container, {
    task,
    projectName: 'Agent Task Loop',
    repoDeliveryAcknowledged,
    onBackToForm: vi.fn(),
    onDefer: vi.fn(),
    onDispatch: vi.fn(),
    onAcknowledgementChange: vi.fn(),
    ...callbacks,
  });
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => (
    button.textContent === text
  )) as HTMLButtonElement | undefined;
}

function summaryLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.atl-task-brief-summary-row dt')]
    .map((element) => element.textContent ?? '');
}

describe('renderDevelopmentContract (PAW-GOAL-003-V0.5 D1)', () => {
  it('renders the full contract summary for a dispatchable task', () => {
    const container = render(developmentTask(), true);
    expect(container.querySelector('h2')?.textContent).toBe('Task Contract');
    expect(summaryLabels(container)).toEqual([
      '目标', '验收标准', '项目', '上下文引用', '权限范围', '执行目标',
    ]);
    expect(container.textContent).toContain('Dispatch a development task from Obsidian');
    expect(container.textContent).toContain('Agent Task Loop');
    expect(container.textContent).toContain('repo_delivery · 允许在目标仓库内交付代码');
    expect(container.textContent).toContain('Multica');
    expect(container.querySelector('.atl-gap-list')).toBeNull();
    const dispatch = buttonByText(container, '确认并交给 Multica');
    expect(dispatch?.disabled).toBe(false);
  });

  it('promises exactly one Multica issue and no external write before the click', () => {
    const container = render(developmentTask(), true);
    expect(container.textContent).toContain('确认后将创建唯一的 Multica Issue');
    expect(container.textContent).toContain('点击确认前不会创建 Issue、分支或发送任何通知');
  });

  it('disables the dispatch button and lists each gap while gaps remain', () => {
    const container = render(developmentTask({ objective: null }), true);
    const banner = container.querySelector('.atl-task-brief-banner');
    expect(banner?.classList.contains('is-error')).toBe(true);
    const gaps = [...container.querySelectorAll('.atl-gap-item')].map((item) => item.textContent);
    expect(gaps).toEqual(['请填写任务目标']);
    expect(buttonByText(container, '确认并交给 Multica')?.disabled).toBe(true);
  });

  it('shows the permission gap when the declaration is unacknowledged', () => {
    const container = render(developmentTask(), false);
    const gaps = [...container.querySelectorAll('.atl-gap-item')].map((item) => item.textContent);
    expect(gaps).toEqual(['权限声明未确认：请勾选 repo_delivery 授权说明']);
    expect(container.textContent).toContain('repo_delivery（勾选未生效：下方缺口未清）');
    expect(buttonByText(container, '确认并交给 Multica')?.disabled).toBe(true);
  });

  it('wires the acknowledgement checkbox, defer, and back actions', async () => {
    const onAcknowledgementChange = vi.fn();
    const onBackToForm = vi.fn();
    const onDefer = vi.fn();
    const onDispatch = vi.fn();
    const container = document.createElement('div');
    renderDevelopmentContract(container, {
      task: developmentTask(),
      projectName: 'Agent Task Loop',
      repoDeliveryAcknowledged: true,
      onBackToForm,
      onDefer,
      onDispatch,
      onAcknowledgementChange,
    });
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(true);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event('change'));
    expect(onAcknowledgementChange).toHaveBeenCalledWith(false);
    buttonByText(container, '返回修改')?.click();
    expect(onBackToForm).toHaveBeenCalledTimes(1);
    buttonByText(container, '稍后再投')?.click();
    expect(onDefer).toHaveBeenCalledTimes(1);
    buttonByText(container, '确认并交给 Multica')?.click();
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('ignores dispatch clicks while the button is disabled', () => {
    const onDispatch = vi.fn();
    const container = render(developmentTask({ objective: null }), true, { onDispatch });
    buttonByText(container, '确认并交给 Multica')?.click();
    expect(onDispatch).not.toHaveBeenCalled();
  });
});
