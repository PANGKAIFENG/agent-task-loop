import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bindCodexTask } from '../../../src/services/bind-codex-task.js';
import {
  readBoundCodexArtifact,
  snapshotCodexArtifact,
} from '../../../src/services/snapshot-codex-artifact.js';
import { FileCodexFeedbackStateRepository } from '../../../src/storage/file-codex-feedback-state-repository.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const roots: string[] = [];
const NOW = new Date('2026-09-07T02:00:00.000Z');

type FileHandlePrototype = {
  readFile: (...args: unknown[]) => Promise<unknown>;
};

async function beforeNextFileHandleRead(
  probePath: string,
  action: () => Promise<void>,
): Promise<() => void> {
  const probe = await open(probePath, 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
  const original = prototype.readFile;
  await probe.close();
  let pending = true;
  prototype.readFile = async function interceptedReadFile(...args: unknown[]) {
    if (pending) {
      pending = false;
      prototype.readFile = original;
      await action();
    }
    return original.apply(this, args);
  };
  return () => {
    prototype.readFile = original;
  };
}

async function fixture(): Promise<{
  root: string;
  artifactRoot: string;
  sourceSha256: string;
  repository: FileCodexFeedbackStateRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-binding-'));
  roots.push(root);
  const sourceContent = '# Synthetic source\n';
  const sourcePath = join(root, '笔记同步助手', '2026-09-07', 'synthetic.md');
  await mkdir(join(sourcePath, '..'), { recursive: true });
  await writeFile(sourcePath, sourceContent, 'utf8');
  const artifactRoot = join(root, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  return {
    root,
    artifactRoot,
    sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
    repository: new FileCodexFeedbackStateRepository(
      join(root, '.atl-runtime', 'codex-feedback'),
    ),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('Codex feedback task binding', () => {
  it('rejects a missing Artifact root while allowing the planned file to be absent', async () => {
    const { root, repository, sourceSha256 } = await fixture();
    const artifactRoot = join(root, 'missing-artifact-root');

    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-missing-artifact-root-001',
      taskId: 'task-missing-artifact-root-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#missing-artifact-root',
      sourceSha256,
      artifactRoot,
      artifactPath: join(artifactRoot, 'task-missing-artifact-root-001', 'report.md'),
      experimentId: null,
    })).rejects.toMatchObject({ code: 'codex_feedback_binding_invalid' });
    expect(await repository.listBindings()).toEqual([]);
  });

  it('rejects a caller-supplied source hash that does not match the Vault note', async () => {
    const { root, artifactRoot, repository } = await fixture();
    const sourceRef = '笔记同步助手/2026-09-07/source-integrity.md#todo-1';
    const sourceContent = '# Trusted source\n\n- [ ] Synthetic task\n';
    const sourcePath = join(root, '笔记同步助手', '2026-09-07', 'source-integrity.md');
    await mkdir(join(sourcePath, '..'), { recursive: true });
    await writeFile(sourcePath, sourceContent, 'utf8');

    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-source-integrity-001',
      taskId: 'task-source-integrity-001',
      sourceRef,
      sourceSha256: createHash('sha256').update('forged source').digest('hex'),
      artifactRoot,
      artifactPath: join(artifactRoot, 'task-source-integrity-001', 'report.md'),
      experimentId: null,
    })).rejects.toMatchObject({ code: 'codex_feedback_binding_invalid' });
    expect(await repository.listBindings()).toEqual([]);
  });

  it('rejects a missing source note and a source path that escapes the Vault', async () => {
    const { artifactRoot, repository } = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-source-traversal-'));
    roots.push(outsideRoot);
    const outsideContent = '# Outside source\n';
    await writeFile(join(outsideRoot, 'outside-source.md'), outsideContent, 'utf8');

    for (const [suffix, sourceRef] of [
      ['missing', '笔记同步助手/2026-09-07/missing.md#todo-1'],
      ['traversal', `../${basename(outsideRoot)}/outside-source.md#todo-1`],
    ] as const) {
      await expect(bindCodexTask({ repository, clock: () => NOW }, {
        threadId: `thread-source-${suffix}-001`,
        taskId: `task-source-${suffix}-001`,
        sourceRef,
        sourceSha256: createHash('sha256').update(outsideContent).digest('hex'),
        artifactRoot,
        artifactPath: join(artifactRoot, `task-source-${suffix}-001`, 'report.md'),
        experimentId: null,
      })).rejects.toMatchObject({ code: 'codex_feedback_binding_invalid' });
    }
    expect(await repository.listBindings()).toEqual([]);
  });

  it('rejects source notes reached through a file or parent-directory symlink', async () => {
    const { root, artifactRoot, repository } = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-source-outside-'));
    roots.push(outsideRoot);
    const outsideContent = '# Symlinked source\n';
    const outsidePath = join(outsideRoot, 'outside.md');
    await writeFile(outsidePath, outsideContent, 'utf8');
    const sourceRoot = join(root, '笔记同步助手', '2026-09-07');
    await symlink(outsidePath, join(sourceRoot, 'linked-file.md'));
    await symlink(outsideRoot, join(root, 'linked-source-directory'));

    for (const [suffix, sourceRef] of [
      ['file-link', '笔记同步助手/2026-09-07/linked-file.md#todo-1'],
      ['directory-link', 'linked-source-directory/outside.md#todo-1'],
    ] as const) {
      await expect(bindCodexTask({ repository, clock: () => NOW }, {
        threadId: `thread-source-${suffix}-001`,
        taskId: `task-source-${suffix}-001`,
        sourceRef,
        sourceSha256: createHash('sha256').update(outsideContent).digest('hex'),
        artifactRoot,
        artifactPath: join(artifactRoot, `task-source-${suffix}-001`, 'report.md'),
        experimentId: null,
      })).rejects.toMatchObject({ code: 'codex_feedback_binding_invalid' });
    }
    expect(await repository.listBindings()).toEqual([]);
  });

  it('preserves Unicode source filenames and treats everything after the first hash as the anchor', async () => {
    const { root, artifactRoot, repository } = await fixture();
    const sourceRoot = join(root, '笔记同步助手', '2026-09-07');
    const circledContent = '# Circled filename source\n';
    const decoyContent = '# NFKC decoy source\n';
    const anchoredContent = '# Source with a Markdown-looking anchor\n';
    await writeFile(join(sourceRoot, 'note①.md'), circledContent, 'utf8');
    await writeFile(join(sourceRoot, 'note1.md'), decoyContent, 'utf8');
    await writeFile(join(sourceRoot, 'source.md'), anchoredContent, 'utf8');

    for (const [suffix, sourceRef, sourceContent] of [
      ['unicode', '笔记同步助手/2026-09-07/note①.md#todo-1', circledContent],
      ['anchor', '笔记同步助手/2026-09-07/source.md#review report.md', anchoredContent],
    ] as const) {
      await expect(bindCodexTask({ repository, clock: () => NOW }, {
        threadId: `thread-source-ref-${suffix}-001`,
        taskId: `task-source-ref-${suffix}-001`,
        sourceRef,
        sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
        artifactRoot,
        artifactPath: join(artifactRoot, `task-source-ref-${suffix}-001`, 'report.md'),
        experimentId: null,
      })).resolves.toMatchObject({ created: true });
    }
  });

  it('rejects a source path replaced after identity checks but before the open file is read', async () => {
    const { root, artifactRoot, repository } = await fixture();
    const sourceRoot = join(root, '笔记同步助手', '2026-09-07');
    const sourcePath = join(sourceRoot, 'source-read-race.md');
    const movedSourcePath = join(sourceRoot, 'source-read-race-original.md');
    const replacementPath = join(sourceRoot, 'source-read-race-replacement.md');
    const sourceContent = '# Original source during read\n';
    await writeFile(sourcePath, sourceContent, 'utf8');
    await writeFile(replacementPath, '# Replacement source during read\n', 'utf8');
    const restore = await beforeNextFileHandleRead(sourcePath, async () => {
      await rename(sourcePath, movedSourcePath);
      await rename(replacementPath, sourcePath);
    });

    try {
      await expect(bindCodexTask({ repository, clock: () => NOW }, {
        threadId: 'thread-source-read-race-001',
        taskId: 'task-source-read-race-001',
        sourceRef: '笔记同步助手/2026-09-07/source-read-race.md#todo-1',
        sourceSha256: createHash('sha256').update(sourceContent).digest('hex'),
        artifactRoot,
        artifactPath: join(artifactRoot, 'task-source-read-race-001', 'report.md'),
        experimentId: null,
      })).rejects.toMatchObject({ code: 'codex_feedback_binding_invalid' });
    } finally {
      restore();
    }
    expect(await repository.listBindings()).toEqual([]);
  });

  it('replays an exact binding and rejects a second identity for either thread or task', async () => {
    const { artifactRoot, repository, sourceSha256 } = await fixture();
    const input = {
      threadId: 'thread-synthetic-001',
      taskId: 'task-synthetic-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#todo-1',
      sourceSha256,
      artifactRoot,
      artifactPath: join(artifactRoot, 'task-synthetic-001', 'report.md'),
      experimentId: 'experiment-synthetic-001',
    };

    const first = await bindCodexTask({
      repository,
      clock: () => NOW,
    }, input);
    expect(first).toMatchObject({ created: true });
    expect(first.binding.bindingId).toMatch(/^cb_[0-9a-f]{24}$/u);

    const replay = await bindCodexTask({
      repository,
      clock: () => new Date('2026-09-07T02:01:00.000Z'),
    }, input);
    expect(replay).toEqual({ binding: first.binding, created: false });

    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      ...input,
      taskId: 'task-synthetic-002',
    })).rejects.toMatchObject({ code: 'codex_feedback_binding_conflict' });
    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      ...input,
      threadId: 'thread-synthetic-002',
    })).rejects.toMatchObject({ code: 'codex_feedback_binding_conflict' });

    expect(await repository.listBindings()).toEqual([first.binding]);
  });

  it('freezes the Artifact hash per version and rejects drift or a symlink replacement', async () => {
    const { root, artifactRoot, repository, sourceSha256 } = await fixture();
    const artifactPath = join(artifactRoot, 'task-synthetic-001', 'report.md');
    await mkdir(join(artifactRoot, 'task-synthetic-001'), { recursive: true });
    await writeFile(artifactPath, '# Version one\n', 'utf8');
    const { binding } = await bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-synthetic-001',
      taskId: 'task-synthetic-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#todo-1',
      sourceSha256,
      artifactRoot,
      artifactPath,
      experimentId: null,
    });

    const first = await snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    });
    expect(first).toMatchObject({ created: true });
    expect(first.snapshot.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    })).resolves.toEqual({ snapshot: first.snapshot, created: false });

    await writeFile(artifactPath, '# Version two\n', 'utf8');
    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    })).rejects.toMatchObject({ code: 'codex_feedback_artifact_version_conflict' });
    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 2,
    })).resolves.toMatchObject({ created: true });

    const outside = join(root, 'outside.md');
    await writeFile(outside, 'outside\n', 'utf8');
    await rm(artifactPath);
    await symlink(outside, artifactPath);
    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 3,
    })).rejects.toMatchObject({ code: 'codex_feedback_artifact_invalid' });
  });

  it('canonicalizes case-insensitive Artifact aliases before freezing the binding', async () => {
    const { root, artifactRoot, repository, sourceSha256 } = await fixture();
    const artifactPath = join(artifactRoot, 'task-case-alias-001', 'report.md');
    await mkdir(join(artifactPath, '..'), { recursive: true });
    await writeFile(artifactPath, '# Case-insensitive alias\n', 'utf8');
    const aliasRoot = join(root, 'ARTIFACTS');
    if (!existsSync(aliasRoot)) return;

    const { binding } = await bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-case-alias-001',
      taskId: 'task-case-alias-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#case-alias',
      sourceSha256,
      artifactRoot: aliasRoot,
      artifactPath: join(aliasRoot, 'task-case-alias-001', 'report.md'),
      experimentId: null,
    });

    expect(binding.artifactRoot).toBe(realpathSync.native(artifactRoot));
    expect(binding.artifactPath).toBe(realpathSync.native(artifactPath));
    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    })).resolves.toMatchObject({ created: true });
  });

  it('rejects an Artifact root replaced by a symlink after binding', async () => {
    const { root, artifactRoot, repository, sourceSha256 } = await fixture();
    const artifactPath = join(artifactRoot, 'task-root-swap-001', 'report.md');
    await mkdir(join(artifactPath, '..'), { recursive: true });
    await writeFile(artifactPath, '# Original Artifact\n', 'utf8');
    const { binding } = await bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-root-swap-001',
      taskId: 'task-root-swap-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#root-swap',
      sourceSha256,
      artifactRoot,
      artifactPath,
      experimentId: null,
    });

    const originalRoot = join(root, 'artifacts-original');
    const outsideRoot = join(root, 'outside-artifacts');
    await rename(artifactRoot, originalRoot);
    await mkdir(join(outsideRoot, 'task-root-swap-001'), { recursive: true });
    await writeFile(
      join(outsideRoot, 'task-root-swap-001', 'report.md'),
      '# Outside Artifact\n',
      'utf8',
    );
    await symlink(outsideRoot, artifactRoot);

    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    })).rejects.toMatchObject({ code: 'codex_feedback_artifact_invalid' });
  });

  it('rejects an Artifact path redirected through an in-root directory symlink after binding', async () => {
    const { artifactRoot, repository, sourceSha256 } = await fixture();
    const taskDirectory = join(artifactRoot, 'task-directory-swap-001');
    const artifactPath = join(taskDirectory, 'report.md');
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(artifactPath, '# Original Artifact\n', 'utf8');
    const { binding } = await bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-directory-swap-001',
      taskId: 'task-directory-swap-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#directory-swap',
      sourceSha256,
      artifactRoot,
      artifactPath,
      experimentId: null,
    });

    const originalDirectory = join(artifactRoot, 'task-directory-swap-original');
    const redirectedDirectory = join(artifactRoot, 'task-directory-swap-redirected');
    await rename(taskDirectory, originalDirectory);
    await mkdir(redirectedDirectory, { recursive: true });
    await writeFile(join(redirectedDirectory, 'report.md'), '# Redirected Artifact\n', 'utf8');
    await symlink(redirectedDirectory, taskDirectory);

    await expect(snapshotCodexArtifact({ repository, clock: () => NOW }, {
      bindingId: binding.bindingId,
      artifactVersion: 1,
    })).rejects.toMatchObject({ code: 'codex_feedback_artifact_invalid' });
  });

  it('rejects an in-place Artifact rewrite between the open-file checks and content read', async () => {
    const { artifactRoot, repository, sourceSha256 } = await fixture();
    const artifactPath = join(artifactRoot, 'task-in-place-rewrite-001', 'report.md');
    const originalContent = 'A'.repeat(4_096);
    const replacementContent = 'B'.repeat(4_096);
    await mkdir(join(artifactPath, '..'), { recursive: true });
    await writeFile(artifactPath, originalContent, 'utf8');
    const { binding } = await bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-in-place-rewrite-001',
      taskId: 'task-in-place-rewrite-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#in-place-rewrite',
      sourceSha256,
      artifactRoot,
      artifactPath,
      experimentId: null,
    });
    const identityBefore = await stat(artifactPath);
    const restore = await beforeNextFileHandleRead(artifactPath, async () => {
      await writeFile(artifactPath, replacementContent, 'utf8');
      await utimes(artifactPath, new Date('2030-01-01T00:00:00.000Z'), new Date('2030-01-01T00:00:00.000Z'));
    });

    try {
      await expect(readBoundCodexArtifact(binding)).rejects.toMatchObject({
        code: 'codex_feedback_artifact_invalid',
      });
    } finally {
      restore();
    }
    const identityAfter = await stat(artifactPath);
    expect(identityAfter.ino).toBe(identityBefore.ino);
    expect(identityAfter.size).toBe(identityBefore.size);
  });

  it('rejects the wrong Vault authorization before creating runtime state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-unauthorized-'));
    const otherRoot = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-other-'));
    roots.push(root, otherRoot);
    const runtimeRoot = join(root, '.atl-runtime', 'codex-feedback');
    const repository = new FileCodexFeedbackStateRepository(runtimeRoot, {
      vaultRoot: root,
      writeAuthorization: createVaultWriteAuthorization(otherRoot),
    });
    const artifactRoot = join(root, 'artifacts');
    await mkdir(artifactRoot, { recursive: true });

    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-unauthorized-001',
      taskId: 'task-unauthorized-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#unauthorized',
      sourceSha256: 'b'.repeat(64),
      artifactRoot,
      artifactPath: join(artifactRoot, 'task-unauthorized-001', 'report.md'),
      experimentId: null,
    })).rejects.toThrow('Vault writes are disabled');
    await expect(access(runtimeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a runtime root outside the authorized Vault without writing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-runtime-boundary-'));
    const outside = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-runtime-outside-'));
    roots.push(root, outside);
    const runtimeRoot = join(outside, '.atl-runtime', 'codex-feedback');

    expect(() => new FileCodexFeedbackStateRepository(runtimeRoot, {
      vaultRoot: root,
      writeAuthorization: createVaultWriteAuthorization(root),
    })).toThrow('Codex feedback state is missing or invalid');
    await expect(access(runtimeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked runtime directory without writing outside the Vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-runtime-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'atl-codex-feedback-runtime-target-'));
    roots.push(root, outside);
    await symlink(outside, join(root, '.atl-runtime'));
    const runtimeRoot = join(root, '.atl-runtime', 'codex-feedback');
    const repository = new FileCodexFeedbackStateRepository(runtimeRoot, {
      vaultRoot: root,
      writeAuthorization: createVaultWriteAuthorization(root),
    });
    const artifactRoot = join(root, 'artifacts');
    await mkdir(artifactRoot, { recursive: true });

    await expect(bindCodexTask({ repository, clock: () => NOW }, {
      threadId: 'thread-runtime-symlink-001',
      taskId: 'task-runtime-symlink-001',
      sourceRef: '笔记同步助手/2026-09-07/synthetic.md#runtime-symlink',
      sourceSha256: 'c'.repeat(64),
      artifactRoot,
      artifactPath: join(artifactRoot, 'task-runtime-symlink-001', 'report.md'),
      experimentId: null,
    })).rejects.toMatchObject({ code: 'invalid_storage_entry' });
    await expect(access(join(outside, 'codex-feedback'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
