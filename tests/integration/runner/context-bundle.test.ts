import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import {
  buildContextBundle,
  type ContextBlock,
} from '../../../src/runner/context-bundle.js';

const NOW = '2026-07-15T00:00:00.000Z';
const roots: string[] = [];
const execFileAsync = promisify(execFile);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-context-001',
    title: 'TITLE_SENTINEL_MUST_NOT_ENTER_CONTEXT',
    body: 'BODY_SENTINEL_MUST_NOT_ENTER_CONTEXT',
    status: 'in_progress',
    reviewState: 'confirmed',
    projectId: 'project-context',
    taskType: 'research',
    objective: 'Compare the documented product limits.',
    acceptanceCriteria: ['Cite the official limit.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    origin: 'synthetic_test',
    sourceDate: '2026-07-15',
    sourceNote: null,
    sourceQuote: 'SOURCE_QUOTE_SENTINEL_MUST_NOT_ENTER_CONTEXT',
    sourceKey: 'synthetic:context-001',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 1,
    claim: {
      runId: 'run-context-001',
      agent: 'synthetic-agent',
      claimedAt: NOW,
      leaseExpiresAt: '2026-07-15T01:00:00.000Z',
    },
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    projectId: 'project-context',
    name: 'PROJECT_NAME_SENTINEL_MUST_NOT_ENTER_CONTEXT',
    description: 'Research public product documentation.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-context-'));
  roots.push(root);
  return root;
}

function expectedDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectValidDigest(block: ContextBlock): void {
  expect(block.sha256).toBe(expectedDigest(block.content));
}

afterEach(async () => {
  delete process.env.ATL_CONTEXT_SENTINEL;
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('buildContextBundle', () => {
  it('builds deterministic, digested blocks from only explicitly allowed context', async () => {
    const root = await temporaryRoot();
    const taskNote = join(root, 'task-note.md');
    const projectNote = join(root, 'project-note.md');
    await writeFile(
      taskNote,
      'Task evidence with sk-synthetic1234567890 in the source.\n',
    );
    await writeFile(
      projectNote,
      'Project evidence with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.\n',
    );
    process.env.ATL_CONTEXT_SENTINEL = 'ENV_SENTINEL_MUST_NOT_ENTER_CONTEXT';

    const task = makeTask({
      objective: 'Compare limits using sk-objective1234567890.',
      sourceNote: taskNote,
    });
    const project = makeProject({
      description: 'Research docs with ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.',
      resources: [
        { kind: 'local_path', value: projectNote, label: 'Local notes' },
        {
          kind: 'url',
          value: 'https://example.com/docs?token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
          label: 'Official docs',
        },
        {
          kind: 'github_repo',
          value: 'PANGKAIFENG/synthetic-repo',
          label: 'Repository',
        },
      ],
    });

    const first = await buildContextBundle(task, project, {
      allowedLocalRoots: [root],
    });
    const second = await buildContextBundle(task, project, {
      allowedLocalRoots: [root],
    });

    expect(first).toEqual(second);
    expect(first.taskId).toBe(task.taskId);
    expect(first.blocks.map(({ label, kind }) => ({ label, kind }))).toEqual([
      { label: 'task', kind: 'task' },
      { label: 'task_source_note', kind: 'local_file' },
      { label: 'project', kind: 'project' },
      { label: 'project_resource_001', kind: 'local_file' },
      { label: 'project_resource_002', kind: 'url_reference' },
      { label: 'project_resource_003', kind: 'url_reference' },
    ]);
    first.blocks.forEach(expectValidDigest);

    const serialized = JSON.stringify(first);
    expect(serialized).toContain('Compare limits');
    expect(serialized).toContain('Cite the official limit.');
    expect(serialized).toContain('Task evidence');
    expect(serialized).toContain('Project evidence');
    expect(serialized).toContain('Official docs');
    expect(serialized).toContain('PANGKAIFENG/synthetic-repo');
    expect(serialized).not.toContain('TITLE_SENTINEL_MUST_NOT_ENTER_CONTEXT');
    expect(serialized).not.toContain('BODY_SENTINEL_MUST_NOT_ENTER_CONTEXT');
    expect(serialized).not.toContain('SOURCE_QUOTE_SENTINEL_MUST_NOT_ENTER_CONTEXT');
    expect(serialized).not.toContain('PROJECT_NAME_SENTINEL_MUST_NOT_ENTER_CONTEXT');
    expect(serialized).not.toContain('ENV_SENTINEL_MUST_NOT_ENTER_CONTEXT');
    expect(serialized).not.toContain('sk-synthetic1234567890');
    expect(serialized).not.toContain('sk-objective1234567890');
    expect(serialized).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(serialized).toContain('[REDACTED]');
  });

  it('accepts an explicitly referenced regular file at the 256 KiB limit', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'maximum.md');
    await writeFile(source, Buffer.alloc(256 * 1024, 'a'));

    const bundle = await buildContextBundle(
      makeTask({ sourceNote: source }),
      makeProject(),
      { allowedLocalRoots: [root] },
    );

    expect(bundle.blocks.find((block) => block.label === 'task_source_note'))
      .toMatchObject({ kind: 'local_file' });
  });

  it('rejects a FIFO with a typed error without blocking on open or read', async () => {
    const root = await temporaryRoot();
    const fifo = join(root, 'blocking-source');
    await execFileAsync('mkfifo', [fifo]);
    const moduleUrl = pathToFileURL(join(
      process.cwd(),
      'src',
      'runner',
      'context-bundle.ts',
    )).href;
    const script = `
      import { buildContextBundle } from ${JSON.stringify(moduleUrl)};
      const task = ${JSON.stringify(makeTask({ sourceNote: fifo }))};
      const project = ${JSON.stringify(makeProject())};
      try {
        await buildContextBundle(task, project, {
          allowedLocalRoots: [${JSON.stringify(root)}],
        });
        console.log(JSON.stringify({ code: 'unexpected_success' }));
      } catch (error) {
        console.log(JSON.stringify({
          name: error?.name,
          code: error?.code,
          message: error?.message,
        }));
      }
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { timeout: 500, killSignal: 'SIGKILL' },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      name: 'ContextBundleError',
      code: 'invalid_local_file',
    });
    expect(stdout).not.toContain(fifo);
  });

  it.each([
    ['missing task project', null, 'project-context'],
    ['blank task and project', '', ''],
    ['different projects', 'project-context', 'project-other'],
  ] as const)(
    'rejects %s before including project context',
    async (_label, taskProjectId, projectId) => {
      await expect(buildContextBundle(
        makeTask({ projectId: taskProjectId }),
        makeProject({
          projectId,
          description: 'CROSS_PROJECT_DESCRIPTION_SENTINEL',
          resources: [{
            kind: 'url',
            value: 'https://example.com/CROSS_PROJECT_RESOURCE_SENTINEL',
            label: 'Cross-project resource',
          }],
        }),
        { allowedLocalRoots: [] },
      )).rejects.toMatchObject({
        name: 'ContextBundleError',
        code: 'project_context_mismatch',
      });
    },
  );

  it('redacts common provider tokens from every context surface before digesting', async () => {
    const root = await temporaryRoot();
    const localSource = join(root, 'provider-tokens.md');
    const tokens = {
      aws: 'AKIAABCDEFGHIJKLMNOP',
      gitlab: 'glpat-abcdefghijklmnopqrst',
      npm: 'npm_abcdefghijklmnopqrstuvwx',
      stripe: 'whsec_abcdefghijklmnopqrstuvwx',
    };
    await writeFile(localSource, `Local token: ${tokens.npm}\n`);

    const bundle = await buildContextBundle(
      makeTask({ objective: `Task token: ${tokens.aws}` }),
      makeProject({
        description: `Project token: ${tokens.gitlab}`,
        resources: [
          { kind: 'local_path', value: localSource, label: 'Local token file' },
          {
            kind: 'url',
            value: `https://example.com/docs?signature=${tokens.stripe}`,
            label: 'Signed docs',
          },
        ],
      }),
      { allowedLocalRoots: [root] },
    );

    const serialized = JSON.stringify(bundle);
    for (const token of Object.values(tokens)) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(4);
    bundle.blocks.forEach(expectValidDigest);
  });

  it.each([
    ['task source note', 'task'],
    ['project local_path resource', 'project'],
  ] as const)('rejects a %s outside explicitly allowed roots', async (_label, owner) => {
    const allowedRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const outsideFile = join(outsideRoot, 'outside.md');
    await writeFile(outsideFile, 'OUTSIDE_SENTINEL');

    const task = makeTask(owner === 'task' ? { sourceNote: outsideFile } : {});
    const project = makeProject(owner === 'project' ? {
      resources: [{ kind: 'local_path', value: outsideFile, label: 'Outside' }],
    } : {});

    await expect(buildContextBundle(task, project, {
      allowedLocalRoots: [allowedRoot],
    })).rejects.toThrow();
  });

  it('does not infer the home, workspace, or temporary directory as an allowed root', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'source.md');
    await writeFile(source, 'Explicit allowlist required.');

    await expect(buildContextBundle(
      makeTask({ sourceNote: source }),
      makeProject(),
      { allowedLocalRoots: [] },
    )).rejects.toThrow();
  });

  it.each(['task', 'project'] as const)(
    'rejects a directory referenced by the %s',
    async (owner) => {
      const root = await temporaryRoot();
      const directory = join(root, 'directory');
      await mkdir(directory);
      const task = makeTask(owner === 'task' ? { sourceNote: directory } : {});
      const project = makeProject(owner === 'project' ? {
        resources: [{ kind: 'local_path', value: directory, label: 'Directory' }],
      } : {});

      await expect(buildContextBundle(task, project, {
        allowedLocalRoots: [root],
      })).rejects.toThrow();
    },
  );

  it('rejects a missing explicitly referenced local file', async () => {
    const root = await temporaryRoot();

    await expect(buildContextBundle(
      makeTask(),
      makeProject({
        resources: [{
          kind: 'local_path',
          value: join(root, 'missing.md'),
          label: 'Missing',
        }],
      }),
      { allowedLocalRoots: [root] },
    )).rejects.toThrow();
  });

  it('rejects a symlink that escapes an allowed root', async () => {
    const allowedRoot = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const outsideFile = join(outsideRoot, 'outside.md');
    const escapingLink = join(allowedRoot, 'escaping.md');
    await writeFile(outsideFile, 'ESCAPING_SYMLINK_SENTINEL');
    await symlink(outsideFile, escapingLink);

    await expect(buildContextBundle(
      makeTask({ sourceNote: escapingLink }),
      makeProject(),
      { allowedLocalRoots: [allowedRoot] },
    )).rejects.toThrow();
  });

  it('rejects a source file larger than 256 KiB', async () => {
    const root = await temporaryRoot();
    const oversized = join(root, 'oversized.md');
    await writeFile(oversized, Buffer.alloc((256 * 1024) + 1, 'a'));

    await expect(buildContextBundle(
      makeTask({ sourceNote: oversized }),
      makeProject(),
      { allowedLocalRoots: [root] },
    )).rejects.toThrow();
  });
});
