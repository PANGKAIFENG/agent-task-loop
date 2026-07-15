import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';

const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const temporaryRoots: string[] = [];

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function makeVault(prefix = 'atl-cli-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function runCli(
  root: string | undefined,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const result = await execa('pnpm', ['exec', 'tsx', cli, ...args], {
    cwd: repositoryRoot,
    env: {
      ATL_VAULT_ROOT: root,
      ATL_ALLOW_REAL_WRITES: undefined,
      ...extraEnv,
    },
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

async function runReadmeShell(root: string, script: string): Promise<CliResult> {
  const result = await execa('bash', ['-c', script], {
    cwd: repositoryRoot,
    env: {
      ATL_VAULT_ROOT: root,
      ATL_ALLOW_REAL_WRITES: undefined,
    },
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function json<T>(result: CliResult): T {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  return JSON.parse(result.stdout) as T;
}

async function createProject(root: string): Promise<void> {
  const result = await runCli(root, [
    'project',
    'create',
    '--project-id',
    'public-research',
    '--name',
    'Public research',
    '--description',
    'Research only public sources.',
    '--json',
  ]);
  expect(json<{ projectId: string }>(result).projectId).toBe('public-research');
}

async function captureTask(root: string, sourceKey = 'manual:cli:001'): Promise<Task> {
  const result = await runCli(root, [
    'task',
    'capture',
    '--title',
    'Review public pricing',
    '--body',
    'Compare the public pricing page.',
    '--origin',
    'manual_cli',
    '--source-date',
    '2026-07-15',
    '--source-key',
    sourceKey,
    '--priority',
    'high',
    '--json',
  ]);
  return json<Task>(result);
}

async function confirmTask(root: string, taskId: string): Promise<void> {
  const result = await runCli(root, [
    'task',
    'confirm',
    '--task-id',
    taskId,
    '--project-id',
    'public-research',
    '--objective',
    'Compare public pricing using official evidence.',
    '--acceptance-criterion',
    'Cite an official HTTPS page.',
    '--priority',
    'high',
    '--auto-executable',
    '--json',
  ]);
  expect(json<Task>(result).status).toBe('ready');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atl CLI core loop', () => {
  it('exposes scheduler commands and keeps scheduler status read-only', async () => {
    const root = await makeVault();
    const home = await makeVault('atl-cli-home-');
    const help = await runCli(root, ['scheduler', '--help'], { HOME: home });
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain('install');
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('uninstall');

    const status = await runCli(root, ['scheduler', 'status', '--json'], {
      HOME: home,
    });
    expect(json(status)).toMatchObject({
      installed: false,
      managed: false,
      label: null,
      path: join(
        await realpath(home),
        'Library',
        'LaunchAgents',
        'ai.agent-task-loop.runner.plist',
      ),
    });
    await expect(stat(join(home, 'Library')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes bounded runner commands and keeps status read-only', async () => {
    const root = await makeVault();
    const help = await runCli(root, ['runner', '--help']);
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain('run-once');
    expect(help.stdout).toContain('run-task');
    expect(help.stdout).toContain('status');

    for (const args of [
      ['runner', 'run-once', '--driver', 'synthetic', '--json'],
      [
        'runner', 'run-task', '--task-id', 'task-synthetic',
        '--driver', 'synthetic', '--json',
      ],
    ]) {
      const unsupported = await runCli(root, args);
      expect(unsupported.exitCode).toBe(1);
      expect(JSON.parse(unsupported.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_cli_input',
          message: '--driver must be claude',
        },
      });
    }

    const before = await readdir(root);
    const status = json<{
      latestRun: null;
      automaticClaimsToday: number;
      dailyLimit: number;
      blockedTasks: Task[];
      nextEligibleTask: Task | null;
    }>(await runCli(root, ['runner', 'status', '--json']));
    expect(status).toEqual({
      latestRun: null,
      automaticClaimsToday: 0,
      dailyLimit: 3,
      blockedTasks: [],
      nextEligibleTask: null,
    });
    expect(await readdir(root)).toEqual(before);
  });

  it('keeps the README task capture pipeline machine-readable', async () => {
    const root = await makeVault();
    const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8');
    expect(readme).toContain('TASK_ID="$(pnpm --silent atl task capture');

    const result = await runReadmeShell(root, `
      TASK_ID="$(pnpm --silent atl task capture \\
        --title "Review public pricing" \\
        --body "Compare the public pricing page." \\
        --origin manual_cli \\
        --source-date 2026-07-15 \\
        --source-key manual:readme:pipeline \\
        --priority high \\
        --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).taskId")"
      printf '%s\\n' "$TASK_ID"
      pnpm --silent atl task list --status inbox --json
    `);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^task-\d{8}-[a-z0-9]{8}$/);
    const inbox = JSON.parse(lines[1] ?? '') as Task[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.taskId).toBe(lines[0]);
  });

  it.each([
    ['unknown option', ['task', 'list', '--unknown', '--json']],
    ['missing option argument', ['task', 'list', '--status', '--json']],
  ])('normalizes the %s parser error in JSON mode', async (_label, args) => {
    const root = await makeVault();
    const result = await runCli(root, args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'invalid_cli_input' },
    });
  });

  it('prints a concise parser error in human mode', async () => {
    const root = await makeVault();
    const result = await runCli(root, ['task', 'list', '--unknown']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe("Error: unknown option '--unknown'");
  });

  it('runs capture, confirmation, supervised claim, submission and approval to Archive', async () => {
    const root = await makeVault();
    await createProject(root);
    const captured = await captureTask(root);

    const inbox = json<Task[]>(await runCli(root, [
      'task', 'list', '--status', 'inbox', '--json',
    ]));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.taskId).toBe(captured.taskId);

    await confirmTask(root, captured.taskId);
    const next = json<Task | null>(await runCli(root, ['task', 'next', '--json']));
    expect(next).toMatchObject({ taskId: captured.taskId, status: 'ready' });

    const readOnlyTaskPath = join(
      root,
      '10_Tasks',
      'Active',
      'public-research',
      `${captured.taskId}.md`,
    );
    const beforeNext = await readFile(readOnlyTaskPath, 'utf8');
    await runCli(root, ['task', 'next', '--json']);
    expect(await readFile(readOnlyTaskPath, 'utf8')).toBe(beforeNext);

    const claimed = json<Task>(await runCli(root, [
      'task',
      'next',
      '--claim',
      '--task-id',
      captured.taskId,
      '--agent',
      'human-supervised',
      '--run-id',
      'run-cli-001',
      '--json',
    ]));
    expect(claimed).toMatchObject({
      status: 'in_progress',
      claim: { runId: 'run-cli-001', agent: 'human-supervised' },
    });

    const resultPath = join(root, 'result.json');
    await writeFile(resultPath, `${JSON.stringify({
      summary: 'Pricing was reviewed.',
      findings: ['A public plan exists.'],
      evidence: [{
        title: 'Official pricing',
        url: 'https://example.com/pricing',
        accessedAt: '2026-07-15T09:00:00.000Z',
      }],
      uncertainties: [],
      recommendedActions: ['Review again next quarter.'],
      acceptance: [{
        criterion: 'Cite an official HTTPS page.',
        status: 'met',
        note: 'The official pricing page was cited.',
      }],
    }, null, 2)}\n`);

    const submitted = json<Task>(await runCli(root, [
      'task',
      'submit',
      '--task-id',
      captured.taskId,
      '--run-id',
      'run-cli-001',
      '--result',
      resultPath,
      '--json',
    ]));
    expect(submitted.status).toBe('review');
    expect(submitted.artifactRefs).toEqual([
      `Artifacts/${captured.taskId}/attempt-001.md`,
    ]);

    const approved = json<Task>(await runCli(root, [
      'task', 'review', '--task-id', captured.taskId, '--approve', '--json',
    ]));
    expect(approved.status).toBe('done');
    expect((await stat(join(
      root,
      '10_Tasks',
      'Archive',
      approved.updatedAt.slice(0, 4),
      `${captured.taskId}.md`,
    ))).isFile()).toBe(true);
    expect((await stat(join(
      root,
      '10_Tasks',
      'Artifacts',
      captured.taskId,
      'attempt-001.md',
    ))).isFile()).toBe(true);
  }, 30_000);

  it('requires an explicit task for a supervised claim and keeps errors stack-free', async () => {
    const root = await makeVault();
    const result = await runCli(root, [
      'task', 'next', '--claim', '--run-id', 'run-cli-002', '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: '--task-id is required with --claim' },
    });
    expect(result.stderr).not.toContain('\n    at ');
  });

  it('rejects review commands with zero or multiple decisions', async () => {
    const root = await makeVault();
    for (const decisions of [[], ['--approve', '--block']]) {
      const result = await runCli(root, [
        'task',
        'review',
        '--task-id',
        'task-synthetic',
        ...decisions,
        '--feedback',
        'Synthetic feedback.',
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('exactly one review decision is required');
      expect(result.stderr).not.toContain('\n    at ');
    }

    const approveWithFeedback = await runCli(root, [
      'task',
      'review',
      '--task-id',
      'task-synthetic',
      '--approve',
      '--feedback',
      'Must not be discarded.',
    ]);
    expect(approveWithFeedback.exitCode).toBe(1);
    expect(approveWithFeedback.stderr).toContain(
      '--feedback is not allowed with --approve',
    );
  });

  it('requires ATL_VAULT_ROOT and the explicit write flag outside the temp root', async () => {
    const missingRoot = await runCli(undefined, ['task', 'list', '--json']);
    expect(missingRoot.exitCode).toBe(1);
    expect(JSON.parse(missingRoot.stdout)).toMatchObject({
      ok: false,
      error: { message: 'ATL_VAULT_ROOT is required' },
    });
    expect(missingRoot.stderr).not.toContain('\n    at ');

    const nonTempRoot = await mkdtemp(join(repositoryRoot, '.atl-cli-safety-'));
    temporaryRoots.push(nonTempRoot);
    const denied = await runCli(nonTempRoot, [
      'project',
      'create',
      '--project-id',
      'denied',
      '--name',
      'Denied',
      '--description',
      'Must not write.',
    ]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain('ATL_ALLOW_REAL_WRITES=1');
    await expect(stat(join(nonTempRoot, '10_Tasks'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('supports trusted stop, unblock and reopen adapters', async () => {
    const root = await makeVault();
    await createProject(root);
    const first = await captureTask(root, 'manual:cli:stop');
    await confirmTask(root, first.taskId);
    await runCli(root, [
      'task', 'next', '--claim', '--task-id', first.taskId,
      '--run-id', 'run-stop', '--json',
    ]);
    const stopped = json<Task>(await runCli(root, [
      'task', 'stop', '--task-id', first.taskId, '--json',
    ]));
    expect(stopped.status).toBe('ready');

    await runCli(root, [
      'task', 'next', '--claim', '--task-id', first.taskId,
      '--run-id', 'run-stop-done', '--json',
    ]);
    const doneResultPath = join(root, 'done-result.json');
    await writeFile(doneResultPath, JSON.stringify({
      summary: 'Completed review fixture.',
      findings: [],
      evidence: [],
      uncertainties: [],
      recommendedActions: [],
      acceptance: [],
    }));
    await runCli(root, [
      'task', 'submit', '--task-id', first.taskId, '--run-id', 'run-stop-done',
      '--result', doneResultPath, '--json',
    ]);
    const approved = json<Task>(await runCli(root, [
      'task', 'review', '--task-id', first.taskId, '--approve', '--json',
    ]));
    expect(approved.status).toBe('done');

    const second = await captureTask(root, 'manual:cli:block');
    await confirmTask(root, second.taskId);
    await runCli(root, [
      'task', 'next', '--claim', '--task-id', second.taskId,
      '--run-id', 'run-block', '--json',
    ]);
    const resultPath = join(root, 'blocked-result.json');
    await writeFile(resultPath, JSON.stringify({
      summary: 'Blocked review fixture.',
      findings: [],
      evidence: [],
      uncertainties: ['Needs human input.'],
      recommendedActions: [],
      acceptance: [],
    }));
    await runCli(root, [
      'task', 'submit', '--task-id', second.taskId, '--run-id', 'run-block',
      '--result', resultPath, '--json',
    ]);
    const blocked = json<Task>(await runCli(root, [
      'task', 'review', '--task-id', second.taskId, '--block',
      '--feedback', 'Waiting for scope.', '--json',
    ]));
    expect(blocked.status).toBe('blocked');
    const unblocked = json<Task>(await runCli(root, [
      'task', 'unblock', '--task-id', second.taskId,
      '--feedback', 'Scope supplied.', '--json',
    ]));
    expect(unblocked.status).toBe('ready');

    const reopened = json<Task>(await runCli(root, [
      'task', 'reopen', '--task-id', first.taskId,
      '--feedback', 'This is not done yet.', '--json',
    ]));
    expect(reopened.status).toBe('ready');
  }, 30_000);
});

describe('atl doctor', () => {
  it('accepts legacy slug filenames, plain index links, and lifecycle notes', async () => {
    const root = await makeVault('atl-doctor-legacy-');
    const tasksRoot = join(root, '10_Tasks');
    const taskPath = join(
      tasksRoot,
      'Inbox',
      '2026-07-15',
      'task-20260715-readable-title-deadbeef.md',
    );
    await mkdir(dirname(taskPath), { recursive: true });
    await Promise.all([
      writeFile(taskPath, `---\n${[
        'type: task',
        'schema_version: 1',
        'task_id: task-20260715-deadbeef',
        'title: Legacy generated task',
        'status: inbox',
        'review_state: candidate',
        'task_type: research',
        'objective: Synthetic objective.',
        'acceptance_criteria: [Synthetic criterion.]',
        'auto_executable: false',
        'origin: synthetic_legacy',
        'source_date: 2026-07-15',
        'source_key: synthetic:legacy',
        'priority: normal',
        'attempts: 0',
        'artifact_refs: []',
        'created_at: 2026-07-15T00:00:00.000Z',
        'updated_at: 2026-07-15T00:00:00.000Z',
      ].join('\n')}\n---\n\nSynthetic body.\n`),
      ...['Inbox', 'Active', 'Archive'].map(async (directory) => {
        const path = join(tasksRoot, directory, '目录说明.md');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `# ${directory}\n`, 'utf8');
      }),
      writeFile(join(tasksRoot, '任务索引.md'), [
        '# 任务索引',
        '',
        `| Legacy generated task | [task](${taskPath}) |`,
        '',
      ].join('\n')),
    ]);

    const listResult = await runCli(root, ['task', 'list', '--json']);
    expect(json<Task[]>(listResult).map(({ taskId }) => taskId))
      .toEqual(['task-20260715-deadbeef']);
    expect(json<{ ok: boolean; issues: unknown[] }>(
      await runCli(root, ['doctor', '--json']),
    )).toEqual({ ok: true, issues: [] });
  });

  it('reports all read-only storage issues with expected lifecycle repair paths', async () => {
    const root = await makeVault('atl-doctor-');
    const tasksRoot = join(root, '10_Tasks');
    const misplaced = join(tasksRoot, 'Inbox', '2026-07-15', 'task-duplicate-a.md');
    const duplicate = join(tasksRoot, 'Active', 'project-a', 'task-duplicate-b.md');
    const malformed = join(tasksRoot, 'Active', 'project-a', 'task-malformed.md');
    const staleTarget = join(tasksRoot, 'Active', 'project-a', 'task-gone.md');
    const validFrontmatter = (title: string) => `---\n${[
      'type: task',
      'schema_version: 1',
      'task_id: task-duplicate',
      `title: ${title}`,
      'status: ready',
      'review_state: confirmed',
      'project_id: project-a',
      'task_type: research',
      'objective: Synthetic objective.',
      'acceptance_criteria: [Synthetic criterion.]',
      'auto_executable: true',
      'permission_profile: read_only_research',
      'origin: synthetic_doctor',
      'source_date: 2026-07-15',
      'source_key: synthetic:doctor',
      'priority: normal',
      'attempts: 0',
      'artifact_refs: []',
      'created_at: 2026-07-15T00:00:00.000Z',
      'updated_at: 2026-07-15T00:00:00.000Z',
    ].join('\n')}\n---\n\nSynthetic body.\n`;
    await mkdir(dirname(misplaced), { recursive: true });
    await mkdir(dirname(duplicate), { recursive: true });
    await writeFile(misplaced, validFrontmatter('First'));
    await writeFile(duplicate, validFrontmatter('Second'));
    await writeFile(malformed, '---\nstatus: [unterminated\n---\n');
    await writeFile(join(tasksRoot, '任务索引.md'), [
      '# 任务索引',
      '',
      `| stale | [task-gone.md](<${staleTarget}>) |`,
      '',
    ].join('\n'));
    const snapshots = await Promise.all([
      misplaced,
      duplicate,
      malformed,
      join(tasksRoot, '任务索引.md'),
    ].map((path) => readFile(path, 'utf8')));

    const result = await runCli(root, ['doctor', '--json']);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      issues: Array<{ code: string; path: string; expectedPath?: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'duplicate_task_id',
      'invalid_frontmatter',
      'path_status_mismatch',
      'task_index_missing_link',
      'task_index_stale_link',
    ]));
    expect(report.issues.find(({ code, path }) => (
      code === 'path_status_mismatch' && path === misplaced
    )))
      .toMatchObject({
        path: misplaced,
        expectedPath: join(
          tasksRoot,
          'Active',
          'project-a',
          'task-duplicate.md',
        ),
      });
    expect(await Promise.all([
      misplaced,
      duplicate,
      malformed,
      join(tasksRoot, '任务索引.md'),
    ].map((path) => readFile(path, 'utf8')))).toEqual(snapshots);

    const humanResult = await runCli(root, ['doctor']);
    expect(humanResult.exitCode).toBe(1);
    expect(humanResult.stdout).toContain(join(
      tasksRoot,
      'Active',
      'project-a',
      'task-duplicate.md',
    ));
  });

  it('returns a healthy JSON report for an empty vault without creating files', async () => {
    const root = await makeVault('atl-doctor-empty-');
    const result = await runCli(root, ['doctor', '--json']);

    expect(json<{ ok: boolean; issues: unknown[] }>(result)).toEqual({
      ok: true,
      issues: [],
    });
    await expect(stat(join(root, '10_Tasks'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
