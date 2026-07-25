import { describe, expect, it, vi } from 'vitest';

import {
  buildMeetingAttachmentPath,
  createMeetingAttachmentDraft,
  deduplicateMeetingAttachments,
  MeetingAttachmentStore,
} from '../../../src/obsidian-plugin/meeting-attachment.js';

const EVENT_HASH = `sha256:${'a'.repeat(64)}`;
const MEETING_PATH = `08_Meetings/2026-07/2026-07-24-周会-${'a'.repeat(64)}.md`;

describe('meeting attachments', () => {
  it('deduplicates by content and always keeps the transcript role', () => {
    const id = `sha256:${'f'.repeat(64)}`;
    const reference = { id, role: 'reference' as const, name: 'reference.md' };
    const transcript = { id, role: 'transcript' as const, name: 'transcript.md' };

    expect(deduplicateMeetingAttachments([reference, transcript])).toEqual([transcript]);
    expect(deduplicateMeetingAttachments([transcript, reference])).toEqual([transcript]);
  });

  it('keeps analyzable references lazy and parses transcript imports immediately', async () => {
    const parse = vi.fn(async () => '解析后的文本');
    const data = new Uint8Array([1, 2, 3]);

    const reference = await createMeetingAttachmentDraft({
      name: '资料.PDF',
      mediaType: 'application/pdf',
      data,
      role: 'reference',
    }, parse);
    const transcript = await createMeetingAttachmentDraft({
      name: '听记.md',
      mediaType: 'text/markdown',
      data,
      role: 'transcript',
    }, parse);

    expect(reference).toMatchObject({
      name: '资料.PDF',
      role: 'reference',
      analyzable: true,
      includeInAnalysis: false,
      extractedText: null,
    });
    expect(transcript).toMatchObject({
      role: 'transcript',
      analyzable: true,
      includeInAnalysis: true,
      extractedText: '解析后的文本',
    });
    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith({ name: '听记.md', data });
    expect(reference.id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('keeps unsupported reference files local-only without invoking a parser', async () => {
    const parse = vi.fn(async () => 'must not run');

    const attachment = await createMeetingAttachmentDraft({
      name: 'recording.mp4',
      mediaType: 'video/mp4',
      data: new Uint8Array([1, 2, 3]),
      role: 'reference',
    }, parse);

    expect(attachment).toMatchObject({
      analyzable: false,
      includeInAnalysis: false,
      extractedText: null,
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it('builds a safe content-addressed path inside the event attachment directory', async () => {
    const draft = await createMeetingAttachmentDraft({
      name: '../面试 记录?.pdf',
      mediaType: 'application/pdf',
      data: new Uint8Array([1, 2, 3]),
      role: 'reference',
    }, async () => '内容');

    const path = buildMeetingAttachmentPath(MEETING_PATH, EVENT_HASH, draft);

    expect(path).toMatch(new RegExp(
      `^08_Meetings/2026-07/attachments/${'a'.repeat(64)}/[a-f0-9]{12}-面试-记录\\.pdf$`,
      'u',
    ));
    expect(path).not.toContain('..');
  });

  it('copies new bytes once and returns durable metadata for duplicate saves', async () => {
    const files = new Map<string, Uint8Array>();
    const createBinary = vi.fn(async (path: string, data: Uint8Array) => {
      files.set(path, data);
    });
    const store = new MeetingAttachmentStore({
      exists: async (path) => files.has(path),
      ensureDirectory: vi.fn(async () => undefined),
      createBinary,
    });
    const draft = await createMeetingAttachmentDraft({
      name: 'notes.txt',
      mediaType: 'text/plain',
      data: new TextEncoder().encode('synthetic notes'),
      role: 'reference',
    }, async () => 'synthetic notes');

    const first = await store.save(MEETING_PATH, EVENT_HASH, [draft]);
    const second = await store.save(MEETING_PATH, EVENT_HASH, [draft]);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      id: draft.id,
      name: 'notes.txt',
      role: 'reference',
      analyzable: true,
      includeInAnalysis: false,
      size: 15,
    });
    expect(first[0]?.path).toContain('/attachments/');
    expect(createBinary).toHaveBeenCalledOnce();
  });
});
