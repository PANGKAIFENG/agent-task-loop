import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

// PAW-GOAL-003 T1 CR fix 2: the lexical allowlist check in task.ts proves a
// context ref is inside a root as written; this module proves it again after
// the filesystem resolves symlinks. Only refs that exist on disk can be
// resolved — missing paths stay governed by the lexical check.

function containsRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Resolves every absolute context ref that exists on disk and requires it to
 * stay inside an allowlisted root after symlink resolution. Relative refs and
 * missing paths are ignored here — the lexical `contextRefErrors` check owns
 * them. Returns one field-level reason per escaping ref.
 */
export async function contextRefSymlinkErrors(
  refs: readonly string[],
  allowedLocalRoots: readonly string[] = [],
): Promise<string[]> {
  // With no configured roots the lexical check already rejects every
  // absolute ref; there is nothing to resolve against here.
  if (allowedLocalRoots.length === 0) {
    return [];
  }
  const errors: string[] = [];
  const rootCache = new Map<string, string | null>();
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed.startsWith('/')) {
      continue;
    }
    const resolvedRef = await realpathOrNull(resolve(trimmed));
    if (resolvedRef === null) {
      continue;
    }
    let contained = false;
    for (const root of allowedLocalRoots) {
      if (root === '') {
        continue;
      }
      let resolvedRoot = rootCache.get(root);
      if (resolvedRoot === undefined) {
        resolvedRoot = await realpathOrNull(resolve(root));
        rootCache.set(root, resolvedRoot);
      }
      const effectiveRoot = resolvedRoot ?? resolve(root);
      if (containsRoot(effectiveRoot, resolvedRef)) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      errors.push(`contextRefs entry escapes the allowlist through a symlink: ${trimmed}`);
    }
  }
  return errors;
}
