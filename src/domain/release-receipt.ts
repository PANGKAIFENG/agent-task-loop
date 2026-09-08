import { z } from 'zod';

import type { ReleaseCandidateAcceptance } from './release-acceptance.js';

// PAW-GOAL-003 T3 (TECH §9): the Release Receipt carries the four-system
// read-back — GitHub merge SHA / PR / Issue, plugin manifest / version /
// hash / backup path, synthetic live task, Multica issue / run, DingTalk
// message / event and the ATL final frontmatter. A task may only enter done
// when the receipt is complete AND consistent with the accepted RC SHA.

export const RELEASE_RECEIPT_STATUSES = [
  'verification_failed',
  'readiness_rejected',
  'stale_rejected',
  'rolled_back',
  'passed',
] as const;

export type ReleaseReceiptStatus = (typeof RELEASE_RECEIPT_STATUSES)[number];

export interface ReleaseVerificationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

export interface PluginBackupFileRecord {
  path: string;
  sha256: string;
  /** POSIX permission bits. Optional only so legacy receipts can be read and rejected safely. */
  mode?: number | undefined;
}

export interface PluginBackupReceipt {
  /** Null when no existing plugin was present — nothing was copied. */
  backupPath: string | null;
  createdAt: string;
  files: PluginBackupFileRecord[];
  /** Not installed yet — nothing to copy before a first install. */
  skippedReason: string | null;
}

export interface PluginInstallReceipt {
  pluginDir: string;
  manifest: string;
  version: string;
  fileHashes: PluginBackupFileRecord[];
  installedAt: string;
}

export interface PluginRollbackReceipt {
  restoredFiles: PluginBackupFileRecord[];
  rolledBackAt: string;
}

export interface MergeReadBack {
  repository: string;
  pr: string;
  headSha: string;
  mergeSha: string;
  prStatus: string;
  issueStatus: string;
}

export interface LiveVerificationReceipt {
  canaryTaskId: string;
  multicaIssueId: string;
  multicaRunId: string | null;
  dingTalkMessageId: string | null;
  dingTalkStreamEventId: string | null;
  passed: boolean;
  summary: string;
}

// Standalone schemas for evidence files the release boundary consumes — the
// authorized release step records merge/live evidence as JSON, and the CLI
// parses it with the same shape the receipt will embed. Declared below the
// shared text guards they build on.
export interface ReleaseVerificationReceipt {
  nodeVersion: string;
  headCheck: { command: string; observedHeadSha: string; matched: boolean } | null;
  candidateCheck: {
    statusCommand: string;
    cleanBefore: boolean;
    cleanAfter: boolean | null;
    postHeadCommand: string;
    observedHeadShaAfter: string | null;
    headMatchedAfter: boolean | null;
  } | null;
  commands: ReleaseVerificationCommandResult[];
}

export interface ReleaseReadBack {
  github: {
    repository: string;
    mergeSha: string;
    prStatus: string;
    issueStatus: string;
    headSha: string;
  };
  multica: {
    issueId: string;
    issueIdentifier: string;
    /** T3.1: the trusted system receipt channel — issue metadata, not a comment. */
    receiptMetadataKey: string;
    receiptMetadataValue: string;
  };
  dingtalk: {
    messageId: string;
    streamEventId: string;
  };
  atl: {
    taskId: string;
    taskStatus: string;
    frontmatterPath: string;
    finalSummary: string;
  };
}

export interface ReleaseReceipt {
  schemaVersion: 1;
  receiptId: string;
  acceptanceId: string;
  atlTaskId: string;
  eventId: string;
  headSha: string;
  status: ReleaseReceiptStatus;
  startedAt: string;
  completedAt: string;
  rejectionReason: string | null;
  verification: ReleaseVerificationReceipt | null;
  merge: MergeReadBack | null;
  plugin: {
    backup: PluginBackupReceipt | null;
    install: PluginInstallReceipt | null;
    rollback: PluginRollbackReceipt | null;
  } | null;
  liveVerification: LiveVerificationReceipt | null;
  readBack: ReleaseReadBack | null;
  postDeployment?: {
    completedEventId: string;
    completedEventOccurredAt: string;
    multicaIssueId: string;
    multicaIssueIdentifier: string;
    multicaIssueStatus: 'done';
    remoteState: 'completed';
    notificationLedgerKey: string;
    notificationMessageId: string;
    responseLedgerStreamEventId: string;
    responseCommentId: string;
    independentReviewRef: string;
    receiptMetadataKey: string;
    receiptMetadataValue: string;
    readAt: string;
  } | undefined;
}

export interface ReleaseReceiptAcceptanceBinding {
  acceptanceId: string;
  atlTaskId: string;
  headSha: string;
  repository: string | null;
  githubPr: string | null;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be a lowercase hex digest');
const safeBoundedText = (maxLength: number) => z
  .string()
  .min(1)
  .max(maxLength)
  .refine((value) => Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  }), 'Control characters are not allowed');

export const mergeReadBackSchema = z.object({
  repository: safeBoundedText(300),
  pr: safeBoundedText(100),
  headSha: safeBoundedText(100),
  mergeSha: safeBoundedText(100),
  prStatus: safeBoundedText(60),
  issueStatus: safeBoundedText(60),
}).strict();

export const liveVerificationReceiptSchema = z.object({
  canaryTaskId: safeBoundedText(200),
  multicaIssueId: safeBoundedText(200),
  multicaRunId: safeBoundedText(200).nullable(),
  dingTalkMessageId: safeBoundedText(200).nullable(),
  dingTalkStreamEventId: safeBoundedText(200).nullable(),
  passed: z.boolean(),
  summary: safeBoundedText(2_000),
}).strict();

export const releaseReceiptSchema: z.ZodType<ReleaseReceipt> = z
  .object({
    schemaVersion: z.literal(1),
    receiptId: safeBoundedText(700),
    acceptanceId: safeBoundedText(600),
    atlTaskId: safeBoundedText(200),
    eventId: safeBoundedText(200),
    headSha: safeBoundedText(100),
    status: z.enum(RELEASE_RECEIPT_STATUSES),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    rejectionReason: safeBoundedText(400).nullable(),
    verification: z.object({
      nodeVersion: safeBoundedText(60),
      headCheck: z.object({
        command: safeBoundedText(200),
        observedHeadSha: safeBoundedText(100),
        matched: z.boolean(),
      }).strict().nullable(),
      candidateCheck: z.object({
        statusCommand: safeBoundedText(200),
        cleanBefore: z.boolean(),
        cleanAfter: z.boolean().nullable(),
        postHeadCommand: safeBoundedText(200),
        observedHeadShaAfter: safeBoundedText(100).nullable(),
        headMatchedAfter: z.boolean().nullable(),
      }).strict().nullable(),
      commands: z.array(z.object({
        command: safeBoundedText(400),
        exitCode: z.number().int(),
        durationMs: z.number().int().nonnegative(),
        // The tail survives schema validation even when it carries newlines;
        // control characters other than LF are rejected below.
        outputTail: z.string().max(2_000).refine(
          (value) => Array.from(value).every((character) => {
            const code = character.charCodeAt(0);
            return (code >= 32 && code !== 127) || code === 10;
          }),
          'Output tail must not contain control characters other than LF',
        ),
      }).strict()).max(32),
    }).strict().nullable(),
    merge: mergeReadBackSchema.nullable(),
    plugin: z.object({
      backup: z.object({
        backupPath: safeBoundedText(600).nullable(),
        createdAt: z.string().datetime({ offset: true }),
        files: z.array(z.object({
          path: safeBoundedText(400),
          sha256: sha256Schema,
          mode: z.number().int().min(0).max(0o777).optional(),
        }).strict()).max(64),
        skippedReason: safeBoundedText(200).nullable(),
      }).strict().nullable(),
      install: z.object({
        pluginDir: safeBoundedText(600),
        manifest: safeBoundedText(200),
        version: safeBoundedText(60),
        fileHashes: z.array(z.object({
          path: safeBoundedText(400),
          sha256: sha256Schema,
          mode: z.number().int().min(0).max(0o777).optional(),
        }).strict()).max(64),
        installedAt: z.string().datetime({ offset: true }),
      }).strict().nullable(),
      rollback: z.object({
        restoredFiles: z.array(z.object({
          path: safeBoundedText(400),
          sha256: sha256Schema,
          mode: z.number().int().min(0).max(0o777).optional(),
        }).strict()).max(64),
        rolledBackAt: z.string().datetime({ offset: true }),
      }).strict().nullable(),
    }).strict().nullable(),
    liveVerification: liveVerificationReceiptSchema.nullable(),
    readBack: z.object({
      github: z.object({
        repository: safeBoundedText(300),
        mergeSha: safeBoundedText(100),
        prStatus: safeBoundedText(60),
        issueStatus: safeBoundedText(60),
        headSha: safeBoundedText(100),
      }).strict(),
      multica: z.object({
        issueId: safeBoundedText(200),
        issueIdentifier: safeBoundedText(100),
        receiptMetadataKey: safeBoundedText(100),
        receiptMetadataValue: safeBoundedText(4_000),
      }).strict(),
      dingtalk: z.object({
        messageId: safeBoundedText(200),
        streamEventId: safeBoundedText(200),
      }).strict(),
      atl: z.object({
        taskId: safeBoundedText(200),
        taskStatus: safeBoundedText(100),
        frontmatterPath: safeBoundedText(600),
        finalSummary: safeBoundedText(2_000),
      }).strict(),
    }).strict().nullable(),
    postDeployment: z.object({
      completedEventId: safeBoundedText(200),
      completedEventOccurredAt: z.string().datetime({ offset: true }),
      multicaIssueId: safeBoundedText(200),
      multicaIssueIdentifier: safeBoundedText(100),
      multicaIssueStatus: z.literal('done'),
      remoteState: z.literal('completed'),
      notificationLedgerKey: safeBoundedText(800),
      notificationMessageId: safeBoundedText(200),
      responseLedgerStreamEventId: safeBoundedText(200),
      responseCommentId: safeBoundedText(200),
      independentReviewRef: safeBoundedText(200),
      receiptMetadataKey: safeBoundedText(100),
      receiptMetadataValue: safeBoundedText(4_000),
      readAt: z.string().datetime({ offset: true }),
    }).strict().optional(),
  })
  .strict();

/**
 * The done gate (TECH §9): every gap must be empty before the task may leave
 * review. Checks both completeness (each receipt block present) and
 * consistency with the accepted RC SHA (receipt head SHA == acceptance head
 * SHA, merge bound to the same repository/PR/SHA).
 */
export function releaseReceiptGaps(
  receipt: ReleaseReceipt,
  acceptance: ReleaseReceiptAcceptanceBinding,
  options: { expectedAtlTaskStatus?: 'review' | 'done' } = {},
): string[] {
  const gaps: string[] = [];
  if (receipt.acceptanceId !== acceptance.acceptanceId) {
    gaps.push(`receipt acceptance id ${receipt.acceptanceId} differs from acceptance`);
  }
  if (receipt.headSha !== acceptance.headSha) {
    gaps.push(`receipt head SHA ${receipt.headSha} differs from accepted ${acceptance.headSha}`);
  }
  if (receipt.status !== 'passed') {
    gaps.push(`receipt status must be passed, got ${receipt.status}`);
  }
  const verification = receipt.verification;
  if (verification === null) {
    gaps.push('fixed verification receipt is required');
  } else {
    if (verification.commands.length === 0) {
      gaps.push('fixed verification must record at least one command');
    }
    if (verification.commands.some((command) => command.exitCode !== 0)) {
      gaps.push('fixed verification recorded a failing command');
    }
    if (verification.headCheck === null || !verification.headCheck.matched) {
      gaps.push('verification must prove the worktree head equals the accepted head SHA');
    }
    if (
      verification.candidateCheck === null
      || !verification.candidateCheck.cleanBefore
      || verification.candidateCheck.cleanAfter !== true
      || verification.candidateCheck.headMatchedAfter !== true
    ) {
      gaps.push('verification must prove a clean immutable candidate before and after the fixed suite');
    }
  }
  const merge = receipt.merge;
  if (merge === null) {
    gaps.push('merge read-back is required');
  } else {
    if (merge.headSha !== acceptance.headSha) {
      gaps.push('merge read-back must bind the accepted head SHA');
    }
    if (merge.prStatus !== 'merged') {
      gaps.push(`merge read-back PR status must be merged, got ${merge.prStatus}`);
    }
    if (acceptance.repository !== null && merge.repository !== acceptance.repository) {
      gaps.push('merge read-back repository differs from the accepted release event');
    }
    if (acceptance.githubPr !== null && merge.pr !== acceptance.githubPr) {
      gaps.push('merge read-back PR differs from the accepted release event');
    }
    if (merge.mergeSha.trim() === '') {
      gaps.push('merge read-back must record the merge SHA');
    }
  }
  const plugin = receipt.plugin;
  if (plugin === null) {
    gaps.push('plugin receipt is required');
  } else {
    if (plugin.backup?.files.some((file) => file.mode === undefined)) {
      gaps.push('plugin backup receipt must record file modes');
    }
    if (plugin.install === null) {
      gaps.push('plugin install receipt is required');
    } else if (plugin.install.fileHashes.length === 0) {
      gaps.push('plugin install receipt must record file hashes');
    } else {
      if (plugin.install.fileHashes.some((file) => file.mode === undefined)) {
        gaps.push('plugin install receipt must record file modes');
      }
      const helper = plugin.install.fileHashes.find((file) => (
        file.path === 'qianwen-accessibility-helper'
      ));
      if (helper === undefined || helper.mode === undefined || (helper.mode & 0o111) === 0) {
        gaps.push('plugin install receipt must prove the Qianwen helper is executable');
      }
    }
    if (plugin.rollback !== null) {
      gaps.push('a rolled-back plugin must never pass the release gate');
    }
  }
  if (receipt.liveVerification === null || !receipt.liveVerification.passed) {
    gaps.push('synthetic live verification receipt must be present and passing');
  }
  const readBack = receipt.readBack;
  if (readBack === null) {
    gaps.push('four-system read-back is required');
  } else {
    if (readBack.github.headSha !== acceptance.headSha) {
      gaps.push('GitHub read-back must bind the accepted head SHA');
    }
    if (readBack.atl.taskId !== acceptance.atlTaskId) {
      gaps.push('ATL read-back must reference the accepted task');
    }
    const expectedAtlTaskStatus = options.expectedAtlTaskStatus ?? 'done';
    if (readBack.atl.taskStatus !== expectedAtlTaskStatus) {
      gaps.push(`ATL read-back task status must be ${expectedAtlTaskStatus}, got ${readBack.atl.taskStatus}`);
    }
    if (readBack.multica.receiptMetadataKey.trim() === ''
      || readBack.multica.receiptMetadataValue.trim() === '') {
      gaps.push('Multica read-back must reference the release receipt metadata');
    }
    if (readBack.dingtalk.messageId.trim() === '') {
      gaps.push('DingTalk read-back must reference the notice message');
    }
  }
  return gaps;
}

export function releasePhaseEvidenceGaps(
  receipt: ReleaseReceipt,
  acceptance: ReleaseCandidateAcceptance,
): string[] {
  return releaseReceiptGaps(receipt, acceptance).filter((gap) => (
    !gap.startsWith('ATL read-back task status must be done')
  ));
}
