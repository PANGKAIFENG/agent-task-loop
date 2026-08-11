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

function setInput(modal: { contentEl: HTMLElement }, label: string, value: string): void {
  const input = modal.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (input === null) throw new Error(`Missing input: ${label}`);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

describe('ProgressEntryModal', () => {
  it('requires the reporting contract and submits a normalized progress draft', async () => {
    const { ProgressEntryModal } = await import(
      '../../../src/obsidian-plugin/work-progress-entry-modal.js'
    );
    const onSubmit = vi.fn(async () => undefined);
    const modal = new ProgressEntryModal(
      {} as never,
      onSubmit,
      undefined,
      () => new Date('2026-08-11T02:30:00.000Z'),
    );
    modal.open();

    button(modal, '创建进展').click();
    expect(modal.contentEl.textContent).toContain('请补齐所有必填项');
    expect(onSubmit).not.toHaveBeenCalled();

    setInput(modal, '进展主题', '  精恭纺验收分类  ');
    setInput(modal, '主项目 ID', ' project-a ');
    setInput(modal, '发生时间', '2026-08-11T10:30');
    setInput(modal, '来源', ' 08_Meetings/2026-08/meeting-a.md ');
    setInput(modal, '进展说明', ' 已确认四类验收事项。 ');
    const evidence = modal.contentEl.querySelector<HTMLSelectElement>(
      'select[aria-label="证据类型"]',
    )!;
    evidence.value = 'confirmed_decision';
    evidence.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '创建进展').click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      topic: '精恭纺验收分类',
      reportCategory: 'project_acceptance',
      primaryProjectId: 'project-a',
      occurredAt: '2026-08-11T10:30:00+08:00',
      sources: ['08_Meetings/2026-08/meeting-a.md'],
      statements: [{
        kind: 'fact',
        text: '已确认四类验收事项。',
        sourceRefs: ['08_Meetings/2026-08/meeting-a.md'],
      }],
      evidence: [{
        kind: 'confirmed_decision',
        summary: '已确认四类验收事项。',
        sourceRef: '08_Meetings/2026-08/meeting-a.md',
      }],
      selfEvidence: [],
      agentEvidence: [],
    }));
  });

  it('opens a meeting-derived draft with conservative evidence prefilled', async () => {
    const { ProgressEntryModal } = await import(
      '../../../src/obsidian-plugin/work-progress-entry-modal.js'
    );
    const initial = {
      topic: '验收分类',
      reportCategory: 'routine_check' as const,
      primaryProjectId: null,
      occurredAt: '2026-08-10T17:00:00+08:00',
      sources: ['08_Meetings/2026-08/meeting-a.md'],
      statements: [{
        kind: 'pending' as const,
        text: '已讨论按四类整理验收事项。',
        sourceRefs: ['08_Meetings/2026-08/meeting-a.md'],
      }],
      evidence: [{
        kind: 'discussion' as const,
        summary: '已讨论按四类整理验收事项。',
        sourceRef: '08_Meetings/2026-08/meeting-a.md',
      }],
      selfEvidence: [],
      agentEvidence: [],
    };
    const modal = new ProgressEntryModal(
      {} as never,
      vi.fn(async () => undefined),
      undefined,
      () => new Date('2026-08-12T00:00:00.000Z'),
      initial,
    );
    modal.open();

    expect(modal.contentEl.querySelector<HTMLInputElement>('[aria-label="进展主题"]')?.value)
      .toBe('验收分类');
    expect(modal.contentEl.querySelector<HTMLInputElement>('[aria-label="主项目 ID"]')?.value)
      .toBe('');
    expect(modal.contentEl.querySelector<HTMLInputElement>('[aria-label="发生时间"]')?.value)
      .toBe('2026-08-10T17:00');
    expect(modal.contentEl.querySelector<HTMLSelectElement>('[aria-label="证据类型"]')?.value)
      .toBe('discussion');
  });

  it('reports cancellation without submitting', async () => {
    const { ProgressEntryModal } = await import(
      '../../../src/obsidian-plugin/work-progress-entry-modal.js'
    );
    const onSubmit = vi.fn(async () => undefined);
    const onCancel = vi.fn();
    const modal = new ProgressEntryModal({} as never, onSubmit, onCancel);
    modal.open();

    button(modal, '取消').click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('MaterialGapEntryModal', () => {
  it('binds an explicit progress version and starts with no search or contact claims', async () => {
    const { MaterialGapEntryModal } = await import(
      '../../../src/obsidian-plugin/work-progress-entry-modal.js'
    );
    const onSubmit = vi.fn(async () => undefined);
    const modal = new MaterialGapEntryModal({} as never, [{
      progressId: 'progress-a',
      version: 2,
      topic: '精恭纺验收分类',
      projectId: 'project-a',
      lifecycleStatus: 'needs_material',
      path: '09_Progress/Items/2026-08/progress-a-v2.md',
    }], onSubmit);
    modal.open();

    setInput(modal, '缺口说明', ' 四类事项的准确数量 ');
    setInput(modal, '使用目的', ' 精恭纺验收周报 ');
    button(modal, '登记缺口').click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      progressId: 'progress-a',
      progressVersion: 2,
      missing: {
        kind: 'numeric',
        description: '四类事项的准确数量',
        purpose: '精恭纺验收周报',
      },
    }));
  });
});
