import { describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import {
  projectContextSha256,
  resolveProjectContext,
  type AtlProjectContext,
  type CanonicalProjectContext,
  type ProjectRegistryEntry,
} from '../../../src/domain/project-context-resolution.js';

const SHA_A = 'a'.repeat(64);

function registryEntry(
  overrides: Partial<ProjectRegistryEntry> = {},
): ProjectRegistryEntry {
  return {
    projectId: 'project-skill-eval',
    aliases: ['skill eval', 'skill evaluation'],
    verification: 'verified',
    canonicalProjectRef: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
    ...overrides,
  };
}

function canonicalProject(
  overrides: Partial<CanonicalProjectContext> = {},
): CanonicalProjectContext {
  return {
    projectId: 'project-skill-eval',
    ref: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
    version: '2026-08-31T10:00:00.000Z',
    sha256: SHA_A,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    projectId: 'atl-skill-eval',
    name: 'Synthetic Skill Eval',
    description: 'Synthetic project context only.',
    resources: [{
      kind: 'github_repo',
      value: 'personal-ai-workbench',
      label: 'Synthetic repository',
    }],
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  };
}

function atlProject(overrides: Partial<AtlProjectContext> = {}): AtlProjectContext {
  const persistedProject = project();
  return {
    project: persistedProject,
    ref: 'atl-project://atl-skill-eval',
    canonicalProjectRef: 'projects://skill-eval/home',
    repoRefs: ['repo://personal-ai-workbench'],
    sha256: projectContextSha256(persistedProject),
    ...overrides,
  };
}

describe('resolveProjectContext', () => {
  it('resolves one verified Source alias and records the matching evidence', () => {
    const result = resolveProjectContext({
      requestedProjectId: null,
      sourceSignals: [{
        value: ' Skill Evaluation ',
        sourceRef: 'source://synthetic-task/alias',
      }],
      registry: [registryEntry()],
      canonicalProjects: [canonicalProject()],
      atlProjects: [atlProject()],
    });

    expect(result).toMatchObject({
      status: 'resolved',
      projectId: 'project-skill-eval',
      match: {
        kind: 'verified_alias',
        sourceRef: 'source://synthetic-task/alias',
        value: 'Skill Evaluation',
      },
      registry: { atlProjectId: 'atl-skill-eval' },
      canonical: { ref: 'projects://skill-eval/home', sha256: SHA_A },
      atl: {
        ref: 'atl-project://atl-skill-eval',
        sha256: projectContextSha256(project()),
      },
    });
  });

  it('uses an explicit stable project ID without requiring an alias signal', () => {
    const result = resolveProjectContext({
      requestedProjectId: 'project-skill-eval',
      sourceSignals: [],
      registry: [registryEntry()],
      canonicalProjects: [canonicalProject()],
      atlProjects: [atlProject()],
    });

    expect(result).toMatchObject({
      status: 'resolved',
      match: { kind: 'explicit_project_id', value: 'project-skill-eval' },
    });
  });

  it('requires a decision when the same Source alias maps to multiple projects', () => {
    const result = resolveProjectContext({
      requestedProjectId: null,
      sourceSignals: [{ value: 'skill eval', sourceRef: 'source://synthetic-task/alias' }],
      registry: [
        registryEntry(),
        registryEntry({
          projectId: 'project-skill-lab',
          canonicalProjectRef: 'projects://skill-lab/home',
          atlProjectId: 'atl-skill-lab',
        }),
      ],
      canonicalProjects: [],
      atlProjects: [],
    });

    expect(result).toMatchObject({
      status: 'needs_decision',
      reason: 'multiple_candidates',
    });
    if (result.status === 'needs_decision') {
      expect(result.candidates.map(({ projectId }) => projectId)).toEqual([
        'project-skill-eval',
        'project-skill-lab',
      ]);
      expect(result.candidates.every(({ evidenceRefs }) => (
        evidenceRefs.includes('source://synthetic-task/alias')
      ))).toBe(true);
    }
  });

  it('does not auto-bind an alias whose registry mapping is unverified', () => {
    const result = resolveProjectContext({
      requestedProjectId: null,
      sourceSignals: [{ value: 'skill eval', sourceRef: 'source://synthetic-task/alias' }],
      registry: [registryEntry({ verification: 'unverified' })],
      canonicalProjects: [canonicalProject()],
      atlProjects: [atlProject()],
    });

    expect(result).toMatchObject({
      status: 'needs_decision',
      reason: 'unverified_mapping',
      candidates: [{ projectId: 'project-skill-eval', verification: 'unverified' }],
    });
  });

  it('returns layer conflicts instead of silently joining inconsistent context', () => {
    const result = resolveProjectContext({
      requestedProjectId: 'project-skill-eval',
      sourceSignals: [],
      registry: [registryEntry()],
      canonicalProjects: [canonicalProject({
        atlProjectId: 'atl-other',
        repoRefs: ['repo://different-baseline'],
      })],
      atlProjects: [atlProject({
        canonicalProjectRef: 'projects://different/home',
      })],
    });

    expect(result).toMatchObject({
      status: 'conflict',
      projectId: 'project-skill-eval',
    });
    if (result.status === 'conflict') {
      expect(result.issues.map(({ code }) => code)).toEqual([
        'atl_project_id_mismatch',
        'canonical_ref_mismatch',
        'repo_ref_mismatch',
      ]);
    }
  });

  it('rejects conflicting duplicate records for the same stable project identity', () => {
    const result = resolveProjectContext({
      requestedProjectId: 'project-skill-eval',
      sourceSignals: [],
      registry: [
        registryEntry(),
        registryEntry({
          canonicalProjectRef: 'projects://conflicting/home',
          repoRefs: ['repo://conflicting'],
        }),
      ],
      canonicalProjects: [
        canonicalProject(),
        canonicalProject({
          ref: 'projects://conflicting/home',
          repoRefs: ['repo://conflicting'],
          sha256: 'c'.repeat(64),
        }),
      ],
      atlProjects: [
        atlProject(),
        atlProject({
          canonicalProjectRef: 'projects://conflicting/home',
          repoRefs: ['repo://conflicting'],
          sha256: 'd'.repeat(64),
        }),
      ],
    });

    expect(result).toMatchObject({
      status: 'conflict',
      projectId: 'project-skill-eval',
    });
    if (result.status === 'conflict') {
      expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
        'duplicate_registry_project',
        'duplicate_canonical_project',
        'duplicate_atl_project',
      ]));
    }
  });

  it.each([
    ['canonicalProjectRef', 'atlProjectId'],
    ['atlProjectId', 'canonicalProjectRef'],
  ] as const)('rejects cross-project reuse of a stable %s', (reusedField, distinctField) => {
    const duplicate = registryEntry({
      projectId: 'project-other',
      aliases: ['other'],
      [distinctField]: distinctField === 'atlProjectId'
        ? 'atl-other'
        : 'projects://other/home',
    });
    const result = resolveProjectContext({
      requestedProjectId: 'project-skill-eval',
      sourceSignals: [],
      registry: [registryEntry(), duplicate],
      canonicalProjects: [canonicalProject()],
      atlProjects: [atlProject()],
    });

    expect(result).toMatchObject({ status: 'conflict' });
  });

  it('rejects an ATL Project SHA that is not derived from the persisted Project readback', () => {
    const result = resolveProjectContext({
      requestedProjectId: 'project-skill-eval',
      sourceSignals: [],
      registry: [registryEntry()],
      canonicalProjects: [canonicalProject()],
      atlProjects: [atlProject({ sha256: 'f'.repeat(64) })],
    });

    expect(result).toMatchObject({ status: 'conflict' });
    if (result.status === 'conflict') {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: 'invalid_project_evidence',
      }));
    }
  });
});
