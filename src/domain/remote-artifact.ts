import { createHash } from 'node:crypto';

import type { ArtifactIdentity } from './artifact-identity.js';

export interface RemoteRunOutputSource {
  kind: 'run_output';
  sourceId: string;
  sourceRef: string;
  runId: string;
  content: string;
  contentSha256: string;
}

export interface RemoteCommentAttachmentSource {
  kind: 'comment_attachment';
  sourceId: string;
  sourceRef: string;
  runId: string;
  commentId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string;
  markdownUrl: string | null;
  url: string | null;
  uploaderId: string;
  uploaderType: 'agent';
  metadataSha256: string;
}

export type RemoteArtifactSource = RemoteRunOutputSource | RemoteCommentAttachmentSource;

export interface RemoteArtifactReceipt {
  schemaVersion: 1;
  receiptId: string;
  taskId: string;
  executionBindingReceiptId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  issueIdentifier: string;
  run: {
    runId: string;
    agentId: string;
    runtimeId: string;
    status: string;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  sources: RemoteArtifactSource[];
  createdAt: string;
}

export type CreateRemoteArtifactReceiptInput = Omit<
  RemoteArtifactReceipt,
  'schemaVersion' | 'receiptId'
>;

export class RemoteArtifactEvidenceError extends Error {
  readonly code = 'remote_artifact_evidence_invalid';

  constructor(message = 'Remote Artifact evidence is missing or invalid') {
    super(message);
    this.name = 'RemoteArtifactEvidenceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonBlank(value: string): boolean {
  return value.trim() !== '';
}

function validNullableDate(value: string | null): boolean {
  return value === null || Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const sorted = [...expected].sort();
  const actual = Object.keys(value).sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function unsigned(receipt: Omit<RemoteArtifactReceipt, 'receiptId'>) {
  return {
    schemaVersion: 1 as const,
    taskId: receipt.taskId,
    executionBindingReceiptId: receipt.executionBindingReceiptId,
    workspaceId: receipt.workspaceId,
    projectId: receipt.projectId,
    issueId: receipt.issueId,
    issueIdentifier: receipt.issueIdentifier,
    run: receipt.run,
    sources: [...receipt.sources].sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    createdAt: receipt.createdAt,
  };
}

export function remoteArtifactReceiptId(
  receipt: Omit<RemoteArtifactReceipt, 'receiptId'>,
): string {
  return `rar_${sha256(JSON.stringify(unsigned(receipt))).slice(0, 24)}`;
}

export function remoteArtifactIdentity(receipt: RemoteArtifactReceipt): ArtifactIdentity {
  if (!isValidRemoteArtifactReceipt(receipt)) throw new RemoteArtifactEvidenceError();
  return {
    taskId: receipt.taskId,
    ref: `remote-artifact://${receipt.receiptId}`,
    version: 1,
    sha256: sha256(JSON.stringify(receipt)),
  };
}

export function runOutputSource(runId: string, content: string): RemoteRunOutputSource {
  return {
    kind: 'run_output',
    sourceId: `run-output:${runId}`,
    sourceRef: `multica-run://${runId}/output`,
    runId,
    content,
    contentSha256: sha256(content),
  };
}

export function attachmentMetadataSha256(
  source: Omit<RemoteCommentAttachmentSource, 'kind' | 'sourceId' | 'sourceRef' | 'metadataSha256'>,
): string {
  return sha256(JSON.stringify(source));
}

export function commentAttachmentSource(input: {
  runId: string;
  commentId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string;
  markdownUrl: string | null;
  url: string | null;
  uploaderId: string;
}): RemoteCommentAttachmentSource {
  const metadata = {
    runId: input.runId,
    commentId: input.commentId,
    attachmentId: input.attachmentId,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    downloadUrl: input.downloadUrl,
    markdownUrl: input.markdownUrl,
    url: input.url,
    uploaderId: input.uploaderId,
    uploaderType: 'agent' as const,
  };
  return {
    kind: 'comment_attachment',
    sourceId: `attachment:${input.attachmentId}`,
    sourceRef: `multica-attachment://${input.attachmentId}`,
    ...metadata,
    metadataSha256: attachmentMetadataSha256(metadata),
  };
}

export function createRemoteArtifactReceipt(
  input: CreateRemoteArtifactReceiptInput,
): RemoteArtifactReceipt {
  const receipt = unsigned({ schemaVersion: 1, ...input });
  const candidate: RemoteArtifactReceipt = {
    ...receipt,
    receiptId: remoteArtifactReceiptId(receipt),
  };
  if (!isValidRemoteArtifactReceipt(candidate)) {
    throw new RemoteArtifactEvidenceError();
  }
  return candidate;
}

export function isValidRemoteArtifactReceipt(value: unknown): value is RemoteArtifactReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'receiptId',
    'taskId',
    'executionBindingReceiptId',
    'workspaceId',
    'projectId',
    'issueId',
    'issueIdentifier',
    'run',
    'sources',
    'createdAt',
  ]) || !isRecord(value.run) || !hasExactKeys(value.run, [
    'runId',
    'agentId',
    'runtimeId',
    'status',
    'createdAt',
    'startedAt',
    'completedAt',
  ]) || !Array.isArray(value.sources)) return false;
  const receipt = value as unknown as RemoteArtifactReceipt;
  if (
    receipt.schemaVersion !== 1
    || typeof receipt.receiptId !== 'string'
    || receipt.receiptId !== remoteArtifactReceiptId(receipt)
    || typeof receipt.taskId !== 'string'
    || !nonBlank(receipt.taskId)
    || typeof receipt.executionBindingReceiptId !== 'string'
    || !/^ebr_[0-9a-f]{24}$/u.test(receipt.executionBindingReceiptId)
    || typeof receipt.workspaceId !== 'string'
    || !nonBlank(receipt.workspaceId)
    || typeof receipt.projectId !== 'string'
    || !nonBlank(receipt.projectId)
    || typeof receipt.issueId !== 'string'
    || !nonBlank(receipt.issueId)
    || typeof receipt.issueIdentifier !== 'string'
    || !nonBlank(receipt.issueIdentifier)
    || typeof receipt.run.runId !== 'string'
    || !nonBlank(receipt.run.runId)
    || typeof receipt.run.agentId !== 'string'
    || !nonBlank(receipt.run.agentId)
    || typeof receipt.run.runtimeId !== 'string'
    || !nonBlank(receipt.run.runtimeId)
    || typeof receipt.run.status !== 'string'
    || !nonBlank(receipt.run.status)
    || !(
      typeof receipt.run.createdAt === 'string' || receipt.run.createdAt === null
    )
    || !validNullableDate(receipt.run.createdAt)
    || !(
      typeof receipt.run.startedAt === 'string' || receipt.run.startedAt === null
    )
    || !validNullableDate(receipt.run.startedAt)
    || !(
      typeof receipt.run.completedAt === 'string' || receipt.run.completedAt === null
    )
    || !validNullableDate(receipt.run.completedAt)
    || receipt.sources.length === 0
    || receipt.sources.length > 101
    || typeof receipt.createdAt !== 'string'
    || !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    return false;
  }
  const sourceIds = new Set<string>();
  for (const source of receipt.sources) {
    if (!isRecord(source)) return false;
    if (source.kind === 'run_output') {
      if (!hasExactKeys(source, [
        'kind',
        'sourceId',
        'sourceRef',
        'runId',
        'content',
        'contentSha256',
      ])) return false;
    } else if (source.kind === 'comment_attachment') {
      if (!hasExactKeys(source, [
        'kind',
        'sourceId',
        'sourceRef',
        'runId',
        'commentId',
        'attachmentId',
        'filename',
        'contentType',
        'sizeBytes',
        'downloadUrl',
        'markdownUrl',
        'url',
        'uploaderId',
        'uploaderType',
        'metadataSha256',
      ])) return false;
    } else {
      return false;
    }
    if (!nonBlank(source.sourceId) || !nonBlank(source.sourceRef) || sourceIds.has(source.sourceId)) {
      return false;
    }
    sourceIds.add(source.sourceId);
    if (source.kind === 'run_output') {
      if (
        source.runId !== receipt.run.runId
        || source.sourceId !== `run-output:${source.runId}`
        || source.sourceRef !== `multica-run://${source.runId}/output`
        || typeof source.runId !== 'string'
        || typeof source.content !== 'string'
        || !nonBlank(source.content)
        || typeof source.contentSha256 !== 'string'
        || source.contentSha256 !== sha256(source.content)
      ) return false;
      continue;
    }
    const metadata = {
      runId: source.runId,
      commentId: source.commentId,
      attachmentId: source.attachmentId,
      filename: source.filename,
      contentType: source.contentType,
      sizeBytes: source.sizeBytes,
      downloadUrl: source.downloadUrl,
      markdownUrl: source.markdownUrl,
      url: source.url,
      uploaderId: source.uploaderId,
      uploaderType: source.uploaderType,
    };
    if (
      source.sourceId !== `attachment:${source.attachmentId}`
      || source.sourceRef !== `multica-attachment://${source.attachmentId}`
      || typeof source.runId !== 'string'
      || source.runId !== receipt.run.runId
      || typeof source.commentId !== 'string'
      || !nonBlank(source.commentId)
      || typeof source.attachmentId !== 'string'
      || !nonBlank(source.attachmentId)
      || typeof source.filename !== 'string'
      || !nonBlank(source.filename)
      || typeof source.contentType !== 'string'
      || !nonBlank(source.contentType)
      || typeof source.sizeBytes !== 'number'
      || !Number.isSafeInteger(source.sizeBytes)
      || source.sizeBytes < 0
      || typeof source.downloadUrl !== 'string'
      || !nonBlank(source.downloadUrl)
      || !(typeof source.markdownUrl === 'string' || source.markdownUrl === null)
      || !(typeof source.url === 'string' || source.url === null)
      || typeof source.uploaderId !== 'string'
      || !nonBlank(source.uploaderId)
      || source.uploaderType !== 'agent'
      || typeof source.metadataSha256 !== 'string'
      || source.metadataSha256 !== attachmentMetadataSha256(metadata)
    ) return false;
  }
  return true;
}

export function remoteArtifactIdentityMatches(
  left: RemoteArtifactReceipt,
  right: RemoteArtifactReceipt,
): boolean {
  return left.taskId === right.taskId
    && left.executionBindingReceiptId === right.executionBindingReceiptId
    && left.workspaceId === right.workspaceId
    && left.projectId === right.projectId
    && left.issueId === right.issueId
    && left.issueIdentifier === right.issueIdentifier
    && JSON.stringify(left.run) === JSON.stringify(right.run)
    && JSON.stringify(left.sources) === JSON.stringify(right.sources);
}
