import { createHash } from 'node:crypto';

import {
  isValidResolvedProjectContext,
  type ResolvedProjectContext,
} from './project-context-resolution.js';

export const CONTEXT_CATEGORIES = [
  'task',
  'project',
  'source',
  'user_context',
  'policy',
  'feedback',
  'artifact',
] as const;

export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

export const CONTEXT_KINDS = [
  'task',
  'project',
  'local_file',
  'url_reference',
  'artifact_review',
  'user_context',
  'policy',
  'feedback',
] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];

export interface ContextCandidate {
  candidateId: string;
  category: ContextCategory;
  sourceRef: string;
  version: string | null;
  expectedSha256: string | null;
  selection: 'selected' | 'excluded';
  selectionReason: string;
  blockLabel?: string;
  exclusionReason?: string;
}

export interface ContextManifestEntry {
  candidateId: string;
  kind: ContextKind | null;
  category: ContextCategory;
  sourceRef: string;
  version: string | null;
  selectionReason: string;
  status: 'consumed' | 'excluded' | 'failed' | 'conflict';
  blockLabel: string | null;
  readRef: string | null;
  sha256: string | null;
  reason: string | null;
}

export interface ContextManifestIssue {
  code:
    | 'missing_consumption_evidence'
    | 'context_version_conflict'
    | 'context_identity_conflict'
    | 'unregistered_consumed_block';
  subject: string;
}

export interface ContextManifest {
  schemaVersion: 1;
  manifestId: string;
  sha256: string;
  taskId: string;
  runId: string;
  projectId: string;
  asOf: string;
  status: 'ready' | 'blocked';
  projectEvidence: {
    registryProjectId: string;
    canonicalRef: string;
    canonicalVersion: string;
    canonicalSha256: string;
    atlRef: string;
    atlSha256: string;
  };
  entries: ContextManifestEntry[];
  issues: ContextManifestIssue[];
}

export interface BuildContextManifestInput {
  taskId: string;
  runId: string;
  asOf: string;
  projectResolution: ResolvedProjectContext;
  context: {
    taskId: string;
    blocks: Array<{
      label: string;
      kind: ContextKind;
      category: ContextCategory;
      sourceRef: string;
      version: string | null;
      readRef: string;
      sha256: string;
    }>;
  };
  candidates: ContextCandidate[];
}

export class ContextManifestInputError extends Error {
  readonly code = 'context_manifest_invalid_input';

  constructor() {
    super('Context Manifest input is invalid');
    this.name = 'ContextManifestInputError';
  }
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validInput(input: BuildContextManifestInput): boolean {
  if (
    input.taskId.trim() === ''
    || input.runId.trim() === ''
    || input.context.taskId !== input.taskId
    || !Number.isFinite(Date.parse(input.asOf))
    || !isValidResolvedProjectContext(input.projectResolution)
  ) return false;
  const candidateIds = new Set<string>();
  const selectedLabels = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      candidate.candidateId.trim() === ''
      || candidateIds.has(candidate.candidateId)
      || candidate.sourceRef.trim() === ''
      || candidate.selectionReason.trim() === ''
      || (candidate.expectedSha256 !== null && !isSha256(candidate.expectedSha256))
    ) return false;
    candidateIds.add(candidate.candidateId);
    if (candidate.selection === 'selected') {
      if (
        candidate.blockLabel === undefined
        || candidate.blockLabel.trim() === ''
        || selectedLabels.has(candidate.blockLabel)
      ) return false;
      selectedLabels.add(candidate.blockLabel);
    } else if (
      candidate.exclusionReason === undefined
      || candidate.exclusionReason.trim() === ''
      || candidate.blockLabel !== undefined
    ) return false;
  }
  const blockLabels = new Set<string>();
  for (const block of input.context.blocks) {
    if (
      typeof block.label !== 'string'
      || block.label.trim() === ''
      || blockLabels.has(block.label)
      || typeof block.kind !== 'string'
      || block.kind.trim() === ''
      || !CONTEXT_CATEGORIES.includes(block.category)
      || typeof block.sourceRef !== 'string'
      || block.sourceRef.trim() === ''
      || (block.version !== null && (
        typeof block.version !== 'string'
        || block.version.trim() === ''
      ))
      || typeof block.readRef !== 'string'
      || block.readRef.trim() === ''
      || !isSha256(block.sha256)
    ) return false;
    blockLabels.add(block.label);
  }
  return true;
}

function kindMatchesCategory(
  kind: string,
  category: ContextCategory,
): boolean {
  return ({
    task: ['task'],
    project: ['project'],
    source: ['local_file', 'url_reference'],
    user_context: ['user_context'],
    policy: ['policy'],
    feedback: ['feedback'],
    artifact: ['artifact_review'],
  } satisfies Record<ContextCategory, string[]>)[category].includes(kind);
}

function entryForCandidate(
  candidate: ContextCandidate,
  block: BuildContextManifestInput['context']['blocks'][number] | undefined,
): { entry: ContextManifestEntry; issue: ContextManifestIssue | null } {
  if (candidate.selection === 'excluded') {
    return {
      entry: {
        candidateId: candidate.candidateId,
        kind: null,
        category: candidate.category,
        sourceRef: candidate.sourceRef,
        version: candidate.version,
        selectionReason: candidate.selectionReason,
        status: 'excluded',
        blockLabel: null,
        readRef: null,
        sha256: null,
        reason: candidate.exclusionReason ?? 'excluded',
      },
      issue: null,
    };
  }
  if (block === undefined) {
    return {
      entry: {
        candidateId: candidate.candidateId,
        kind: null,
        category: candidate.category,
        sourceRef: candidate.sourceRef,
        version: candidate.version,
        selectionReason: candidate.selectionReason,
        status: 'failed',
        blockLabel: candidate.blockLabel ?? null,
        readRef: null,
        sha256: null,
        reason: 'selected_context_not_read',
      },
      issue: { code: 'missing_consumption_evidence', subject: candidate.candidateId },
    };
  }
  if (
    candidate.category !== block.category
    || candidate.sourceRef !== block.sourceRef
    || candidate.version !== block.version
    || !kindMatchesCategory(block.kind, block.category)
  ) {
    return {
      entry: {
        candidateId: candidate.candidateId,
        kind: block.kind,
        category: candidate.category,
        sourceRef: candidate.sourceRef,
        version: candidate.version,
        selectionReason: candidate.selectionReason,
        status: 'conflict',
        blockLabel: block.label,
        readRef: block.readRef,
        sha256: block.sha256,
        reason: 'context_identity_mismatch',
      },
      issue: { code: 'context_identity_conflict', subject: candidate.candidateId },
    };
  }
  if (
    candidate.expectedSha256 !== null
    && block.sha256 !== candidate.expectedSha256
  ) {
    return {
      entry: {
        candidateId: candidate.candidateId,
        kind: block.kind,
        category: candidate.category,
        sourceRef: candidate.sourceRef,
        version: candidate.version,
        selectionReason: candidate.selectionReason,
        status: 'conflict',
        blockLabel: block.label,
        readRef: block.readRef,
        sha256: block.sha256,
        reason: 'content_sha256_changed',
      },
      issue: { code: 'context_version_conflict', subject: candidate.candidateId },
    };
  }
  return {
    entry: {
      candidateId: candidate.candidateId,
      kind: block.kind,
      category: candidate.category,
      sourceRef: candidate.sourceRef,
      version: candidate.version,
      selectionReason: candidate.selectionReason,
      status: 'consumed',
      blockLabel: block.label,
      readRef: block.readRef,
      sha256: block.sha256,
      reason: null,
    },
    issue: null,
  };
}

export function buildContextManifest(input: BuildContextManifestInput): ContextManifest {
  if (!validInput(input)) throw new ContextManifestInputError();

  const blocks = new Map(input.context.blocks.map((block) => [block.label, block]));
  const entries: ContextManifestEntry[] = [];
  const issues: ContextManifestIssue[] = [];
  const registeredLabels = new Set<string>();
  for (const candidate of input.candidates) {
    if (candidate.blockLabel !== undefined) registeredLabels.add(candidate.blockLabel);
    const { entry, issue } = entryForCandidate(
      candidate,
      candidate.blockLabel === undefined ? undefined : blocks.get(candidate.blockLabel),
    );
    entries.push(entry);
    if (issue !== null) issues.push(issue);
  }
  for (const block of input.context.blocks) {
    if (!registeredLabels.has(block.label)) {
      issues.push({ code: 'unregistered_consumed_block', subject: block.label });
    }
  }

  const unsigned = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    runId: input.runId,
    projectId: input.projectResolution.projectId,
    asOf: input.asOf,
    status: issues.length === 0 ? 'ready' as const : 'blocked' as const,
    projectEvidence: {
      registryProjectId: input.projectResolution.registry.projectId,
      canonicalRef: input.projectResolution.canonical.ref,
      canonicalVersion: input.projectResolution.canonical.version,
      canonicalSha256: input.projectResolution.canonical.sha256,
      atlRef: input.projectResolution.atl.ref,
      atlSha256: input.projectResolution.atl.sha256,
    },
    entries,
    issues,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    ...unsigned,
    manifestId: `cm_${sha256.slice(0, 24)}`,
    sha256,
  };
}

export function isValidContextManifest(manifest: ContextManifest): boolean {
  const unsigned = {
    schemaVersion: manifest.schemaVersion,
    taskId: manifest.taskId,
    runId: manifest.runId,
    projectId: manifest.projectId,
    asOf: manifest.asOf,
    status: manifest.status,
    projectEvidence: manifest.projectEvidence,
    entries: manifest.entries,
    issues: manifest.issues,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const candidateIds = manifest.entries.map(({ candidateId }) => candidateId);
  const consumedLabels = manifest.entries.flatMap(({ blockLabel }) => (
    blockLabel === null ? [] : [blockLabel]
  ));
  const issueIdentities = manifest.issues.map(({ code, subject }) => `${code}:${subject}`);
  const validProjectEvidence = (
    manifest.projectEvidence.registryProjectId === manifest.projectId
    && manifest.projectEvidence.canonicalRef.trim() !== ''
    && manifest.projectEvidence.canonicalVersion.trim() !== ''
    && isSha256(manifest.projectEvidence.canonicalSha256)
    && manifest.projectEvidence.atlRef.trim() !== ''
    && isSha256(manifest.projectEvidence.atlSha256)
  );
  const validIssues = manifest.issues.every((issue) => (
    [
      'missing_consumption_evidence',
      'context_version_conflict',
      'context_identity_conflict',
      'unregistered_consumed_block',
    ].includes(issue.code)
    && issue.subject.trim() !== ''
  ));
  const expectedEntryIssues = new Set(manifest.entries.flatMap((entry) => {
    if (entry.status === 'failed') {
      return [`missing_consumption_evidence:${entry.candidateId}`];
    }
    if (entry.status === 'conflict') {
      const code = entry.reason === 'content_sha256_changed'
        ? 'context_version_conflict'
        : 'context_identity_conflict';
      return [`${code}:${entry.candidateId}`];
    }
    return [];
  }));
  const actualEntryIssues = new Set(manifest.issues.flatMap((issue) => (
    issue.code === 'unregistered_consumed_block'
      ? []
      : [`${issue.code}:${issue.subject}`]
  )));
  const blockLabels = new Set(consumedLabels);
  const validIssueBindings = (
    [...expectedEntryIssues].every((identity) => actualEntryIssues.has(identity))
    && [...actualEntryIssues].every((identity) => expectedEntryIssues.has(identity))
    && manifest.issues.every((issue) => (
      issue.code !== 'unregistered_consumed_block'
      || !blockLabels.has(issue.subject)
    ))
  );
  const validEntries = manifest.entries.every((entry) => {
    if (
      entry.candidateId.trim() === ''
      || !CONTEXT_CATEGORIES.includes(entry.category)
      || entry.sourceRef.trim() === ''
      || entry.selectionReason.trim() === ''
      || (entry.version !== null && entry.version.trim() === '')
      || !['consumed', 'excluded', 'failed', 'conflict'].includes(entry.status)
      || (entry.kind !== null && !CONTEXT_KINDS.includes(entry.kind))
    ) return false;
    if (entry.status === 'consumed') {
      return entry.kind !== null
        && kindMatchesCategory(entry.kind, entry.category)
        && entry.blockLabel !== null
        && entry.blockLabel.trim() !== ''
        && entry.readRef !== null
        && entry.readRef.trim() !== ''
        && entry.sha256 !== null
        && isSha256(entry.sha256)
        && entry.reason === null;
    }
    if (entry.status === 'excluded') {
      return entry.kind === null
        && entry.blockLabel === null
        && entry.readRef === null
        && entry.sha256 === null
        && entry.reason !== null
        && entry.reason.trim() !== '';
    }
    if (entry.status === 'failed') {
      return entry.kind === null
        && entry.blockLabel !== null
        && entry.blockLabel.trim() !== ''
        && entry.readRef === null
        && entry.sha256 === null
        && entry.reason !== null
        && entry.reason.trim() !== '';
    }
    return entry.kind !== null
      && entry.blockLabel !== null
      && entry.blockLabel.trim() !== ''
      && entry.readRef !== null
      && entry.readRef.trim() !== ''
      && entry.sha256 !== null
      && isSha256(entry.sha256)
      && entry.reason !== null
      && entry.reason.trim() !== '';
  });
  const validReadyState = manifest.status === 'ready'
    ? manifest.issues.length === 0
      && manifest.entries.every(({ status }) => status === 'consumed' || status === 'excluded')
    : manifest.status === 'blocked' && manifest.issues.length > 0;
  return manifest.schemaVersion === 1
    && manifest.taskId.trim() !== ''
    && manifest.runId.trim() !== ''
    && manifest.projectId.trim() !== ''
    && Number.isFinite(Date.parse(manifest.asOf))
    && validProjectEvidence
    && validReadyState
    && new Set(candidateIds).size === candidateIds.length
    && new Set(consumedLabels).size === consumedLabels.length
    && new Set(issueIdentities).size === issueIdentities.length
    && validIssues
    && validIssueBindings
    && validEntries
    && manifest.sha256 === sha256
    && manifest.manifestId === `cm_${sha256.slice(0, 24)}`;
}
