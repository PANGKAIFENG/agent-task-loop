import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Thin CLI wrapper for the six decision command groups (TEP27-G4 Task 7).
 * Business behavior is covered by the T2-T6 repository/service suites; this
 * file only asserts argument-to-service mapping, the JSON envelope, exit
 * codes, error-code passthrough, and the M5 help text.
 */
const repositoryRoot = process.cwd();
const cli = join(repositoryRoot, 'src', 'cli.ts');
const fixtureDir = join(repositoryRoot, 'tests', 'fixtures', 'vault', 'decision-legacy');
const temporaryRoots: string[] = [];

const POLICY_ID = 'policy.input-routing.synthetic';
const POLICY_REF = `${POLICY_ID}@v001`;
const TRACE_ID = 'dt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const IDEMPOTENCY_KEY = 'cli-feedback-key-0001';
const MULTI_PROCESS_CLI_TEST_TIMEOUT_MS = 20_000;

const NO_IDEMPOTENCY_KEY_NOTICE
  = '不传 `--idempotency-key` 时，每次提交都会创建一条新的反馈样本'
    + '（视为一次新的反馈事件）；需要去重/幂等语义时必须显式传 key。';

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DecisionErrorBody {
  error: {
    code: string;
    message: string;
  };
}

async function makeVault(prefix = 'atl-decision-cli-'): Promise<string> {
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

function json<T>(result: CliResult): T {
  expect(result.exitCode, result.stderr).toBe(0);
  return parseJson<T>(result);
}

function parseJson<T>(result: CliResult): T {
  expect(() => JSON.parse(result.stdout), result.stderr).not.toThrow();
  return JSON.parse(result.stdout) as T;
}

function errorBody(result: CliResult): DecisionErrorBody {
  expect(result.exitCode, result.stdout).not.toBe(0);
  const parsed = JSON.parse(result.stdout) as DecisionErrorBody;
  expect(parsed.error).toMatchObject({
    code: expect.any(String),
    message: expect.any(String),
  });
  return parsed;
}

async function writeInputFile(vault: string, name: string, value: unknown): Promise<string> {
  const path = join(vault, `${name}.json`);
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

function makePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_id: POLICY_ID,
    version: 'v001',
    status: 'observing',
    dimension: 'input-routing',
    decision_question: 'Is a WeChat message information, a candidate, a task, a project or a decision?',
    inputs: [{ name: 'sender identity', source: 'wechat contact profile' }],
    sources: ['synthetic_input', 'PAW-GOAL-002@0.2'],
    rules: [
      { statement: 'Route messages with an explicit commitment to inbox candidates.', priority: 10 },
      { statement: 'Leave messages without a detectable ask in the inbox.', priority: 20 },
    ],
    exceptions: ['Messages from unknown senders stay unreviewed.'],
    outputs: ['inbox', 'candidate', 'project_link', 'clarify_request'],
    rationale: 'Synthetic CLI fixture policy.',
    examples: [{ input: 'synthetic message asking for a report', output: 'candidate' }],
    counterexamples: [{ input: 'synthetic chit-chat', output: 'inbox' }],
    metrics: ['trace_coverage', 'user_correction_rate'],
    next_review_at: '2026-08-24',
    created_at: '2026-08-18T06:00:00.000Z',
    ...overrides,
  };
}

function makeTrace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: TRACE_ID,
    policy_ref: POLICY_REF,
    dimension: 'input-routing',
    input_refs: ['msg://synthetic-001'],
    decision: 'candidate',
    reasoning_summary: 'The message contains an explicit commitment to deliver a report.',
    evidence_refs: ['07_System/Rules/Decision_Logic/input-routing/policy.input-routing.synthetic_v001.md'],
    confidence: 'high',
    created_at: '2026-08-18T06:05:00.000Z',
    ...overrides,
  };
}

async function createPolicy(vault: string): Promise<Record<string, unknown>> {
  const input = await writeInputFile(vault, 'policy-input', makePolicy());
  return json<Record<string, unknown>>(await runCli(vault, [
    'decision', 'policy', 'create', '--input', input, '--json',
  ]));
}

async function createTrace(vault: string): Promise<Record<string, unknown>> {
  const input = await writeInputFile(vault, 'trace-input', makeTrace());
  return json<Record<string, unknown>>(await runCli(vault, [
    'decision', 'trace', 'create', '--input', input, '--json',
  ]));
}

/** Installs the full legacy fixture vault shape used by the T6 migration tests. */
async function installLegacySource(source: string): Promise<void> {
  const entries: Array<[string, string]> = [
    ['policy-v001.md', join('07_System', 'Rules', 'Decision_Logic', 'input-routing', 'policy.input-routing.legacy-demo_v001.md')],
    ['policy-attention-v001.md', join('07_System', 'Rules', 'Decision_Logic', 'attention-priority', 'policy.attention-priority.legacy-demo_v001.md')],
    ['trace-with-feedback.md', join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'trace-legacy-demo-feedback-001.md')],
    ['trace-missing-fields.md', join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'trace-legacy-demo-missing-001.md')],
    ['trace-accepted-history.md', join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'trace-legacy-demo-accepted-001.md')],
    ['corrupt.md', join('07_System', 'Logs', 'Decision_Traces', '2026', '08', 'corrupt.md')],
  ];
  for (const [fixtureName, relativePath] of entries) {
    const destination = join(source, relativePath);
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(join(fixtureDir, fixtureName), 'utf8'), 'utf8');
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('decision policy commands', () => {
  it('creates a policy from an input file and reads it back identically', async () => {
    const vault = await makeVault();
    const created = await createPolicy(vault);
    expect(created).toMatchObject({ policy_id: POLICY_ID, version: 'v001' });

    const readBack = json<Record<string, unknown>>(await runCli(vault, [
      'decision', 'policy', 'get', POLICY_REF, '--json',
    ]));
    expect(readBack).toEqual(created);
  });

  it('lists policies with dimension and status filters', async () => {
    const vault = await makeVault();
    await createPolicy(vault);

    const all = json<Array<Record<string, unknown>>>(await runCli(vault, [
      'decision', 'policy', 'list', '--json',
    ]));
    expect(all).toHaveLength(1);

    const otherDimension = json<Array<Record<string, unknown>>>(await runCli(vault, [
      'decision', 'policy', 'list', '--dimension', 'attention-priority', '--json',
    ]));
    expect(otherDimension).toEqual([]);

    const active = json<Array<Record<string, unknown>>>(await runCli(vault, [
      'decision', 'policy', 'list', '--status', 'active', '--json',
    ]));
    expect(active).toEqual([]);
  });

  it('lists versions in order and updates status through a legal transition', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    const secondInput = await writeInputFile(vault, 'policy-input-v2', makePolicy({
      version: 'v002',
      created_at: '2026-08-18T07:00:00.000Z',
    }));
    await runCli(vault, ['decision', 'policy', 'create', '--input', secondInput, '--json']);

    const versions = json<Array<Record<string, unknown>>>(await runCli(vault, [
      'decision', 'policy', 'list-versions', POLICY_ID, '--json',
    ]));
    expect(versions.map((version) => version.version)).toEqual(['v001', 'v002']);

    const updated = json<Record<string, unknown>>(await runCli(vault, [
      'decision', 'policy', 'update-status', POLICY_REF, '--to', 'active', '--json',
    ]));
    expect(updated).toMatchObject({ policy_id: POLICY_ID, status: 'active' });
  });

  it('exits nonzero with the service error code for a duplicate policy version', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    const duplicate = await writeInputFile(vault, 'policy-duplicate', makePolicy());

    const body = errorBody(await runCli(vault, [
      'decision', 'policy', 'create', '--input', duplicate, '--json',
    ]));
    expect(body.error.code).toBe('decision_policy_version_exists');
  });

  it('rejects an invalid --input file with a CLI usage error', async () => {
    const vault = await makeVault();
    const broken = join(vault, 'broken-input.json');
    await writeFile(broken, 'not json', 'utf8');

    const body = errorBody(await runCli(vault, [
      'decision', 'policy', 'create', '--input', broken, '--json',
    ]));
    expect(body.error.code).toBe('invalid_cli_input');
  });
});

describe('decision trace commands', () => {
  it('creates a trace against an existing policy and reads it back', async () => {
    const vault = await makeVault();
    await createPolicy(vault);

    const created = await createTrace(vault);
    expect(created).toMatchObject({
      trace_id: TRACE_ID,
      status: 'recorded',
      feedback_count: 0,
    });

    const readBack = json<Record<string, unknown>>(await runCli(vault, [
      'decision', 'trace', 'get', TRACE_ID, '--json',
    ]));
    expect(readBack).toEqual(created);

    const byPolicy = json<Array<Record<string, unknown>>>(await runCli(vault, [
      'decision', 'trace', 'list', '--policy-ref', POLICY_REF, '--json',
    ]));
    expect(byPolicy).toEqual([created]);
  });

  it('closes and reopens a trace with an audited actor', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const closed = json<Record<string, unknown>>(await runCli(vault, [
      'decision', 'trace', 'close', TRACE_ID, '--actor', 'cli-tester', '--json',
    ]));
    expect(closed).toMatchObject({ trace_id: TRACE_ID, status: 'closed', closed_at: expect.any(String) });

    const reopened = json<Record<string, unknown>>(await runCli(vault, [
      'decision', 'trace', 'reopen', TRACE_ID, '--actor', 'cli-tester', '--json',
    ]));
    expect(reopened).toMatchObject({ trace_id: TRACE_ID, status: 'recorded', closed_at: null });
  });

  it('exits nonzero with decision_policy_ref_unresolved for an unknown policy', async () => {
    const vault = await makeVault();
    const input = await writeInputFile(vault, 'trace-orphan', makeTrace({
      policy_ref: 'policy.input-routing.missing@v001',
    }));

    const body = errorBody(await runCli(vault, [
      'decision', 'trace', 'create', '--input', input, '--json',
    ]));
    expect(body.error.code).toBe('decision_policy_ref_unresolved');
  });
});

describe('decision feedback commands', () => {
  it('records feedback and replays the idempotency key with created:false', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const first = json<{ sample: { feedback_id: string }; created: boolean }>(await runCli(vault, [
      'decision', 'feedback', 'record',
      '--trace', TRACE_ID,
      '--kind', 'accepted',
      '--source-ref', 'msg://synthetic-001',
      '--idempotency-key', IDEMPOTENCY_KEY,
      '--json',
    ]));
    expect(first.created).toBe(true);

    const replay = json<{ sample: { feedback_id: string }; created: boolean }>(await runCli(vault, [
      'decision', 'feedback', 'record',
      '--trace', TRACE_ID,
      '--kind', 'accepted',
      '--source-ref', 'msg://synthetic-001',
      '--idempotency-key', IDEMPOTENCY_KEY,
      '--json',
    ]));
    expect(replay.created).toBe(false);
    expect(replay.sample.feedback_id).toBe(first.sample.feedback_id);
  });

  it('exits nonzero with decision_feedback_trace_closed for a closed trace', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);
    await runCli(vault, ['decision', 'trace', 'close', TRACE_ID, '--actor', 'cli-tester', '--json']);

    const body = errorBody(await runCli(vault, [
      'decision', 'feedback', 'record',
      '--trace', TRACE_ID,
      '--kind', 'accepted',
      '--source-ref', 'msg://synthetic-001',
      '--json',
    ]));
    expect(body.error.code).toBe('decision_feedback_trace_closed');
  });

  it('states the no-idempotency-key behavior in the record --help text', async () => {
    const vault = await makeVault();
    const result = await runCli(vault, ['decision', 'feedback', 'record', '--help']);
    expect(result.exitCode, result.stderr).toBe(0);
    // Commander wraps help text at the terminal width, so compare with all
    // wrapping whitespace removed rather than as a raw substring.
    expect(result.stdout.replace(/\s+/gu, '')).toContain(NO_IDEMPOTENCY_KEY_NOTICE.replace(/\s+/gu, ''));
  });
});

describe('decision query command', () => {
  it('returns the projection envelope with facets and warnings', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const projection = json<{
      items: Array<Record<string, unknown>>;
      facets: Record<string, Record<string, number>>;
      next_cursor: string | null;
      warnings: Array<Record<string, unknown>>;
    }>(await runCli(vault, ['decision', 'query', '--json']));
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({ trace_id: TRACE_ID, source: 'native' });
    expect(Object.keys(projection.facets).sort()).toEqual([
      'dimension',
      'feedback_kind',
      'integrity_status',
      'policy_status',
      'source',
      'trace_status',
    ]);
    expect(projection.facets.source).toEqual({ native: 1 });
    expect(projection.next_cursor).toBeNull();
    expect(projection.warnings).toEqual([]);
  });

  it('applies trace-status and limit filters', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const recorded = json<{ items: Array<Record<string, unknown>> }>(await runCli(vault, [
      'decision', 'query', '--trace-status', 'recorded', '--json',
    ]));
    expect(recorded.items).toHaveLength(1);

    const closed = json<{ items: Array<Record<string, unknown>> }>(await runCli(vault, [
      'decision', 'query', '--trace-status', 'closed', '--json',
    ]));
    expect(closed.items).toEqual([]);

    const limited = json<{ items: Array<Record<string, unknown>>; next_cursor: string | null }>(await runCli(vault, [
      'decision', 'query', '--limit', '1', '--json',
    ]));
    expect(limited.items).toHaveLength(1);
  }, MULTI_PROCESS_CLI_TEST_TIMEOUT_MS);

  it('exits nonzero with decision_query_invalid for an out-of-range limit', async () => {
    const vault = await makeVault();
    const body = errorBody(await runCli(vault, [
      'decision', 'query', '--limit', '0', '--json',
    ]));
    expect(body.error.code).toBe('decision_query_invalid');
  });
});

describe('decision check-consistency command', () => {
  it('returns the consistency report envelope', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const report = json<{
      checked_traces: number;
      issues: Array<Record<string, unknown>>;
    }>(await runCli(vault, ['decision', 'check-consistency', '--json']));
    expect(report.checked_traces).toBe(1);
    expect(report.issues).toEqual([]);
  }, MULTI_PROCESS_CLI_TEST_TIMEOUT_MS);

  it('supports the --repair flag and reports rebuilt summaries', async () => {
    const vault = await makeVault();
    await createPolicy(vault);
    await createTrace(vault);

    const report = json<{
      checked_traces: number;
      issues: Array<Record<string, unknown>>;
    }>(await runCli(vault, ['decision', 'check-consistency', '--repair', '--json']));
    expect(report.checked_traces).toBe(1);
    expect(report.issues).toEqual([]);
  }, MULTI_PROCESS_CLI_TEST_TIMEOUT_MS);
});

describe('decision migrate-legacy command', () => {
  it('migrates the legacy fixture directory and exits nonzero on failed items', async () => {
    const target = await makeVault('atl-decision-migrate-');
    const source = await makeVault('atl-decision-migrate-source-');
    await installLegacySource(source);
    const reportPath = join(target, 'migration-report.json');

    const result = await runCli(target, [
      'decision', 'migrate-legacy',
      '--source', source,
      '--report', reportPath,
      '--json',
    ]);
    expect(result.exitCode, result.stderr).toBe(1);
    const report = parseJson<{
      run_id: string;
      source_root: string;
      source_total: number;
      migrated: number;
      failed: number;
      outcomes: Array<Record<string, unknown>>;
    }>(result);
    expect(report).toMatchObject({ source_root: source, source_total: 6, migrated: 4, failed: 1 });

    const written = JSON.parse(await readFile(reportPath, 'utf8')) as { run_id: string };
    expect(written.run_id).toBe(report.run_id);
  });

  it('exits nonzero with a CLI usage error when required options are missing', async () => {
    const vault = await makeVault();
    const body = errorBody(await runCli(vault, [
      'decision', 'migrate-legacy', '--json',
    ]));
    expect(body.error.code).toBe('invalid_cli_input');
  });

  it('exits nonzero and leaves no file when --report escapes the target vault', async () => {
    const target = await makeVault('atl-decision-migrate-');
    const source = await makeVault('atl-decision-migrate-source-');
    const outside = await makeVault('atl-decision-report-outside-');
    await installLegacySource(source);
    const outsideReport = join(outside, 'outside-report.json');

    const body = errorBody(await runCli(target, [
      'decision', 'migrate-legacy',
      '--source', source,
      '--report', outsideReport,
      '--json',
    ]));
    expect(body.error.code).toBe('decision_migration_invalid');
    await expect(readFile(outsideReport, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits nonzero with decision_migration_invalid when --report is a dangling symlink out of the vault', async () => {
    const target = await makeVault('atl-decision-migrate-');
    const source = await makeVault('atl-decision-migrate-source-');
    const outside = await makeVault('atl-decision-report-outside-');
    await installLegacySource(source);
    // In-vault report path symlinked to an outside file that does not exist
    // yet: the report write would follow the link and create it outside.
    const outsideReport = join(outside, 'dangling-outside-report.json');
    await symlink(outsideReport, join(target, 'dangling-report.json'));

    const body = errorBody(await runCli(target, [
      'decision', 'migrate-legacy',
      '--source', source,
      '--report', join(target, 'dangling-report.json'),
      '--json',
    ]));
    expect(body.error.code).toBe('decision_migration_invalid');
    await expect(readFile(outsideReport, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
