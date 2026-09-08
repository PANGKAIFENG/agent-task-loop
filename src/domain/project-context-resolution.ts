import { createHash } from 'node:crypto';

import { projectSchema, type Project } from './project.js';

export type ProjectMappingVerification = 'verified' | 'unverified';

export interface ProjectRegistryEntry {
  projectId: string;
  aliases: string[];
  verification: ProjectMappingVerification;
  canonicalProjectRef: string;
  atlProjectId: string;
  repoRefs: string[];
}

export interface CanonicalProjectContext {
  projectId: string;
  ref: string;
  atlProjectId: string;
  repoRefs: string[];
  version: string;
  sha256: string;
}

export interface AtlProjectContext {
  project: Project;
  ref: string;
  canonicalProjectRef: string;
  repoRefs: string[];
  sha256: string;
}

export interface ProjectSourceSignal {
  value: string;
  sourceRef: string;
}

export interface ProjectResolutionCandidate {
  projectId: string;
  verification: ProjectMappingVerification;
  matchedAliases: string[];
  evidenceRefs: string[];
}

export interface ProjectContextConflict {
  code:
    | 'missing_canonical_project'
    | 'missing_atl_project'
    | 'duplicate_registry_project'
    | 'duplicate_canonical_project'
    | 'duplicate_atl_project'
    | 'invalid_project_evidence'
    | 'atl_project_id_mismatch'
    | 'canonical_ref_mismatch'
    | 'repo_ref_mismatch';
  refs: string[];
}

export interface ResolvedProjectContext {
  status: 'resolved';
  projectId: string;
  match: {
    kind: 'explicit_project_id' | 'verified_alias';
    value: string;
    sourceRef: string | null;
  };
  registry: ProjectRegistryEntry;
  canonical: CanonicalProjectContext;
  atl: AtlProjectContext;
}

export interface ProjectContextNeedsDecision {
  status: 'needs_decision';
  reason: 'project_not_found' | 'multiple_candidates' | 'unverified_mapping';
  candidates: ProjectResolutionCandidate[];
}

export interface ProjectContextConflictResult {
  status: 'conflict';
  projectId: string;
  issues: ProjectContextConflict[];
  candidates: ProjectResolutionCandidate[];
}

export type ProjectContextResolution =
  | ResolvedProjectContext
  | ProjectContextNeedsDecision
  | ProjectContextConflictResult;

export interface ResolveProjectContextInput {
  requestedProjectId: string | null;
  sourceSignals: ProjectSourceSignal[];
  registry: ProjectRegistryEntry[];
  canonicalProjects: CanonicalProjectContext[];
  atlProjects: AtlProjectContext[];
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = uniqueSorted(left);
  const sortedRight = uniqueSorted(right);
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function candidatesForSignals(
  registry: ProjectRegistryEntry[],
  signals: ProjectSourceSignal[],
): ProjectResolutionCandidate[] {
  const result: ProjectResolutionCandidate[] = [];
  for (const entry of registry) {
    const aliases = new Map(entry.aliases.map((alias) => [normalized(alias), alias]));
    const matched = signals.filter((signal) => aliases.has(normalized(signal.value)));
    if (matched.length === 0) continue;
    result.push({
      projectId: entry.projectId,
      verification: entry.verification,
      matchedAliases: uniqueSorted(matched.map((signal) => signal.value.trim())),
      evidenceRefs: uniqueSorted(matched.map((signal) => signal.sourceRef)),
    });
  }
  return result;
}

function explicitCandidate(entry: ProjectRegistryEntry): ProjectResolutionCandidate {
  return {
    projectId: entry.projectId,
    verification: entry.verification,
    matchedAliases: [],
    evidenceRefs: [],
  };
}

function layerConflicts(
  registry: ProjectRegistryEntry,
  canonical: CanonicalProjectContext | undefined,
  atl: AtlProjectContext | undefined,
): ProjectContextConflict[] {
  const issues: ProjectContextConflict[] = [];
  if (canonical === undefined) {
    issues.push({
      code: 'missing_canonical_project',
      refs: [registry.canonicalProjectRef],
    });
  }
  if (atl === undefined) {
    issues.push({
      code: 'missing_atl_project',
      refs: [`atl-project://${registry.atlProjectId}`],
    });
  }
  if (canonical !== undefined && canonical.atlProjectId !== registry.atlProjectId) {
    issues.push({
      code: 'atl_project_id_mismatch',
      refs: [registry.atlProjectId, canonical.atlProjectId],
    });
  }
  if (
    (canonical !== undefined && canonical.ref !== registry.canonicalProjectRef)
    || (atl !== undefined && atl.canonicalProjectRef !== registry.canonicalProjectRef)
  ) {
    issues.push({
      code: 'canonical_ref_mismatch',
      refs: uniqueSorted([
        registry.canonicalProjectRef,
        ...(canonical === undefined ? [] : [canonical.ref]),
        ...(atl === undefined ? [] : [atl.canonicalProjectRef]),
      ]),
    });
  }
  if (
    (canonical !== undefined && !sameRefs(registry.repoRefs, canonical.repoRefs))
    || (atl !== undefined && !sameRefs(registry.repoRefs, atl.repoRefs))
  ) {
    issues.push({
      code: 'repo_ref_mismatch',
      refs: uniqueSorted([
        ...registry.repoRefs,
        ...(canonical?.repoRefs ?? []),
        ...(atl?.repoRefs ?? []),
      ]),
    });
  }
  return issues;
}

function duplicateLayerConflicts(
  _projectId: string,
  input: ResolveProjectContextInput,
): ProjectContextConflict[] {
  const issues: ProjectContextConflict[] = [];
  const duplicated = <T>(items: T[], identities: (item: T) => string[]): T[] => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const identity of identities(item)) {
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
      }
    }
    return items.filter((item) => identities(item).some((identity) => (
      (counts.get(identity) ?? 0) > 1
    )));
  };
  const registry = duplicated(input.registry, (entry) => [
    `project:${entry.projectId}`,
    `canonical:${entry.canonicalProjectRef}`,
    `atl:${entry.atlProjectId}`,
  ]);
  const canonical = duplicated(input.canonicalProjects, (entry) => [
    `project:${entry.projectId}`,
    `canonical:${entry.ref}`,
    `atl:${entry.atlProjectId}`,
  ]);
  const atl = duplicated(input.atlProjects, (entry) => [
    `project:${entry.project.projectId}`,
    `atl-ref:${entry.ref}`,
    `canonical:${entry.canonicalProjectRef}`,
  ]);
  if (registry.length > 0) {
    issues.push({
      code: 'duplicate_registry_project',
      refs: uniqueSorted(registry.flatMap((entry) => [
        entry.canonicalProjectRef,
        `atl-project://${entry.atlProjectId}`,
        ...entry.repoRefs,
      ])),
    });
  }
  if (canonical.length > 0) {
    issues.push({
      code: 'duplicate_canonical_project',
      refs: uniqueSorted(canonical.flatMap((entry) => [entry.ref, entry.sha256])),
    });
  }
  if (atl.length > 0) {
    issues.push({
      code: 'duplicate_atl_project',
      refs: uniqueSorted(atl.flatMap((entry) => [entry.ref, entry.sha256])),
    });
  }
  return issues;
}

function nonEmpty(value: string): boolean {
  return value.trim() !== '';
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

export function projectContextSha256(project: Project): string {
  const parsed = projectSchema.safeParse(project);
  if (!parsed.success) return '';
  return createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
}

export function isValidResolvedProjectContext(
  resolution: ResolvedProjectContext,
): boolean {
  const { registry, canonical, atl } = resolution;
  if (
    resolution.status !== 'resolved'
    || !nonEmpty(resolution.projectId)
    || registry.verification !== 'verified'
    || !nonEmpty(registry.projectId)
    || !nonEmpty(registry.canonicalProjectRef)
    || !nonEmpty(registry.atlProjectId)
    || !nonEmpty(canonical.ref)
    || !nonEmpty(canonical.version)
    || !isSha256(canonical.sha256)
    || !nonEmpty(atl.ref)
    || !isSha256(atl.sha256)
    || !projectSchema.safeParse(atl.project).success
    || projectContextSha256(atl.project) !== atl.sha256
    || resolution.projectId !== registry.projectId
    || canonical.projectId !== registry.projectId
    || registry.atlProjectId !== canonical.atlProjectId
    || registry.atlProjectId !== atl.project.projectId
    || layerConflicts(registry, canonical, atl).length > 0
  ) return false;

  if (resolution.match.kind === 'explicit_project_id') {
    return resolution.match.value === registry.projectId
      && resolution.match.sourceRef === null;
  }
  return nonEmpty(resolution.match.value)
    && resolution.match.sourceRef !== null
    && nonEmpty(resolution.match.sourceRef)
    && registry.aliases.some((alias) => (
      normalized(alias) === normalized(resolution.match.value)
    ));
}

export function resolveProjectContext(
  input: ResolveProjectContextInput,
): ProjectContextResolution {
  const requestedProjectId = input.requestedProjectId?.trim() ?? '';
  let candidates: ProjectResolutionCandidate[];
  if (requestedProjectId !== '') {
    const entry = input.registry.find(({ projectId }) => projectId === requestedProjectId);
    candidates = entry === undefined ? [] : [explicitCandidate(entry)];
  } else {
    candidates = candidatesForSignals(input.registry, input.sourceSignals);
  }

  if (candidates.length === 0) {
    return { status: 'needs_decision', reason: 'project_not_found', candidates: [] };
  }
  if (candidates.length > 1) {
    return { status: 'needs_decision', reason: 'multiple_candidates', candidates };
  }
  const candidate = candidates[0]!;
  const duplicateIssues = duplicateLayerConflicts(candidate.projectId, input);
  if (duplicateIssues.length > 0) {
    return {
      status: 'conflict',
      projectId: candidate.projectId,
      issues: duplicateIssues,
      candidates,
    };
  }
  if (candidate.verification !== 'verified') {
    return { status: 'needs_decision', reason: 'unverified_mapping', candidates };
  }

  const registry = input.registry.find(({ projectId }) => projectId === candidate.projectId)!;
  const canonical = input.canonicalProjects.find(({ projectId }) => (
    projectId === registry.projectId
  ));
  const atl = input.atlProjects.find(({ project }) => (
    project.projectId === registry.atlProjectId
  ));
  const issues = layerConflicts(registry, canonical, atl);
  if (issues.length > 0 || canonical === undefined || atl === undefined) {
    return { status: 'conflict', projectId: registry.projectId, issues, candidates };
  }

  const aliasMatch = requestedProjectId === '';
  const sourceMatch = aliasMatch
    ? input.sourceSignals.find((signal) => (
        registry.aliases.some((alias) => normalized(alias) === normalized(signal.value))
      ))
    : undefined;
  const resolution: ResolvedProjectContext = {
    status: 'resolved',
    projectId: registry.projectId,
    match: {
      kind: aliasMatch ? 'verified_alias' : 'explicit_project_id',
      value: aliasMatch ? sourceMatch!.value.trim() : requestedProjectId,
      sourceRef: sourceMatch?.sourceRef ?? null,
    },
    registry,
    canonical,
    atl,
  };
  if (!isValidResolvedProjectContext(resolution)) {
    return {
      status: 'conflict',
      projectId: registry.projectId,
      issues: [{
        code: 'invalid_project_evidence',
        refs: [registry.canonicalProjectRef, atl.ref],
      }],
      candidates,
    };
  }
  return resolution;
}
