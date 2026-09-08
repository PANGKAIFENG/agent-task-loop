import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  candidateSourceRefSchema,
  type CandidateSourceRef,
} from '../domain/candidate-understanding.js';

const MAX_SOURCE_CHARACTERS = 64_000;

export interface CandidateSourceSeed {
  sourceRefId: string;
  sourceType: string;
  sourceKey: string;
  sourceNote: string | null;
  quote: string | null;
  capturedAt: string;
}

export interface ResolveCandidateSourceInput {
  root: string;
  seed: CandidateSourceSeed;
  now?: Date;
  locateMoved?: (sourceKey: string) => Promise<string | null>;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function pathFailure(relativePath: string): string | null {
  if (hasControlCharacter(relativePath) || relativePath.includes('\\')) {
    return 'source_path_invalid';
  }
  if (isAbsolute(relativePath)) return 'source_path_outside_root';
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'source_path_outside_root';
  }
  return null;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function hasSymlink(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) return true;
  }
  return false;
}

function baseRef(
  seed: CandidateSourceSeed,
  status: CandidateSourceRef['status'],
  failureReason: string,
): CandidateSourceRef {
  return candidateSourceRefSchema.parse({
    sourceRefId: seed.sourceRefId,
    sourceType: seed.sourceType,
    sourceKey: seed.sourceKey.slice(0, 300),
    sourceNote: seed.sourceNote?.slice(0, 500) ?? null,
    anchor: null,
    quote: seed.quote?.trim().slice(0, 300) ?? '',
    capturedAt: seed.capturedAt,
    lastVerifiedAt: null,
    status,
    failureReason,
    parentContext: null,
    lastVerifiedEvidence: null,
  });
}

function parentContext(lines: readonly string[], index: number): string | null {
  const context = lines
    .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
    .join('\n')
    .trim()
    .slice(0, 1_000);
  return context === '' ? null : context;
}

function verifiedRef(input: {
  seed: CandidateSourceSeed;
  note: string;
  content: string;
  now: Date;
  moved: boolean;
}): CandidateSourceRef {
  const quote = input.seed.quote?.trim().slice(0, 300) ?? '';
  const lines = input.content.split(/\r?\n/u);
  const lineIndex = lines.findIndex((line) => line.includes(quote));
  const matched = quote !== '' && lineIndex >= 0;
  return candidateSourceRefSchema.parse({
    sourceRefId: input.seed.sourceRefId,
    sourceType: input.seed.sourceType,
    sourceKey: input.seed.sourceKey.slice(0, 300),
    sourceNote: input.note.slice(0, 500),
    anchor: matched ? `line:${lineIndex + 1}` : null,
    quote,
    capturedAt: input.seed.capturedAt,
    lastVerifiedAt: input.now.toISOString(),
    status: matched ? (input.moved ? 'moved' : 'available') : 'changed',
    failureReason: matched
      ? (input.moved ? 'source_moved' : null)
      : input.moved ? 'source_moved_quote_changed' : 'source_quote_changed',
    parentContext: matched ? parentContext(lines, lineIndex) : null,
    lastVerifiedEvidence: {
      resolvedNote: input.note.slice(0, 500),
      checkedCharacters: input.content.length,
      quoteMatched: matched,
      truncated: false,
    },
  });
}

async function readVerified(input: {
  root: string;
  note: string;
  seed: CandidateSourceSeed;
  now: Date;
  moved: boolean;
}): Promise<CandidateSourceRef> {
  const unsafe = pathFailure(input.note);
  if (unsafe !== null) return baseRef(input.seed, 'unavailable', unsafe);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(input.root);
  } catch {
    return baseRef(input.seed, 'unavailable', 'source_root_unavailable');
  }
  const candidate = resolve(canonicalRoot, input.note);
  if (!inside(canonicalRoot, candidate)) {
    return baseRef(input.seed, 'unavailable', 'source_path_outside_root');
  }
  try {
    if (await hasSymlink(canonicalRoot, input.note)) {
      return baseRef(input.seed, 'unavailable', 'source_symlink_rejected');
    }
    const canonicalCandidate = await realpath(candidate);
    if (!inside(canonicalRoot, canonicalCandidate)) {
      return baseRef(input.seed, 'unavailable', 'source_path_outside_root');
    }
    const metadata = await stat(canonicalCandidate);
    if (!metadata.isFile()) {
      return baseRef(input.seed, 'unavailable', 'source_not_file');
    }
    if (metadata.size > MAX_SOURCE_CHARACTERS) {
      const limited = baseRef(input.seed, 'unavailable', 'source_read_limit_exceeded');
      return {
        ...limited,
        lastVerifiedAt: input.now.toISOString(),
        lastVerifiedEvidence: {
          resolvedNote: input.note.slice(0, 500),
          checkedCharacters: 0,
          quoteMatched: false,
          truncated: true,
        },
      };
    }
    const content = await readFile(canonicalCandidate, 'utf8');
    if (content.length > MAX_SOURCE_CHARACTERS) {
      const limited = baseRef(input.seed, 'unavailable', 'source_read_limit_exceeded');
      return {
        ...limited,
        lastVerifiedAt: input.now.toISOString(),
        lastVerifiedEvidence: {
          resolvedNote: input.note.slice(0, 500),
          checkedCharacters: 0,
          quoteMatched: false,
          truncated: true,
        },
      };
    }
    return verifiedRef({ ...input, content });
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? (error as Error & { code?: string }).code
      : undefined;
    if (code === 'ENOENT') return baseRef(input.seed, 'unavailable', 'source_not_found');
    return baseRef(input.seed, 'unavailable', 'source_read_failed');
  }
}

export async function resolveCandidateSource(
  input: ResolveCandidateSourceInput,
): Promise<CandidateSourceRef> {
  const now = input.now ?? new Date();
  const quote = input.seed.quote?.trim() ?? '';
  const originalNote = input.seed.sourceNote?.trim() ?? '';
  if (quote === '' || (originalNote === '' && input.seed.sourceKey.trim() === '')) {
    return baseRef(input.seed, 'missing', 'source_reference_missing');
  }
  if (originalNote !== '') {
    const original = await readVerified({
      root: input.root,
      note: originalNote,
      seed: input.seed,
      now,
      moved: false,
    });
    if (original.failureReason !== 'source_not_found') return original;
  }
  if (input.locateMoved !== undefined && input.seed.sourceKey.trim() !== '') {
    const movedNote = await input.locateMoved(input.seed.sourceKey);
    if (movedNote !== null && movedNote.trim() !== '') {
      return readVerified({
        root: input.root,
        note: movedNote.trim(),
        seed: input.seed,
        now,
        moved: true,
      });
    }
  }
  return originalNote === ''
    ? baseRef(input.seed, 'missing', 'source_reference_missing')
    : baseRef(input.seed, 'unavailable', 'source_not_found');
}
