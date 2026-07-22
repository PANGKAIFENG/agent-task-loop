// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DingTalkMeetingSource } from '../../../src/obsidian-plugin/meeting-note.js';

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

const source: DingTalkMeetingSource = {
  eventPath: `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`,
  eventKeyHash: `sha256:${'a'.repeat(64)}`,
  title: '候选人二面',
  scheduled: '2026-07-22T14:00:00+08:00',
  meetingDate: '2026-07-22',
};

function button(modal: { contentEl: HTMLElement }, label: string): HTMLButtonElement {
  const match = [...modal.contentEl.querySelectorAll('button')].find((item) => (
    item.textContent === label
  ));
  if (match === undefined) throw new Error(`Missing button: ${label}`);
  return match;
}

describe('MeetingTranscriptModal', () => {
  it('renders event context and the two explicit save actions', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const modal = new MeetingTranscriptModal(
      {} as never,
      source,
      vi.fn(async () => undefined),
    );

    modal.open();

    expect(modal.modalEl.classList).toContain('atl-meeting-transcript-modal');
    expect(modal.contentEl.textContent).toContain('候选人二面');
    expect(modal.contentEl.textContent).toContain('2026-07-22 14:00');
    expect(button(modal, '仅保存')).toBeTruthy();
    expect(button(modal, '保存并分析')).toBeTruthy();
    expect(modal.contentEl.querySelector('textarea[aria-label="会议听记原文"]'))
      .not.toBeNull();
  });

  it('validates the transcript and submits normalized data for analysis', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const onSubmit = vi.fn(async () => undefined);
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit);
    modal.open();

    button(modal, '保存并分析').click();
    expect(modal.contentEl.textContent).toContain('请粘贴会议听记原文');
    expect(onSubmit).not.toHaveBeenCalled();

    const transcript = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )!;
    transcript.value = '候选人：这是原文。\n';
    transcript.dispatchEvent(new window.Event('input', { bubbles: true }));
    const participants = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="参与人"]',
    )!;
    participants.value = '候选人，面试官';
    participants.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '保存并分析').click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      meetingType: 'discussion',
      participants: ['候选人', '面试官'],
      transcript: '候选人：这是原文。\n',
    }, 'analyze'));
  });

  it('blocks duplicate submits and keeps the transcript recoverable after failure', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const onSubmit = vi.fn(() => pending);
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit);
    modal.open();
    const original = '仅应存在于编辑框的完整听记原文';
    const transcript = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )!;
    transcript.value = original;
    transcript.dispatchEvent(new window.Event('input', { bubbles: true }));

    const save = button(modal, '仅保存');
    save.click();
    save.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.textContent).not.toContain(original);

    reject(new Error('sensitive implementation detail'));
    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('会议听记未能保存，请重试');
    });
    expect(modal.contentEl.textContent).not.toContain('sensitive implementation detail');
    expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )?.value).toBe(original);
    expect(modal.contentEl.textContent).not.toContain(original);
  });
});
