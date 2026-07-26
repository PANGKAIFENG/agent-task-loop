/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskBriefModal } from '../../../src/obsidian-plugin/task-brief-modal.js';

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
    this.append(element);
    callback?.(element);
    return element;
  };
});

function button(modal: TaskBriefModal, label: string): HTMLButtonElement {
  return [...modal.contentEl.querySelectorAll('button')].find((candidate) => (
    candidate.textContent?.includes(label) === true
  ))!;
}

function textArea(modal: TaskBriefModal, label: string): HTMLTextAreaElement {
  return modal.contentEl.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function prepared(taskBrief: unknown = null) {
  return {
    task: {
      taskId: 'task-synthetic-brief',
      title: '梳理任务面板字段',
      body: '需要明确一期哪些字段保留。',
      taskBrief,
    },
    project: {
      projectId: 'personal-workbench',
      name: '个人工作台',
      description: '管理个人任务与复盘',
    },
  } as never;
}

describe('TaskBriefModal', () => {
  it('shows existing brief fields and saves without invoking the model or Agent', async () => {
    const save = vi.fn(async () => ({} as never));
    const generate = vi.fn(async () => ({
      objective: '模型目标',
      nextAction: '模型下一步',
      completionCriteria: '模型完成条件',
    }));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared({
        schemaVersion: 1,
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
        updatedAt: '2026-07-26T08:30:00.000Z',
      }),
      generate,
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain('智能完善任务');
    expect(modal.contentEl.textContent).toContain(
      '基于已有信息智能梳理任务上下文，并通过对话与你共同补全目标、行动步骤和完成标准。',
    );
    expect(modal.contentEl.textContent).toContain('智能建议');
    expect(modal.contentEl.textContent).not.toContain('AI 帮我想清楚');
    expect(modal.contentEl.textContent).not.toContain('交给 Agent');
    expect(textArea(modal, '任务目标').value).toBe('已有目标');
    expect(textArea(modal, '下一步动作').value).toBe('已有下一步');
    expect(textArea(modal, '完成条件').value).toBe('已有完成条件');

    expect(button(modal, '开始智能完善')).toBeDefined();
    button(modal, '确认并保存').click();

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(
      'task-synthetic-brief',
      {
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
      },
      '2026-07-26T08:30:00.000Z',
    ));
    expect(generate).not.toHaveBeenCalled();
  });

  it('locks brief fields while generation or saving is in progress', async () => {
    const generated = deferred<{
      objective: string;
      nextAction: string;
      completionCriteria: string;
    }>();
    const saved = deferred<never>();
    const save = vi.fn(() => saved.promise);
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared(),
      () => generated.promise,
    );
    modal.open();

    button(modal, '开始智能完善').click();

    expect(textArea(modal, '任务目标').disabled).toBe(true);
    expect(textArea(modal, '下一步动作').disabled).toBe(true);
    expect(textArea(modal, '完成条件').disabled).toBe(true);

    generated.resolve({
      objective: '生成目标',
      nextAction: '生成下一步',
      completionCriteria: '生成完成条件',
    });
    await vi.waitFor(() => {
      expect(textArea(modal, '任务目标').value).toBe('生成目标');
    });

    button(modal, '确认并保存').click();

    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(textArea(modal, '任务目标').disabled).toBe(true);
    expect(textArea(modal, '下一步动作').disabled).toBe(true);
    expect(textArea(modal, '完成条件').disabled).toBe(true);

    saved.resolve({} as never);
    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('任务简报已保存');
    });
  });

  it('fills all fields from AI and keeps them editable when generation fails', async () => {
    const save = vi.fn(async () => ({} as never));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        objective: '生成目标',
        nextAction: '生成下一步',
        completionCriteria: '生成完成条件',
      })
      .mockRejectedValueOnce(new Error('private provider detail'));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared(),
      generate,
    );
    modal.open();

    button(modal, '开始智能完善').click();
    await vi.waitFor(() => {
      expect(textArea(modal, '任务目标').value).toBe('生成目标');
    });
    expect(textArea(modal, '下一步动作').value).toBe('生成下一步');
    expect(textArea(modal, '完成条件').value).toBe('生成完成条件');

    textArea(modal, '下一步动作').value = '人工修改后的下一步';
    textArea(modal, '下一步动作').dispatchEvent(new Event('input'));
    button(modal, '开始智能完善').click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('AI 暂时无法生成');
    });
    expect(modal.contentEl.textContent).not.toContain('private provider detail');
    expect(textArea(modal, '下一步动作').value).toBe('人工修改后的下一步');
    expect(button(modal, '确认并保存').disabled).toBe(false);
  });

  it('reports success when the brief was saved but the task index is stale', async () => {
    const staleIndexError = Object.assign(new Error('private index detail'), {
      code: 'task_saved_index_stale',
    });
    const save = vi.fn(async () => Promise.reject(staleIndexError));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared({
        schemaVersion: 1,
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
        updatedAt: '2026-07-26T08:30:00.000Z',
      }),
    );
    modal.open();

    button(modal, '确认并保存').click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('任务简报已保存');
    });
    expect(modal.contentEl.textContent).toContain('任务索引暂未刷新');
    expect(modal.contentEl.textContent).not.toContain('private index detail');
  });
});
