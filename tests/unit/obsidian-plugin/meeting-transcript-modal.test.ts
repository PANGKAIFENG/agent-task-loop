// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DingTalkMeetingSource } from '../../../src/obsidian-plugin/meeting-note.js';
import type { MeetingAttachmentDraft } from '../../../src/obsidian-plugin/meeting-attachment.js';
import type { MeetingTranscriptModalResult } from '../../../src/obsidian-plugin/meeting-transcript-modal.js';

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

function draft(input: {
  name: string;
  role: 'transcript' | 'reference';
  analyzable: boolean;
  extractedText: string | null;
}): MeetingAttachmentDraft {
  const data = new TextEncoder().encode(input.extractedText ?? 'binary');
  const marker = input.name === 'transcript.md'
    ? 'b'
    : input.name === 'reference.md' ? 'c' : 'e';
  return {
    id: `sha256:${marker.repeat(64)}`,
    name: input.name,
    mediaType: input.analyzable ? 'text/markdown' : 'image/png',
    size: data.byteLength,
    role: input.role,
    analyzable: input.analyzable,
    includeInAnalysis: input.role === 'transcript',
    data,
    extractedText: input.extractedText,
  };
}

function analysisResult(): MeetingTranscriptModalResult {
  return {
    meetingPath: '08_Meetings/2026-07/synthetic.md',
    analysis: {
      status: 'ready_for_confirm',
      result: {
        summary: '已形成一项明确行动。',
        conclusions: ['先完成合成方案'],
        taskCandidates: [{
          title: '提交合成方案',
          explanation: '会议中明确承诺。',
          priority: 'normal',
          sourceName: '会议听记',
          sourceQuote: '小李：周五提交合成方案。',
        }],
      },
      inputHash: `sha256:${'d'.repeat(64)}`,
      model: 'synthetic-model',
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
    transcript: '小李：周五提交合成方案。',
    attachments: [],
    prepared: {
      scanId: 'meeting-synthetic',
      meetingNotePath: '/synthetic/meeting.md',
      filesScanned: 1,
      recordsConsidered: 1,
      candidates: [{
        candidateId: 'candidate-1',
        title: '提交合成方案',
        summary: '会议中明确承诺。',
        priority: 'normal',
        topicKey: '提交合成方案',
        sourceRecordFingerprint: 'fingerprint-1',
        sourceRecordFingerprints: ['fingerprint-1'],
        sourceQuote: '小李：周五提交合成方案。',
        sourceDate: '2026-07-22',
        sourceNote: '/synthetic/meeting.md',
        recordedAt: null,
        sourceEvidence: [{
          sourceRecordFingerprint: 'fingerprint-1',
          sourceDate: '2026-07-22',
          sourceNote: '/synthetic/meeting.md',
          recordedAt: null,
          sourceQuote: '小李：周五提交合成方案。',
        }],
      }],
      processedRecordFingerprints: ['fingerprint-1'],
      completedAt: '2026-07-22T00:00:00.000Z',
    },
  };
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
    expect(button(modal, '从文件导入原文')).toBeTruthy();
    expect(button(modal, '添加关联资料')).toBeTruthy();
  });

  it('imports an original file and keeps analyzable references opt-in', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const original = draft({
      name: 'transcript.md',
      role: 'transcript',
      analyzable: true,
      extractedText: '从文件导入的合成听记。',
    });
    const reference = draft({
      name: 'reference.md',
      role: 'reference',
      analyzable: true,
      extractedText: '合成关联资料。',
    });
    const image = draft({
      name: 'image.png',
      role: 'reference',
      analyzable: false,
      extractedText: null,
    });
    const onSubmit = vi.fn(async (input: unknown, action: unknown) => {
      void input;
      void action;
      return null;
    });
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      pickTranscriptFile: vi.fn(async () => original),
      pickReferenceFiles: vi.fn(async () => [reference, image]),
      modelLabel: 'synthetic-model',
    });
    modal.open();

    button(modal, '从文件导入原文').click();
    await vi.waitFor(() => expect(modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )?.value).toBe('从文件导入的合成听记。'));
    button(modal, '添加关联资料').click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('reference.md'));

    const includeReference = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="用于分析 reference.md"]',
    );
    expect(includeReference?.checked).toBe(false);
    expect(modal.contentEl.querySelector(
      'input[aria-label="用于分析 image.png"]',
    )).toBeNull();
    expect(modal.contentEl.textContent).toContain('仅保存附件');

    includeReference!.checked = true;
    includeReference!.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '保存并分析').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      transcript: '从文件导入的合成听记。',
      attachments: [
        { name: 'transcript.md', includeInAnalysis: true },
        { name: 'reference.md', includeInAnalysis: true },
        { name: 'image.png', includeInAnalysis: false },
      ],
    });
  });

  it('replaces a matching reference when the same content becomes the transcript', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const reference = draft({
      name: 'reference.md',
      role: 'reference',
      analyzable: true,
      extractedText: '同一份合成内容。',
    });
    const original: MeetingAttachmentDraft = {
      ...reference,
      name: 'transcript-copy.md',
      role: 'transcript',
      includeInAnalysis: true,
      extractedText: '同一份合成内容。',
    };
    const onSubmit = vi.fn(async (input: unknown, action: unknown) => {
      void input;
      void action;
      return null;
    });
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      pickReferenceFiles: vi.fn(async () => [reference]),
      pickTranscriptFile: vi.fn(async () => original),
    });
    modal.open();

    button(modal, '添加关联资料').click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('reference.md'));
    button(modal, '从文件导入原文').click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('transcript-copy.md'));
    expect(modal.contentEl.textContent).not.toContain('reference.md');

    button(modal, '仅保存').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{
        id: reference.id,
        name: 'transcript-copy.md',
        role: 'transcript',
        includeInAnalysis: true,
      }],
    });
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
      attachments: [],
    }, 'analyze'));
  });

  it('stays in the modal after analysis and keeps candidates unchecked', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    let finish!: (result: MeetingTranscriptModalResult) => void;
    const pending = new Promise<MeetingTranscriptModalResult>((resolve) => {
      finish = resolve;
    });
    const onCommitCandidates = vi.fn(async () => ({
      createdTaskIds: ['task-1'],
      existingTaskIds: [],
    }));
    const modal = new MeetingTranscriptModal(
      {} as never,
      source,
      vi.fn(() => pending),
      { onCommitCandidates, modelLabel: 'synthetic-model' },
    );
    modal.open();
    const transcript = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )!;
    transcript.value = '小李：周五提交合成方案。';
    transcript.dispatchEvent(new window.Event('input', { bubbles: true }));

    button(modal, '保存并分析').click();
    expect(modal.contentEl.textContent).toContain('正在分析会议资料');
    expect(modal.contentEl.textContent).toContain('synthetic-model');
    finish(analysisResult());

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('已形成一项明确行动'));
    expect(modal.contentEl.textContent).toContain('先完成合成方案');
    expect(modal.contentEl.textContent).toContain('来源：会议听记');
    expect(modal.contentEl.textContent).toContain('synthetic-model');
    const candidate = modal.contentEl.querySelector<HTMLInputElement>(
      'input[aria-label="选择 提交合成方案"]',
    );
    expect(candidate?.checked).toBe(false);
    expect(modal.contentEl.querySelector('details')?.open).toBe(false);
    expect(onCommitCandidates).not.toHaveBeenCalled();

    candidate!.checked = true;
    candidate!.dispatchEvent(new window.Event('change', { bubbles: true }));
    button(modal, '将所选任务加入 Inbox').click();
    await vi.waitFor(() => expect(onCommitCandidates).toHaveBeenCalledWith(
      analysisResult().prepared,
      ['candidate-1'],
    ));
    expect(modal.contentEl.textContent).toContain('已将 1 个任务加入 Inbox');
  });

  it('shows a stale saved result and requires an explicit reanalysis action', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const stale = analysisResult();
    stale.analysis.status = 'stale';
    const onSubmit = vi.fn(async () => analysisResult());
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      initialForm: {
        meetingType: 'discussion',
        participants: [],
        transcript: stale.transcript,
        attachments: [],
      },
      initialResult: stale,
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain('内容已更新，建议重新分析');
    button(modal, '重新分析').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: stale.transcript }),
      'retry',
    ));
  });

  it('offers explicit reanalysis when a legacy or corrupt result cannot be restored', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const onSubmit = vi.fn(async () => analysisResult());
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      initialForm: {
        meetingType: 'discussion',
        participants: [],
        transcript: '保留的旧版会议听记。',
        attachments: [],
      },
      initialAnalysisStatus: 'stale',
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain('原总结仍保留在会议笔记中');
    button(modal, '重新分析').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: '保留的旧版会议听记。' }),
      'retry',
    ));
  });

  it('shows an unavailable attachment and lets the user remove it', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const modal = new MeetingTranscriptModal({} as never, source, vi.fn(), {
      initialForm: {
        meetingType: 'discussion',
        participants: [],
        transcript: '保留的会议听记。',
        attachments: [{
          id: `sha256:${'9'.repeat(64)}`,
          name: 'missing.pdf',
          path: '08_Meetings/2026-07/attachments/missing.pdf',
          mediaType: 'application/pdf',
          size: 123,
          role: 'reference',
          analyzable: true,
          includeInAnalysis: true,
          unavailableReason: '附件文件已丢失或无法读取',
        } as never],
      },
      initialAnalysisStatus: 'stale',
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain('附件文件已丢失或无法读取');
    expect(modal.contentEl.querySelector('input[aria-label="用于分析 missing.pdf"]'))
      .toBeNull();
    modal.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="移除 missing.pdf"]',
    )!.click();
    expect(modal.contentEl.textContent).not.toContain('missing.pdf');
  });

  it('uses explicit reanalysis when editing a meeting that already has a result', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const existing = analysisResult();
    const onSubmit = vi.fn(async () => analysisResult());
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      initialForm: {
        meetingType: 'discussion',
        participants: [],
        transcript: existing.transcript,
        attachments: [],
      },
      initialResult: existing,
    });
    modal.open();

    button(modal, '编辑资料').click();
    const transcript = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="会议听记原文"]',
    )!;
    transcript.value = `${existing.transcript}\n新增讨论。`;
    transcript.dispatchEvent(new window.Event('input', { bubbles: true }));
    button(modal, '保存并重新分析').click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: `${existing.transcript}\n新增讨论。` }),
      'retry',
    ));
  });

  it('offers retry in the input view when a previous analysis failed without a result', async () => {
    const { MeetingTranscriptModal } = await import(
      '../../../src/obsidian-plugin/meeting-transcript-modal.js'
    );
    const onSubmit = vi.fn(async () => analysisResult());
    const modal = new MeetingTranscriptModal({} as never, source, onSubmit, {
      initialForm: {
        meetingType: 'discussion',
        participants: [],
        transcript: '保留的合成听记原文。',
        attachments: [],
      },
      initialAnalysisStatus: 'failed',
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain('上次分析失败');
    button(modal, '重试分析').click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: '保留的合成听记原文。' }),
      'retry',
    ));
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
