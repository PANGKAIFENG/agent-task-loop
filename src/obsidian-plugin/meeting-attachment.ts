import { createHash } from 'node:crypto';

import {
  assertMeetingDocumentSize,
  meetingDocumentKind,
  parseMeetingDocument,
  type MeetingDocumentParser,
} from './meeting-document-parser.js';

const EVENT_KEY_HASH = /^sha256:([0-9a-f]{64})$/u;
const MEETING_NOTE_PATH = /^08_Meetings\/(\d{4}-\d{2})\/[^/]+\.md$/u;

export type MeetingAttachmentRole = 'transcript' | 'reference';

export interface MeetingAttachment {
  id: string;
  name: string;
  path: string;
  mediaType: string;
  size: number;
  role: MeetingAttachmentRole;
  analyzable: boolean;
  includeInAnalysis: boolean;
  unavailableReason?: string;
}

export interface MeetingAttachmentDraft
  extends Omit<MeetingAttachment, 'path'> {
  data: Uint8Array;
  extractedText: string | null;
}

export interface CreateMeetingAttachmentDraftInput {
  name: string;
  mediaType: string;
  data: Uint8Array;
  role: MeetingAttachmentRole;
}

export interface MeetingAttachmentFileSystem {
  exists(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  createBinary(path: string, data: Uint8Array): Promise<void>;
}

export function deduplicateMeetingAttachments<
  T extends Pick<MeetingAttachment, 'id' | 'role'>,
>(attachments: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const attachment of attachments) {
    const existing = unique.get(attachment.id);
    if (
      existing === undefined
      || attachment.role === 'transcript'
      || existing.role !== 'transcript'
    ) {
      unique.set(attachment.id, attachment);
    }
  }
  return [...unique.values()];
}

function contentId(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function displayName(value: string): string {
  const name = value.normalize('NFKC').split(/[\\/]/u).at(-1)?.trim() ?? '';
  return name === '' ? 'attachment' : name;
}

function safeFileName(value: string): string {
  const name = displayName(value);
  const extensionMatch = /\.([^.]+)$/u.exec(name);
  const extension = extensionMatch?.[1]?.toLocaleLowerCase('en-US') ?? '';
  const rawBase = extensionMatch === null
    ? name
    : name.slice(0, -(extension.length + 1));
  const base = [...rawBase
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')]
    .slice(0, 80)
    .join('') || 'attachment';
  const safeExtension = extension.replace(/[^a-z0-9]+/gu, '').slice(0, 12);
  return safeExtension === '' ? base : `${base}.${safeExtension}`;
}

export async function createMeetingAttachmentDraft(
  input: CreateMeetingAttachmentDraftInput,
  parser: MeetingDocumentParser = parseMeetingDocument,
): Promise<MeetingAttachmentDraft> {
  assertMeetingDocumentSize(input.data.byteLength);
  const name = displayName(input.name);
  const analyzable = meetingDocumentKind(name) !== null;
  if (input.role === 'transcript' && !analyzable) {
    throw new Error('听记原文文件仅支持 txt、md、docx 或 pdf');
  }
  const extractedText = input.role === 'transcript'
    ? await parser({ name, data: input.data })
    : null;
  return {
    id: contentId(input.data),
    name,
    mediaType: input.mediaType.trim() || 'application/octet-stream',
    size: input.data.byteLength,
    role: input.role,
    analyzable,
    includeInAnalysis: input.role === 'transcript',
    data: input.data,
    extractedText,
  };
}

export function buildMeetingAttachmentPath(
  meetingNotePath: string,
  eventKeyHash: string,
  attachment: Pick<MeetingAttachmentDraft, 'id' | 'name'>,
): string {
  const noteMatch = MEETING_NOTE_PATH.exec(meetingNotePath);
  const eventMatch = EVENT_KEY_HASH.exec(eventKeyHash);
  const contentMatch = EVENT_KEY_HASH.exec(attachment.id);
  if (noteMatch === null || eventMatch === null || contentMatch === null) {
    throw new Error('会议附件路径无效');
  }
  return [
    '08_Meetings',
    noteMatch[1],
    'attachments',
    eventMatch[1],
    `${contentMatch[1]?.slice(0, 12)}-${safeFileName(attachment.name)}`,
  ].join('/');
}

export class MeetingAttachmentStore {
  constructor(private readonly fileSystem: MeetingAttachmentFileSystem) {}

  async save(
    meetingNotePath: string,
    eventKeyHash: string,
    drafts: readonly MeetingAttachmentDraft[],
  ): Promise<MeetingAttachment[]> {
    const attachments: MeetingAttachment[] = [];
    for (const draft of drafts) {
      const path = buildMeetingAttachmentPath(meetingNotePath, eventKeyHash, draft);
      const directory = path.slice(0, path.lastIndexOf('/'));
      await this.fileSystem.ensureDirectory(directory);
      if (!(await this.fileSystem.exists(path))) {
        try {
          await this.fileSystem.createBinary(path, draft.data);
        } catch (error) {
          if (!(await this.fileSystem.exists(path))) throw error;
        }
      }
      attachments.push({
        id: draft.id,
        name: draft.name,
        path,
        mediaType: draft.mediaType,
        size: draft.size,
        role: draft.role,
        analyzable: draft.analyzable,
        includeInAnalysis: draft.includeInAnalysis,
      });
    }
    return attachments;
  }
}
