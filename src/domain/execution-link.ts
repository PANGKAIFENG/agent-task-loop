import { z } from 'zod';

import { multicaSummarySchema } from './multica-event.js';

// PAW-GOAL-003 T1: dispatch ledger states for an externally executed task
// (TECH §4). The happy path is not_requested -> pending -> resolving_remote
// -> linked -> active; every remote write that cannot be confirmed lands in
// remote_write_unknown and is only resolved by reconciliation, never by a
// blind retry. duplicate_conflict stops automatic execution entirely.
export const EXECUTION_LINK_DISPATCH_STATES = [
  'not_requested',
  'pending',
  'resolving_remote',
  'linked',
  'active',
  'remote_write_unknown',
  'duplicate_conflict',
  'failed',
] as const;

// PAW-GOAL-003 T1: remote_state mirrors the Multica-side lifecycle from TECH
// §3. T1 only ever writes `active` (unique link read-back) and status syncs;
// event-driven states belong to the T2 ingestion contract.
export const EXECUTION_LINK_REMOTE_STATES = [
  'active',
  'needs_decision',
  'blocked',
  'release_candidate_ready',
  'failed',
  'completed',
] as const;

export type ExecutionLinkDispatchState = (typeof EXECUTION_LINK_DISPATCH_STATES)[number];
export type ExecutionLinkRemoteState = (typeof EXECUTION_LINK_REMOTE_STATES)[number];

export interface ExecutionLink {
  schemaVersion: 1;
  provider: 'multica';
  idempotencyKey: string;
  workspaceId: string;
  projectId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  activationAssigneeId?: string | null | undefined;
  activationRunId?: string | null | undefined;
  contextManifestId?: string | null | undefined;
  contextManifestSha256?: string | null | undefined;
  executionBindingReceiptId?: string | null | undefined;
  remoteArtifactReceiptIds?: string[] | undefined;
  activationAgentModel?: string | null | undefined;
  activationAgentMaxConcurrentTasks?: number | null | undefined;
  activationAgentRuntimeId?: string | null | undefined;
  activationRunStatus?: string | null | undefined;
  activationRunRuntimeId?: string | null | undefined;
  dispatchState: ExecutionLinkDispatchState;
  remoteState: ExecutionLinkRemoteState | null;
  lastCommentId: string | null;
  lastEventId: string | null;
  summary: string | null;
  artifactRefs: string[];
  lastAttemptAt: string | null;
  lastSyncedAt: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[0-9]{1,10}$/;

function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

const controlCharacterFreeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed');

export const executionLinkSchema: z.ZodType<ExecutionLink> = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('multica'),
    idempotencyKey: z
      .string()
      .regex(/^atl:[^\s]{1,190}$/, 'idempotencyKey must look like atl:<task_id>')
      .refine(hasNoControlCharacters, 'Control characters are not allowed'),
    workspaceId: z.string().regex(UUID_PATTERN, 'workspaceId must be a UUID'),
    projectId: z.string().regex(UUID_PATTERN, 'projectId must be a UUID'),
    issueId: z
      .string()
      .regex(UUID_PATTERN, 'issueId must be a UUID')
      .nullable(),
    issueIdentifier: z
      .string()
      .regex(IDENTIFIER_PATTERN, 'issueIdentifier must look like TEP-42')
      .nullable(),
    activationAssigneeId: z.string().regex(UUID_PATTERN, 'activationAssigneeId must be a UUID')
      .nullable().optional(),
    activationRunId: controlCharacterFreeText(200).nullable().optional(),
    contextManifestId: z.string().regex(/^cm_[0-9a-f]{24}$/u).nullable().optional(),
    contextManifestSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable().optional(),
    executionBindingReceiptId: z.string().regex(/^ebr_[0-9a-f]{24}$/u).nullable().optional(),
    remoteArtifactReceiptIds: z.array(z.string().regex(/^rar_[0-9a-f]{24}$/u)).max(50).optional(),
    activationAgentModel: controlCharacterFreeText(200).nullable().optional(),
    activationAgentMaxConcurrentTasks: z.number().int().positive().nullable().optional(),
    activationAgentRuntimeId: controlCharacterFreeText(200).nullable().optional(),
    activationRunStatus: controlCharacterFreeText(100).nullable().optional(),
    activationRunRuntimeId: controlCharacterFreeText(200).nullable().optional(),
    dispatchState: z.enum(EXECUTION_LINK_DISPATCH_STATES),
    remoteState: z.enum(EXECUTION_LINK_REMOTE_STATES).nullable(),
    lastCommentId: controlCharacterFreeText(200).nullable(),
    lastEventId: controlCharacterFreeText(200).nullable(),
    summary: multicaSummarySchema.nullable(),
    artifactRefs: z.array(controlCharacterFreeText(300)).max(50),
    lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
    lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export function executionLinkIdempotencyKey(taskId: string): string {
  return `atl:${taskId}`;
}

export function isExecutionLinkBound(link: ExecutionLink | null | undefined): boolean {
  return (link?.dispatchState === 'linked' || link?.dispatchState === 'active')
    && typeof link?.issueId === 'string'
    && link.issueId !== '';
}

// A remote issue reference alone is not proof that execution started. Older
// records can be issue-bound without the governed Squad assignment and
// Supervisor run receipt introduced by PAW-GOAL-003 T3. Those records remain
// loadable, but dispatch/reconciliation must recover activation before they
// are treated as executable links.
export function isExecutionLinkActivationComplete(
  link: ExecutionLink | null | undefined,
): boolean {
  return isExecutionLinkBound(link)
    && typeof link?.activationAssigneeId === 'string'
    && link.activationAssigneeId !== ''
    && typeof link.activationRunId === 'string'
    && link.activationRunId !== '';
}
