import { readFile } from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  BuildContextManifestInput,
  ContextManifest,
} from '../../../src/domain/context-manifest.js';
import type { ResolvedProjectContext } from '../../../src/domain/project-context-resolution.js';
import { projectContextSha256 } from '../../../src/domain/project-context-resolution.js';
import {
  persistContextManifest,
  readContextManifestById,
  readContextManifestForRun,
} from '../../../src/runner/context-manifest-runtime.js';

const roots: string[] = [];
const NOW = '2026-08-31T10:00:00.000Z';
const atlProject = {
  projectId: 'atl-skill-eval',
  name: 'Synthetic Skill Eval',
  description: 'Synthetic only.',
  resources: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const projectResolution: ResolvedProjectContext = {
  status: 'resolved',
  projectId: 'project-skill-eval',
  match: {
    kind: 'explicit_project_id',
    value: 'project-skill-eval',
    sourceRef: null,
  },
  registry: {
    projectId: 'project-skill-eval',
    aliases: ['skill eval'],
    verification: 'verified',
    canonicalProjectRef: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
  },
  canonical: {
    projectId: 'project-skill-eval',
    ref: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
    version: 'v3',
    sha256: 'a'.repeat(64),
  },
  atl: {
    project: atlProject,
    ref: 'atl-project://atl-skill-eval',
    canonicalProjectRef: 'projects://skill-eval/home',
    repoRefs: ['repo://personal-ai-workbench'],
    sha256: projectContextSha256(atlProject),
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-context-manifest-'));
  roots.push(root);
  return root;
}

describe('persistContextManifest', () => {
  it('create-only persists the same Run-bound Manifest idempotently', async () => {
    const root = await runtimeRoot();
    const taskSha = 'c'.repeat(64);
    const options: BuildContextManifestInput = {
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      asOf: NOW,
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [{
          label: 'task',
          kind: 'task',
          category: 'task' as const,
          sourceRef: 'task://synthetic-96',
          version: NOW,
          readRef: 'memory://task',
          sha256: taskSha,
        }],
      },
      candidates: [{
        candidateId: 'task-current',
        category: 'task' as const,
        sourceRef: 'task://synthetic-96',
        version: NOW,
        expectedSha256: taskSha,
        selection: 'selected' as const,
        selectionReason: 'The current task is required.',
        blockLabel: 'task',
      }],
    };

    const first = await persistContextManifest(root, options);
    const second = await persistContextManifest(root, options);
    const files = await readdir(join(root, 'context-manifests'));
    const raw = await readFile(first.absolutePath, 'utf8');

    expect(second).toEqual(first);
    expect(files).toEqual([expect.stringMatching(/^cmr_[0-9a-f]{24}\.json$/)]);
    expect(JSON.parse(raw) as ContextManifest).toEqual(first.manifest);
    expect(first.documentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reloads a persisted Manifest by stable ID or Task and Run without process memory', async () => {
    const root = await runtimeRoot();
    const taskSha = 'c'.repeat(64);
    const options: BuildContextManifestInput = {
      taskId: 'task-synthetic-reload',
      runId: 'run-synthetic-reload',
      asOf: NOW,
      projectResolution,
      context: {
        taskId: 'task-synthetic-reload',
        blocks: [{
          label: 'task',
          kind: 'task',
          category: 'task',
          sourceRef: 'task://synthetic-reload',
          version: NOW,
          readRef: 'memory://task',
          sha256: taskSha,
        }],
      },
      candidates: [{
        candidateId: 'task-current',
        category: 'task',
        sourceRef: 'task://synthetic-reload',
        version: NOW,
        expectedSha256: taskSha,
        selection: 'selected',
        selectionReason: 'The current task is required.',
        blockLabel: 'task',
      }],
    };
    const persisted = await persistContextManifest(root, options);

    await expect(readContextManifestForRun(
      root,
      options.taskId,
      options.runId,
    )).resolves.toEqual(persisted.manifest);
    await expect(readContextManifestById(
      root,
      persisted.manifest.manifestId,
    )).resolves.toEqual(persisted.manifest);
  });

  it('rejects a second Manifest with different contents for the same Task and Run', async () => {
    const root = await runtimeRoot();
    const taskSha = 'c'.repeat(64);
    const options: BuildContextManifestInput = {
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      asOf: NOW,
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [{
          label: 'task',
          kind: 'task',
          category: 'task' as const,
          sourceRef: 'task://synthetic-96',
          version: NOW,
          readRef: 'memory://task',
          sha256: taskSha,
        }],
      },
      candidates: [{
        candidateId: 'task-current',
        category: 'task' as const,
        sourceRef: 'task://synthetic-96',
        version: NOW,
        expectedSha256: taskSha,
        selection: 'selected' as const,
        selectionReason: 'The current task is required.',
        blockLabel: 'task',
      }],
    };
    await persistContextManifest(root, options);

    await expect(persistContextManifest(root, {
      ...options,
      asOf: '2026-08-31T10:01:00.000Z',
    })).rejects.toMatchObject({ code: 'context_manifest_runtime_conflict' });
    await expect(readdir(join(root, 'context-manifests'))).resolves.toHaveLength(1);
  });

  it('persists blocked evidence instead of silently dropping a missing read', async () => {
    const root = await runtimeRoot();
    const persisted = await persistContextManifest(root, {
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-blocked',
      asOf: NOW,
      projectResolution,
      context: { taskId: 'task-synthetic-96', blocks: [] },
      candidates: [{
        candidateId: 'feedback-required',
        category: 'feedback',
        sourceRef: 'feedback://context-depth',
        version: 'v1',
        expectedSha256: 'd'.repeat(64),
        selection: 'selected',
        selectionReason: 'Confirmed feedback applies.',
        blockLabel: 'feedback_context_depth',
      }],
    });

    expect(persisted.manifest.status).toBe('blocked');
    expect(persisted.manifest.issues).toContainEqual({
      code: 'missing_consumption_evidence',
      subject: 'feedback-required',
    });
    await expect(readFile(persisted.absolutePath, 'utf8')).resolves
      .toContain('missing_consumption_evidence');
  });
});
