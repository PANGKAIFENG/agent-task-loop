import type { CandidateSourceRef } from '../domain/candidate-understanding.js';
import { resolveCandidateSource } from './resolve-candidate-source.js';

export interface CandidateSourceLocator {
  sourceNote: string;
  anchor: string | null;
}

export type OpenCandidateSourceResult = {
  actionId: 'open_source';
  outcome: 'located';
  sourceRefId: string;
  locator: CandidateSourceLocator;
} | {
  actionId: 'open_source';
  outcome: 'recovery_required';
  sourceRefId: string;
  locator: null;
  status: CandidateSourceRef['status'];
  failureReason: string;
};

export interface OpenCandidateSourceInput {
  source: CandidateSourceRef;
  root?: string;
  now?: Date;
  locateMoved?: (sourceKey: string) => Promise<string | null>;
}

function recovery(
  source: CandidateSourceRef,
  failureReason: string,
): OpenCandidateSourceResult {
  return {
    actionId: 'open_source',
    outcome: 'recovery_required',
    sourceRefId: source.sourceRefId,
    locator: null,
    status: source.status === 'missing' ? 'missing' : 'unavailable',
    failureReason,
  };
}

export async function openCandidateSource(
  input: OpenCandidateSourceInput,
): Promise<OpenCandidateSourceResult> {
  if (input.root === undefined) {
    return recovery(input.source, 'source_root_unavailable');
  }
  const resolved = await resolveCandidateSource({
    root: input.root,
    seed: {
      sourceRefId: input.source.sourceRefId,
      sourceType: input.source.sourceType,
      sourceKey: input.source.sourceKey,
      sourceNote: input.source.sourceNote,
      quote: input.source.quote,
      capturedAt: input.source.capturedAt,
    },
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.locateMoved === undefined ? {} : { locateMoved: input.locateMoved }),
  });
  if (resolved.status !== 'available' && resolved.status !== 'moved') {
    return recovery(resolved, resolved.failureReason ?? 'source_unavailable');
  }
  const sourceNote = resolved.lastVerifiedEvidence?.resolvedNote ?? resolved.sourceNote;
  if (sourceNote === null || sourceNote.trim() === '') {
    return recovery(resolved, 'source_reference_missing');
  }
  return {
    actionId: 'open_source',
    outcome: 'located',
    sourceRefId: resolved.sourceRefId,
    locator: {
      sourceNote,
      anchor: resolved.anchor,
    },
  };
}
