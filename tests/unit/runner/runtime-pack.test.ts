import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { buildContextBundle } from '../../../src/runner/context-bundle.js';
import {
  persistRuntimePack,
  type RuntimePack,
} from '../../../src/runner/runtime-pack.js';

const NOW = '2026-07-15T00:00:00.000Z';
const roots: string[] = [];

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-runtime-pack-001',
    title: 'Runtime pack test',
    body: 'BODY_MUST_NOT_BE_PERSISTED',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-runtime-pack',
    taskType: 'research',
    objective: 'Compare public product limits.',
    acceptanceCriteria: ['Cite official evidence.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:runtime-pack',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-runtime-pack-001',
      agent: 'test-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-15T01:00:00.000Z',
    },
    artifactRefs: [
      'Artifacts/task-runtime-pack-001/attempt-001.md',
      'Artifacts/task-runtime-pack-001/attempt-002.md',
    ],
    reviewFeedback: 'FEEDBACK_MUST_NOT_BE_PERSISTED_AS_BODY',
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function project(): Project {
  return {
    projectId: 'project-runtime-pack',
    name: 'Runtime pack project',
    description: 'Project description.',
    resources: [{
      kind: 'url',
      value: 'https://example.com/docs',
      label: 'Official docs',
    }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persistRuntimePack', () => {
  it('writes an immutable manifest with context metadata, not context bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-'));
    roots.push(root);
    const source = join(root, 'source.md');
    await writeFile(source, 'PRIVATE_SOURCE_BODY_MUST_NOT_BE_PERSISTED');
    const context = await buildContextBundle(
      { ...task(), sourceNote: source },
      project(),
      {
        allowedLocalRoots: [root],
        previousArtifact: {
          reference: 'Artifacts/task-runtime-pack-001/attempt-002.md',
          summary: 'Previous Artifact summary.',
          evidenceCount: 1,
        },
      },
    );

    const first = await persistRuntimePack(root, {
      task: { ...task(), sourceNote: source },
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    });
    const second = await persistRuntimePack(root, {
      task: { ...task(), sourceNote: source },
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    });
    const raw = await readFile(first.absolutePath, 'utf8');
    const manifest = JSON.parse(raw) as RuntimePack;

    expect(second).toEqual(first);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      packId: first.packId,
      taskId: task().taskId,
      runId: task().claim?.runId,
      stateVersion: task().updatedAt,
      permissionProfile: 'read_only_research',
      projectContextRefs: [`project:project-runtime-pack@${NOW}`],
      previousArtifactRefs: ['Artifacts/task-runtime-pack-001/attempt-002.md'],
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    });
    expect(manifest.blocks).toEqual(context.blocks.map(({ label, kind, sha256 }) => ({
      label,
      kind,
      sha256,
    })));
    expect(raw).not.toContain('PRIVATE_SOURCE_BODY_MUST_NOT_BE_PERSISTED');
    expect(raw).not.toContain('BODY_MUST_NOT_BE_PERSISTED');
    expect(raw).not.toContain('FEEDBACK_MUST_NOT_BE_PERSISTED_AS_BODY');
  });

  it('rejects task, claim, and context identities that do not describe one run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-'));
    roots.push(root);
    const context = await buildContextBundle(task(), project(), {
      allowedLocalRoots: [],
    });

    await expect(persistRuntimePack(root, {
      task: { ...task(), claim: null },
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_runtime_pack_input' });
    await expect(persistRuntimePack(root, {
      task: task(),
      project: project(),
      context: { ...context, taskId: 'task-other' },
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_runtime_pack_input' });
    await expect(persistRuntimePack(root, {
      task: task(),
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T02:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_runtime_pack_input' });
  });

  it('rejects a symlinked runtime root without creating directories outside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-'));
    const outside = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-outside-'));
    roots.push(root, outside);
    const runtimeRoot = join(root, '.atl-runtime');
    await symlink(outside, runtimeRoot);
    const context = await buildContextBundle(task(), project(), {
      allowedLocalRoots: [],
    });

    await expect(persistRuntimePack(runtimeRoot, {
      task: task(),
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_storage_entry' });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('rejects a symlinked context-pack directory without writing outside runtime root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-'));
    const outside = await mkdtemp(join(tmpdir(), 'atl-runtime-pack-outside-'));
    roots.push(root, outside);
    const runtimeRoot = join(root, '.atl-runtime');
    await mkdir(runtimeRoot);
    await symlink(outside, join(runtimeRoot, 'context-packs'));
    const context = await buildContextBundle(task(), project(), {
      allowedLocalRoots: [],
    });

    await expect(persistRuntimePack(runtimeRoot, {
      task: task(),
      project: project(),
      context,
      asOf: NOW,
      expiresAt: '2026-07-15T01:00:00.000Z',
    })).rejects.toMatchObject({ code: 'invalid_storage_entry' });
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
