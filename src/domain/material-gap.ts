import { z } from 'zod';

export type MaterialGapKind = 'numeric' | 'document' | 'status';
export type MaterialSearchStatus = 'found' | 'not_found' | 'permission_denied';
export type MaterialSearchSource =
  | 'meeting_link'
  | 'project_context'
  | 'calendar_attachment'
  | 'dingtalk_message'
  | 'dingtalk_doc'
  | 'dingtalk_aitable'
  | 'dingtalk_drive'
  | 'yunxiao'
  | 'code_artifact';

export interface MaterialSearchAttempt {
  source: MaterialSearchSource;
  target: string;
  status: MaterialSearchStatus;
  searchedAt: string;
  sourceRef: string | null;
}

export interface SuggestedMaterialContact {
  userId: string;
  displayName: string;
  reason: string;
  sourceRef: string;
}

export interface MaterialMessageDraft {
  recipientUserId: string;
  recipientDisplayName: string;
  body: string;
  state: 'draft';
  authorization: 'required';
  delivery: null;
}

export interface MaterialGap {
  schemaVersion: 1;
  gapId: string;
  progressId: string;
  progressVersion: number;
  missing: {
    kind: MaterialGapKind;
    description: string;
    purpose: string;
  };
  searches: MaterialSearchAttempt[];
  suggestedContact: SuggestedMaterialContact | null;
  status: 'resolved' | 'needs_material' | 'needs_contact';
  resolvedSourceRef: string | null;
  messageDraft: MaterialMessageDraft | null;
  createdAt: string;
}

const nonEmptyString = z.string().trim().min(1).max(20_000);
const materialSearchAttemptSchema = z.object({
  source: z.enum([
    'meeting_link',
    'project_context',
    'calendar_attachment',
    'dingtalk_message',
    'dingtalk_doc',
    'dingtalk_aitable',
    'dingtalk_drive',
    'yunxiao',
    'code_artifact',
  ]),
  target: nonEmptyString,
  status: z.enum(['found', 'not_found', 'permission_denied']),
  searchedAt: z.iso.datetime({ offset: true }),
  sourceRef: nonEmptyString.nullable(),
}).strict();
const suggestedContactSchema = z.object({
  userId: nonEmptyString,
  displayName: nonEmptyString,
  reason: nonEmptyString,
  sourceRef: nonEmptyString,
}).strict();
const materialMessageDraftSchema = z.object({
  recipientUserId: nonEmptyString,
  recipientDisplayName: nonEmptyString,
  body: nonEmptyString,
  state: z.literal('draft'),
  authorization: z.literal('required'),
  delivery: z.null(),
}).strict();

export const materialGapSchema: z.ZodType<MaterialGap> = z.object({
  schemaVersion: z.literal(1),
  gapId: nonEmptyString,
  progressId: nonEmptyString,
  progressVersion: z.number().int().positive(),
  missing: z.object({
    kind: z.enum(['numeric', 'document', 'status']),
    description: nonEmptyString,
    purpose: nonEmptyString,
  }).strict(),
  searches: z.array(materialSearchAttemptSchema),
  suggestedContact: suggestedContactSchema.nullable(),
  status: z.enum(['resolved', 'needs_material', 'needs_contact']),
  resolvedSourceRef: nonEmptyString.nullable(),
  messageDraft: materialMessageDraftSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
}).strict();

export type PrepareMaterialGapInput = Omit<
  MaterialGap,
  'schemaVersion' | 'status' | 'resolvedSourceRef' | 'messageDraft'
>;

function hasEvidenceBasedContact(
  contact: SuggestedMaterialContact | null,
): contact is SuggestedMaterialContact {
  return contact !== null
    && contact.userId.trim() !== ''
    && contact.displayName.trim() !== ''
    && contact.reason.trim() !== ''
    && contact.sourceRef.trim() !== '';
}

function draftMessage(
  input: PrepareMaterialGapInput,
  contact: SuggestedMaterialContact,
): MaterialMessageDraft {
  return {
    recipientUserId: contact.userId,
    recipientDisplayName: contact.displayName,
    body: [
      `${contact.displayName}，你好。`,
      `我在整理${input.missing.purpose}，需要核验：${input.missing.description}。`,
      '方便的话请发我对应材料或可访问链接，谢谢。',
    ].join('\n'),
    state: 'draft',
    authorization: 'required',
    delivery: null,
  };
}

export function prepareMaterialGap(input: PrepareMaterialGapInput): MaterialGap {
  const resolved = input.searches.find((attempt) => (
    attempt.status === 'found' && attempt.sourceRef !== null
  ));
  if (resolved !== undefined) {
    return {
      ...input,
      schemaVersion: 1,
      status: 'resolved',
      resolvedSourceRef: resolved.sourceRef,
      messageDraft: null,
    };
  }

  if (!hasEvidenceBasedContact(input.suggestedContact)) {
    return {
      ...input,
      schemaVersion: 1,
      status: 'needs_contact',
      resolvedSourceRef: null,
      messageDraft: null,
    };
  }

  return {
    ...input,
    schemaVersion: 1,
    status: 'needs_material',
    resolvedSourceRef: null,
    messageDraft: draftMessage(input, input.suggestedContact),
  };
}
