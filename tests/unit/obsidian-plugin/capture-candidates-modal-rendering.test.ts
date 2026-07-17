// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { PreparedCapture } from '../../../src/obsidian-plugin/capture-controller.js';

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
    if (info.type !== undefined) element.setAttribute('type', info.type);
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    this.append(element);
    callback?.(element);
    return element;
  };
});

function preparedCapture(): PreparedCapture {
  return {
    scanId: 'scan-001',
    filesScanned: 2,
    recordsConsidered: 2,
    completedAt: '2026-07-17T07:00:00.000Z',
    processedRecordFingerprints: ['1'.repeat(64), '2'.repeat(64)],
    candidates: [
      {
        candidateId: 'candidate-1',
        title: '调研工具一',
        summary: '整理工具一的能力和适用场景。',
        priority: 'normal',
        sourceRecordFingerprint: '1'.repeat(64),
        sourceQuote: '调研工具一',
        sourceDate: '2026-07-17',
        sourceNote: '笔记同步助手/2026-07-17/记录.md',
        recordedAt: '2026-07-17T09:00:00+08:00',
      },
      {
        candidateId: 'candidate-2',
        title: '调研工具二',
        summary: '整理工具二的能力和适用场景。',
        priority: 'high',
        sourceRecordFingerprint: '2'.repeat(64),
        sourceQuote: '调研工具二',
        sourceDate: '2026-07-17',
        sourceNote: '笔记同步助手/2026-07-17/记录.md',
        recordedAt: '2026-07-17T10:00:00+08:00',
      },
    ],
  };
}

describe('CaptureCandidatesModal rendering', () => {
  it('renders every candidate when the Obsidian modal owns its selection field', async () => {
    const { CaptureCandidatesModal } = await import(
      '../../../src/obsidian-plugin/capture-candidates-modal.js'
    );
    const modal = new CaptureCandidatesModal(
      {} as never,
      preparedCapture(),
      vi.fn(async () => undefined),
    );

    expect(() => modal.open()).not.toThrow();
    expect(modal.contentEl.querySelectorAll('.atl-candidate-row')).toHaveLength(2);
    expect(modal.contentEl.textContent).toContain('调研工具一');
    expect(modal.contentEl.textContent).toContain('调研工具二');
  });
});
