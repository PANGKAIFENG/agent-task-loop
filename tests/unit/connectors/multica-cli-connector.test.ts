import { describe, expect, it } from 'vitest';

import {
  MulticaCallFailedError,
  MulticaCallTimedOutError,
  MulticaCliConnector,
  MulticaOutputUnparseableError,
  multicaTaskMarker,
  type MulticaCommandRequest,
  type MulticaCommandRunner,
  type MulticaDispatchConnector,
} from '../../../src/connectors/multica-cli-connector.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';
const RESEARCH_AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const PROFILE = 'desktop-api.multica.ai';
const BINARY = '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica';

const ISSUE_A = '01234567-89ab-4cde-8f01-234567890abc';
const ISSUE_B = '01234567-89ab-4cde-8f01-234567890abd';

interface IssueJson {
  id: string;
  identifier: string;
  workspace_id: string;
  project_id: string | null;
  description: string | null;
  status: string;
  assignee_id: string | null;
  assignee_type: string | null;
}

function issueJson(overrides: Partial<IssueJson> = {}): IssueJson {
  return {
    id: ISSUE_A,
    identifier: 'TEP-42',
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    // The issue-get read-back carries the dispatch marker, matching what a
    // create or recovery bind would return from the real CLI.
    description: '[ATL_TASK_ID:atl:task-20260820-abc00001]\n\nobjective',
    status: 'backlog',
    assignee_id: null,
    assignee_type: null,
    ...overrides,
  };
}

class RecordingRunner {
  readonly requests: MulticaCommandRequest[] = [];
  private readonly handler: (request: MulticaCommandRequest) => Promise<{ stdout: string; stderr?: string }>;

  constructor(handler: (request: MulticaCommandRequest) => Promise<{ stdout: string }>) {
    this.handler = handler;
  }

  run: MulticaCommandRunner = async (request) => {
    this.requests.push(request);
    const result = await this.handler(request);
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  };

  commands(): string[][] {
    return this.requests.map(({ args }) => [...args]);
  }

  findCommand(predicate: (args: string[]) => boolean): string[] | undefined {
    return this.commands().find(predicate);
  }
}

function runnerForIssues(issuesByMetadata: IssueJson[], recentIssues: IssueJson[] = []): RecordingRunner {
  const issues = new Map(
    [...issuesByMetadata, ...recentIssues].map((issue) => [issue.id, { ...issue }]),
  );
  const runs = new Map<string, { id: string; status: string }[]>();
  return new RecordingRunner(async ({ args }) => {
    const issueId = args[args.indexOf('issue') + 2] ?? ISSUE_A;
    if (args.includes('list')) {
      const metadataSearch = args.includes('--metadata');
      const payload = JSON.stringify({
        issues: metadataSearch ? issuesByMetadata : recentIssues,
      });
      return { stdout: payload };
    }
    if (args.includes('create')) {
      const created = issueJson();
      issues.set(created.id, created);
      return { stdout: JSON.stringify(created) };
    }
    if (args.includes('get')) {
      return { stdout: JSON.stringify(issues.get(issueId) ?? issueJson({ id: issueId })) };
    }
    if (args.includes('metadata') && args.includes('set')) {
      return { stdout: '{}' };
    }
    if (args.includes('runs')) {
      return { stdout: JSON.stringify(runs.get(issueId) ?? []) };
    }
    if (args.includes('assign')) {
      const current = issues.get(issueId) ?? issueJson({ id: issueId });
      const assigned = { ...current, assignee_id: SQUAD_ID, assignee_type: 'squad' };
      issues.set(issueId, assigned);
      return { stdout: JSON.stringify(assigned) };
    }
    if (args.includes('status')) {
      const current = issues.get(issueId) ?? issueJson({ id: issueId });
      const active = { ...current, status: 'in_progress' };
      issues.set(issueId, active);
      runs.set(issueId, [{ id: 'run-initial', status: 'in_progress' }]);
      return { stdout: JSON.stringify(active) };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  });
}

// CR fix 2: a board-shaped remote — `issue list` honors --offset/--limit and
// returns one page per call, like the real Multica CLI. The metadata search
// answers from its own list so the marker scan is what must page.
function pagedRunnerForIssues(allIssues: IssueJson[], metadataMatches: IssueJson[] = []): RecordingRunner {
  const issues = new Map(
    [...allIssues, ...metadataMatches].map((issue) => [issue.id, { ...issue }]),
  );
  const runs = new Map<string, { id: string; status: string }[]>();
  return new RecordingRunner(async ({ args }) => {
    const issueId = args[args.indexOf('issue') + 2] ?? ISSUE_A;
    if (args.includes('list')) {
      if (args.includes('--metadata')) {
        return { stdout: JSON.stringify({ issues: metadataMatches }) };
      }
      const offset = Number(args[args.indexOf('--offset') + 1]);
      const limit = Number(args[args.indexOf('--limit') + 1]);
      const page = allIssues.slice(offset, offset + limit);
      return { stdout: JSON.stringify({ issues: page }) };
    }
    if (args.includes('create')) {
      const created = issueJson();
      issues.set(created.id, created);
      return { stdout: JSON.stringify(created) };
    }
    if (args.includes('get')) {
      const found = issues.get(issueId) ?? issueJson({ id: issueId });
      return { stdout: JSON.stringify(found) };
    }
    if (args.includes('metadata') && args.includes('set')) {
      return { stdout: '{}' };
    }
    if (args.includes('runs')) {
      return { stdout: JSON.stringify(runs.get(issueId) ?? []) };
    }
    if (args.includes('assign')) {
      const current = issues.get(issueId) ?? issueJson({ id: issueId });
      const assigned = { ...current, assignee_id: SQUAD_ID, assignee_type: 'squad' };
      issues.set(issueId, assigned);
      return { stdout: JSON.stringify(assigned) };
    }
    if (args.includes('status')) {
      const current = issues.get(issueId) ?? issueJson({ id: issueId });
      const active = { ...current, status: 'in_progress' };
      issues.set(issueId, active);
      runs.set(issueId, [{ id: 'run-initial', status: 'in_progress' }]);
      return { stdout: JSON.stringify(active) };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  });
}

interface ActivationRunnerOptions {
  issue?: IssueJson;
  initialRuns?: { id: string; status: string }[];
  runsAfterAssign?: { id: string; status: string }[];
  runsAfterStatus?: { id: string; status: string }[];
  assignError?: Error;
  assignLandsBeforeError?: boolean;
  statusError?: Error;
  statusLandsBeforeError?: boolean;
  onCall?: (() => void) | undefined;
}

function activationRunner(options: ActivationRunnerOptions = {}): RecordingRunner {
  let issue = { ...(options.issue ?? issueJson()) };
  let runs = [...(options.initialRuns ?? [])];
  return new RecordingRunner(async ({ args }) => {
    options.onCall?.();
    if (args.includes('list')) {
      return { stdout: JSON.stringify({ issues: [issue] }) };
    }
    if (args.includes('metadata') && args.includes('set')) {
      return { stdout: '{}' };
    }
    if (args.includes('get')) {
      return { stdout: JSON.stringify(issue) };
    }
    if (args.includes('runs')) {
      return { stdout: JSON.stringify(runs) };
    }
    if (args.includes('assign')) {
      if (options.assignError === undefined || options.assignLandsBeforeError === true) {
        issue = { ...issue, assignee_id: SQUAD_ID, assignee_type: 'squad' };
        runs = [...(options.runsAfterAssign ?? runs)];
      }
      if (options.assignError !== undefined) throw options.assignError;
      return { stdout: JSON.stringify(issue) };
    }
    if (args.includes('status')) {
      if (options.statusError === undefined || options.statusLandsBeforeError === true) {
        issue = { ...issue, status: 'in_progress' };
        runs = [...(options.runsAfterStatus ?? runs)];
      }
      if (options.statusError !== undefined) throw options.statusError;
      return { stdout: JSON.stringify(issue) };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  });
}

function fillerIssues(count: number, firstIndex: number): IssueJson[] {
  return Array.from({ length: count }, (_, index) => issueJson({
    id: `ffffffff-0000-4000-8000-${String(firstIndex + index).padStart(12, '0')}`,
    identifier: `TEP-${900 + firstIndex + index}`,
    description: `unrelated filler ${firstIndex + index}`,
  }));
}

function makeConnector(
  runner: MulticaCommandRunner,
  overrides: Partial<ConstructorParameters<typeof MulticaCliConnector>[0]> = {},
) {
  const usesExplicitAssignment = overrides.assignment !== undefined;
  return new MulticaCliConnector({
    binaryPath: BINARY,
    profile: PROFILE,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    ...(usesExplicitAssignment ? {} : { squadId: SQUAD_ID }),
    runner,
    ...overrides,
  });
}

function checkLinked(
  result: Awaited<ReturnType<MulticaDispatchConnector['ensureIssue']>>,
): asserts result is Extract<typeof result, { status: 'linked' }> {
  if (result.status !== 'linked') {
    throw new Error(`expected linked, got ${result.status}`);
  }
}

const envelope = {
  idempotencyKey: 'atl:task-20260820-abc00001',
  title: 'Ship the dispatch slice',
  description: `${multicaTaskMarker('atl:task-20260820-abc00001')}\n\nobjective`,
};

const researchEnvelope = {
  ...envelope,
  description: [
    multicaTaskMarker(envelope.idempotencyKey),
    '',
    '## Context Manifest',
    '- manifest_id: cm_222222222222222222222222',
    `- manifest_sha256: ${'2'.repeat(64)}`,
    '- dispatch_attempt_id: dispatch_222222222222222222222222',
    '',
    '## Consumed context',
    'current research context',
  ].join('\n'),
};

describe('MulticaCliConnector configuration', () => {
  it('rejects non-absolute binaries and malformed identifiers', () => {
    expect(() => makeConnector(async () => ({ stdout: '', stderr: '' }))).toBeDefined();
    expect(() => new MulticaCliConnector({
      binaryPath: 'multica',
      profile: PROFILE,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    })).toThrowError(/absolute/);
    expect(() => new MulticaCliConnector({
      binaryPath: BINARY,
      profile: 'bad profile',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      squadId: SQUAD_ID,
    })).toThrowError(/profile/);
    expect(() => new MulticaCliConnector({
      binaryPath: BINARY,
      profile: PROFILE,
      workspaceId: 'nope',
      projectId: PROJECT_ID,
      squadId: SQUAD_ID,
    })).toThrowError(/workspaceId/);
    expect(() => new MulticaCliConnector({
      binaryPath: BINARY,
      profile: PROFILE,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      squadId: 'nope',
    })).toThrowError(/squadId/);
  });
});

describe('MulticaCliConnector research agent policy', () => {
  it('fails before issue access when the configured agent model drifts', async () => {
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('agent') && args.includes('get')) {
        return { stdout: JSON.stringify({
          id: RESEARCH_AGENT_ID,
          workspace_id: WORKSPACE_ID,
          model: 'gpt-5.5',
          max_concurrent_tasks: 10,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        }) };
      }
      throw new Error(`issue access must remain closed: ${args.join(' ')}`);
    });
    const connector = makeConnector(runner.run, {
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: 'gpt-5.6-sol',
        requiredMaxConcurrentTasks: 10,
      },
    });

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'failed',
      reason: 'Research Agent model mismatch: expected gpt-5.6-sol, received gpt-5.5',
    });
    expect(runner.commands()).toHaveLength(1);
    expect(runner.commands()[0]).toContain('agent');
    expect(runner.commands()[0]).toContain('get');
  });

  it('fails before issue access when the configured agent concurrency drifts', async () => {
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('agent') && args.includes('get')) {
        return { stdout: JSON.stringify({
          id: RESEARCH_AGENT_ID,
          workspace_id: WORKSPACE_ID,
          model: 'gpt-5.6-sol',
          max_concurrent_tasks: 4,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        }) };
      }
      throw new Error(`issue access must remain closed: ${args.join(' ')}`);
    });
    const connector = makeConnector(runner.run, {
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: 'gpt-5.6-sol',
        requiredMaxConcurrentTasks: 10,
      },
    });

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'failed',
      reason: 'Research Agent concurrency mismatch: expected 10, received 4',
    });
    expect(runner.commands()).toHaveLength(1);
  });

  it('rejects a run that is not owned by the configured agent', async () => {
    const remoteIssue = issueJson({
      status: 'in_progress',
      assignee_id: RESEARCH_AGENT_ID,
      assignee_type: 'agent',
    });
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('agent') && args.includes('get')) {
        return { stdout: JSON.stringify({
          id: RESEARCH_AGENT_ID,
          workspace_id: WORKSPACE_ID,
          model: 'gpt-5.6-sol',
          max_concurrent_tasks: 10,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        }) };
      }
      if (args.includes('list')) {
        return { stdout: JSON.stringify({ issues: [remoteIssue] }) };
      }
      if (args.includes('metadata') && args.includes('set')) {
        return { stdout: '{}' };
      }
      if (args.includes('get')) {
        return { stdout: JSON.stringify(remoteIssue) };
      }
      if (args.includes('runs')) {
        return { stdout: JSON.stringify([{
          id: '01234567-aaaa-4cde-8f01-234567890aaa',
          issue_id: ISSUE_A,
          agent_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'in_progress',
          result: null,
        }]) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = makeConnector(runner.run, {
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: 'gpt-5.6-sol',
        requiredMaxConcurrentTasks: 10,
      },
    });

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'failed',
      reason: `Run 01234567-aaaa-4cde-8f01-234567890aaa is not owned by Research Agent ${RESEARCH_AGENT_ID}`,
    });
  });

  it.each([
    {
      name: 'model',
      second: { model: 'gpt-5.5', max_concurrent_tasks: 10 },
      reason: 'Research Agent model mismatch: expected gpt-5.6-sol, received gpt-5.5',
    },
    {
      name: 'concurrency',
      second: { model: 'gpt-5.6-sol', max_concurrent_tasks: 4 },
      reason: 'Research Agent concurrency mismatch: expected 10, received 4',
    },
  ])('fails when the Research Agent $name drifts after the Run starts', async ({ second, reason }) => {
    const remoteIssue = issueJson({
      status: 'in_progress',
      assignee_id: RESEARCH_AGENT_ID,
      assignee_type: 'agent',
    });
    let agentReads = 0;
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('agent') && args.includes('get')) {
        agentReads += 1;
        const snapshot = agentReads === 1
          ? { model: 'gpt-5.6-sol', max_concurrent_tasks: 10 }
          : second;
        return { stdout: JSON.stringify({
          id: RESEARCH_AGENT_ID,
          workspace_id: WORKSPACE_ID,
          ...snapshot,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        }) };
      }
      if (args.includes('list')) return { stdout: JSON.stringify({ issues: [remoteIssue] }) };
      if (args.includes('metadata') && args.includes('set')) return { stdout: '{}' };
      if (args.includes('get')) return { stdout: JSON.stringify(remoteIssue) };
      if (args.includes('runs')) {
        return { stdout: JSON.stringify([{
          id: '01234567-aaaa-4cde-8f01-234567890aaa',
          issue_id: ISSUE_A,
          agent_id: RESEARCH_AGENT_ID,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'in_progress',
          result: null,
        }]) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = makeConnector(runner.run, {
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: 'gpt-5.6-sol',
        requiredMaxConcurrentTasks: 10,
      },
    });

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({ status: 'failed', reason });
    expect(agentReads).toBe(2);
  });
});

describe('MulticaCliConnector.ensureIssue', () => {
  it('creates exactly once with safe argv when no remote issue exists', async () => {
    const runner = runnerForIssues([], []);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'linked',
      ref: { issueId: ISSUE_A, issueIdentifier: 'TEP-42' },
      recovered: false,
      activation: {
        assigneeId: SQUAD_ID,
        runId: 'run-initial',
        recovered: false,
      },
    });
    const commands = runner.commands();
    // Every invocation uses the absolute binary flags first — no shell, no interpolation.
    for (const args of commands) {
      expect(args[0]).toBe('--profile');
      expect(args[1]).toBe(PROFILE);
      expect(args[2]).toBe('--workspace-id');
      expect(args[3]).toBe(WORKSPACE_ID);
      expect(args.slice(0, 4).join(' ')).not.toMatch(/[;&|`$]/);
    }
    const create = runner.findCommand((args) => args.includes('create'));
    expect(create).toBeDefined();
    expect(create).toContain('--status');
    expect(create?.[create.indexOf('--status') + 1]).toBe('backlog');
    expect(create).toContain('--description-stdin');
    expect(create).not.toContain('--assignee');
    expect(create).not.toContain('--assignee-id');
    // Description travels over stdin, never as an argv value.
    const createRequest = runner.requests.find(({ args }) => args.includes('create'));
    expect(createRequest?.stdin).toContain('[ATL_TASK_ID:atl:task-20260820-abc00001]');
    // Metadata is written and read back before the link is reported.
    expect(runner.findCommand((args) => args.includes('metadata') && args.includes('set')))
      .toContain('atl:task-20260820-abc00001');
    expect(runner.findCommand((args) => args.includes('get') && args.includes(ISSUE_A)))
      .toBeDefined();
    expect(commands.filter((args) => args.includes('create'))).toHaveLength(1);
    const runs = commands.filter((args) => args.includes('runs'));
    expect(runs).toHaveLength(3);
    const assign = runner.findCommand((args) => args.includes('assign'));
    expect(assign).toEqual(expect.arrayContaining([
      'issue', 'assign', ISSUE_A, '--to-id', SQUAD_ID, '--no-start', '--output', 'json',
    ]));
    const start = runner.findCommand((args) => args.includes('status'));
    expect(start).toEqual(expect.arrayContaining([
      'issue', 'status', ISSUE_A, 'in_progress', '--output', 'json',
    ]));
    expect(start).not.toContain('--no-start');
  });

  it('binds the single metadata match without creating', async () => {
    const runner = runnerForIssues([issueJson({
      description: envelope.description,
    })]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('linked');
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('recovers an interrupted create through the description marker scan', async () => {
    const runner = runnerForIssues([], [
      issueJson({ description: envelope.description }),
    ]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    checkLinked(result);
    expect(result.ref.issueId).toBe(ISSUE_A);
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('CR fix 2: recovers a marker match that only exists on the second page', async () => {
    const target = issueJson({
      id: ISSUE_B,
      identifier: 'TEP-55',
      description: envelope.description,
    });
    const runner = pagedRunnerForIssues([
      ...fillerIssues(50, 0),
      ...fillerIssues(9, 50),
      target,
    ]);
    const connector = makeConnector(runner.run, { markerScanLimit: 50 });

    const result = await connector.ensureIssue(envelope);

    checkLinked(result);
    expect(result.ref.issueId).toBe(ISSUE_B);
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
    const listCommands = runner.commands().filter((args) => args.includes('list') && !args.includes('--metadata'));
    expect(listCommands.length).toBeGreaterThanOrEqual(2);
    expect(listCommands[0]).toContain('--offset');
  });

  it.each([
    ['quoted', `> ${envelope.description.replaceAll('\n', '\n> ')}`],
    ['code-blocked', `\`\`\`text\n${envelope.description}\n\`\`\``],
  ])('does not bind a Work that only contains a %s copy of the current envelope', async (_kind, description) => {
    const runner = runnerForIssues([], [issueJson({ description })]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('linked');
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(1);
  });

  it('rejects a metadata candidate whose description wraps the current envelope', async () => {
    const runner = runnerForIssues([issueJson({
      description: `${envelope.description}\n\nUnrelated trailing content`,
    })]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'failed',
      reason: 'remote issue TEP-42 dispatch envelope does not match the current request',
    });
    expect(runner.commands().filter((args) => args.includes('runs'))).toHaveLength(0);
  });

  it('CR fix 2: reports duplicate_conflict for marker matches spread across pages', async () => {
    const first = issueJson({
      id: ISSUE_A,
      description: `${multicaTaskMarker(envelope.idempotencyKey)}\n\nfirst`,
    });
    const second = issueJson({
      id: ISSUE_B,
      identifier: 'TEP-55',
      description: `${multicaTaskMarker(envelope.idempotencyKey)}\n\nsecond`,
    });
    const runner = pagedRunnerForIssues([
      ...fillerIssues(10, 0),
      first,
      ...fillerIssues(39, 11),
      second,
    ]);
    const connector = makeConnector(runner.run, { markerScanLimit: 50 });

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'duplicate_conflict',
      candidateIssueIds: [ISSUE_A, ISSUE_B],
    });
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
    expect(runner.commands().filter((args) => args.includes('metadata'))).toHaveLength(0);
  });

  it('CR fix 2: an unbounded board makes the scan incomplete and forbids create', async () => {
    // Every page comes back full, so the scan can never prove completeness.
    const filler = fillerIssues(50, 0);
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('list')) {
        if (args.includes('--metadata')) {
          return { stdout: JSON.stringify({ issues: [] }) };
        }
        return { stdout: JSON.stringify({ issues: filler }) };
      }
      return { stdout: '{}' };
    });
    const connector = makeConnector(runner.run, { markerScanLimit: 50, markerScanMaxPages: 3 });

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('remote_write_unknown');
    if (result.status === 'remote_write_unknown') {
      expect(result.reason).toContain('description marker scan');
      expect(result.reason).toContain('multica_scan_incomplete');
    }
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('CR fix 3: an exhausted round budget refuses the next CLI operation', async () => {
    const runner = runnerForIssues([], []);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope, {
      deadlineAt: Date.now() - 1,
    });

    expect(result.status).toBe('remote_write_unknown');
    if (result.status === 'remote_write_unknown') {
      expect(result.reason).toContain('multica_budget_exhausted');
    }
    expect(runner.requests).toHaveLength(0);
  });

  it('CR fix 3: each CLI call is clipped to the remaining round budget', async () => {
    let virtualNow = Date.now();
    const runner = new RecordingRunner(async ({ args }) => {
      // Every CLI operation consumes 6s of the shared round clock.
      virtualNow += 6_000;
      if (args.includes('list')) {
        return { stdout: JSON.stringify({ issues: [] }) };
      }
      return { stdout: '{}' };
    });
    const connector = makeConnector(runner.run, {
      callTimeoutMs: 20_000,
      clock: () => new Date(virtualNow),
    });

    const result = await connector.ensureIssue(envelope, {
      deadlineAt: virtualNow + 10_000,
    });

    // The metadata search and the first marker-scan page fit in the budget
    // (each clipped to what remains); the next stage refuses to start.
    expect(result.status).toBe('remote_write_unknown');
    if (result.status === 'remote_write_unknown') {
      expect(result.reason).toContain('multica_budget_exhausted');
    }
    const timeouts = runner.requests.map(({ timeoutMs }) => timeoutMs);
    expect(timeouts).toEqual([10_000, 4_000]);
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('reports duplicate_conflict and performs no create or metadata write', async () => {
    const runner = runnerForIssues([
      issueJson({ id: ISSUE_A, description: '[ATL_TASK_ID:atl:task-20260820-abc00001]' }),
      issueJson({ id: ISSUE_B, identifier: 'TEP-43', description: '[ATL_TASK_ID:atl:task-20260820-abc00001]' }),
    ]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result).toEqual({
      status: 'duplicate_conflict',
      candidateIssueIds: [ISSUE_A, ISSUE_B],
    });
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
    expect(runner.commands().filter((args) => args.includes('metadata'))).toHaveLength(0);
  });

  it('maps a metadata search timeout to remote_write_unknown and never creates', async () => {
    const runner = new RecordingRunner(async () => {
      throw new MulticaCallTimedOutError(['issue', 'list']);
    });
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('remote_write_unknown');
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('forbids create when the description marker scan is uncertain', async () => {
    let listCalls = 0;
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('list')) {
        listCalls += 1;
        if (listCalls === 1) {
          return { stdout: JSON.stringify({ issues: [] }) };
        }
        throw new MulticaOutputUnparseableError('mangled payload');
      }
      return { stdout: '{}' };
    });
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('remote_write_unknown');
    if (result.status === 'remote_write_unknown') {
      expect(result.reason).toContain('description marker scan');
    }
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('treats a create timeout as remote_write_unknown, not a failure', async () => {
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('list')) {
        return { stdout: JSON.stringify({ issues: [] }) };
      }
      if (args.includes('create')) {
        throw new MulticaCallTimedOutError(['issue', 'create']);
      }
      return { stdout: '{}' };
    });
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result).toMatchObject({ status: 'remote_write_unknown' });
  });

  it('fails closed without any CLI call when the envelope is unsafe', async () => {
    const runner = runnerForIssues([]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue({
      idempotencyKey: 'atl:task-20260820-abc00001',
      title: 'badtitle',
      description: 'no marker',
    });

    expect(result).toMatchObject({ status: 'failed' });
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects a single match that does not validate against the target', async () => {
    const runner = runnerForIssues([issueJson({
      workspace_id: 'ffffffff-ffff-4cde-8f01-234567890fff',
      description: '[ATL_TASK_ID:atl:task-20260820-abc00001]',
    })]);
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result).toMatchObject({ status: 'failed' });
    expect(runner.commands().filter((args) => args.includes('create'))).toHaveLength(0);
  });

  it('maps a definite CLI error exit to failed with the reason', async () => {
    const runner = new RecordingRunner(async () => {
      throw new MulticaCallFailedError('Multica CLI exited with 1: project not found');
    });
    const connector = makeConnector(runner.run);

    const result = await connector.ensureIssue(envelope);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toContain('metadata search');
    }
  });

  it('recovers an already assigned and started issue without a second start', async () => {
    const runner = activationRunner({
      issue: issueJson({
        status: 'in_progress',
        assignee_id: SQUAD_ID,
        assignee_type: 'squad',
      }),
      initialRuns: [{ id: 'run-existing', status: 'in_progress' }],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toMatchObject({
      status: 'linked',
      activation: { assigneeId: SQUAD_ID, runId: 'run-existing', recovered: true },
    });
    expect(runner.commands().filter((args) => args.includes('assign'))).toHaveLength(0);
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('does not bind a single old Run when the remote Work description belongs to an older envelope', async () => {
    const runner = activationRunner({
      issue: issueJson({
        status: 'in_progress',
        assignee_id: SQUAD_ID,
        assignee_type: 'squad',
        description: [
          multicaTaskMarker(envelope.idempotencyKey),
          '',
          '## Context Manifest',
          '- manifest_id: cm_111111111111111111111111',
          `- manifest_sha256: ${'1'.repeat(64)}`,
          '- dispatch_attempt_id: dispatch_111111111111111111111111',
        ].join('\n'),
      }),
      initialRuns: [{ id: 'run-from-old-envelope', status: 'in_progress' }],
    });

    const result = await makeConnector(runner.run).ensureIssue(researchEnvelope);

    expect(result).toEqual({
      status: 'failed',
      reason: 'remote issue TEP-42 dispatch envelope does not match the current request',
    });
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('fails closed when an assigned Work has multiple eligible Runs and no exact binding', async () => {
    const runner = activationRunner({
      issue: issueJson({
        status: 'in_progress',
        assignee_id: SQUAD_ID,
        assignee_type: 'squad',
      }),
      initialRuns: [
        { id: 'run-first', status: 'in_progress' },
        { id: 'run-second', status: 'in_progress' },
      ],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toEqual({
      status: 'duplicate_conflict',
      candidateIssueIds: [ISSUE_A],
    });
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('does not hide a second eligible Run beyond the former 200-record slice', async () => {
    const runs = Array.from({ length: 201 }, (_, index) => ({
      id: `run-${String(index).padStart(3, '0')}`,
      issue_id: ISSUE_A,
      agent_id: index === 0 || index === 200 ? RESEARCH_AGENT_ID : null,
      runtime_id: index === 0 || index === 200
        ? '5f282aa0-e717-421d-ab84-d1f0d4aab551'
        : null,
      status: 'in_progress',
      result: null,
    }));
    const remoteIssue = issueJson({
      status: 'in_progress',
      assignee_id: RESEARCH_AGENT_ID,
      assignee_type: 'agent',
    });
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('agent') && args.includes('get')) {
        return { stdout: JSON.stringify({
          id: RESEARCH_AGENT_ID,
          workspace_id: WORKSPACE_ID,
          model: 'gpt-5.6-sol',
          max_concurrent_tasks: 10,
          runtime_id: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
          status: 'idle',
        }) };
      }
      if (args.includes('list')) return { stdout: JSON.stringify({ issues: [remoteIssue] }) };
      if (args.includes('metadata') && args.includes('set')) return { stdout: '{}' };
      if (args.includes('get')) return { stdout: JSON.stringify(remoteIssue) };
      if (args.includes('runs')) return { stdout: JSON.stringify(runs) };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = makeConnector(runner.run, {
      assignment: {
        type: 'agent',
        id: RESEARCH_AGENT_ID,
        requiredModel: 'gpt-5.6-sol',
        requiredMaxConcurrentTasks: 10,
      },
    });

    await expect(connector.ensureIssue(envelope)).resolves.toEqual({
      status: 'duplicate_conflict',
      candidateIssueIds: [ISSUE_A],
    });
    expect(runner.commands().filter((args) => args.includes('assign'))).toHaveLength(0);
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('rejects a matching assignee id whose type is not squad even when a run exists', async () => {
    const runner = activationRunner({
      issue: issueJson({
        status: 'in_progress',
        assignee_id: SQUAD_ID,
        assignee_type: 'agent',
      }),
      initialRuns: [{ id: 'run-existing', status: 'in_progress' }],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toEqual({
      status: 'failed',
      reason: 'remote issue TEP-42 has an unexpected assignee type',
    });
    expect(runner.commands().filter((args) => args.includes('assign'))).toHaveLength(0);
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('heals an assign timeout by read-back and starts exactly once', async () => {
    const runner = activationRunner({
      assignError: new MulticaCallTimedOutError(['issue', 'assign']),
      assignLandsBeforeError: true,
      runsAfterStatus: [{ id: 'run-after-timeout', status: 'in_progress' }],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toMatchObject({
      status: 'linked',
      recovered: false,
      activation: { runId: 'run-after-timeout', recovered: false },
    });
    expect(runner.commands().filter((args) => args.includes('assign'))).toHaveLength(1);
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(1);
  });

  it('heals a start timeout when exactly one new run is read back', async () => {
    const runner = activationRunner({
      statusError: new MulticaCallTimedOutError(['issue', 'status']),
      statusLandsBeforeError: true,
      runsAfterStatus: [{ id: 'run-healed', status: 'in_progress' }],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toMatchObject({
      status: 'linked',
      activation: { runId: 'run-healed', recovered: false },
    });
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(1);
  });

  it('keeps an unconfirmed assign timeout unknown and never starts', async () => {
    const runner = activationRunner({
      assignError: new MulticaCallTimedOutError(['issue', 'assign']),
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toMatchObject({ status: 'remote_write_unknown' });
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });

  it('fails closed when start yields no new run', async () => {
    const runner = activationRunner({ runsAfterStatus: [] });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toEqual({
      status: 'remote_write_unknown',
      reason: 'supervisor start: no new run observed',
    });
  });

  it('reports a conflict when one start yields multiple new runs', async () => {
    const runner = activationRunner({
      runsAfterStatus: [
        { id: 'run-first', status: 'in_progress' },
        { id: 'run-second', status: 'in_progress' },
      ],
    });

    const result = await makeConnector(runner.run).ensureIssue(envelope);

    expect(result).toEqual({
      status: 'duplicate_conflict',
      candidateIssueIds: [ISSUE_A],
    });
  });

  it('stops activation when the shared deadline is exhausted', async () => {
    let virtualNow = 1_000;
    const runner = activationRunner({ onCall: () => { virtualNow += 1_000; } });
    const connector = makeConnector(runner.run, { clock: () => new Date(virtualNow) });

    const result = await connector.ensureIssue(envelope, { deadlineAt: 5_500 });

    expect(result).toMatchObject({ status: 'remote_write_unknown' });
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(0);
  });
});

describe('MulticaCliConnector.inspect', () => {
  it('reads back a remote issue snapshot', async () => {
    const runner = runnerForIssues([]);
    const connector = makeConnector(runner.run);

    const snapshot = await connector.inspect(ISSUE_A);

    expect(snapshot).toEqual({
      issueId: ISSUE_A,
      issueIdentifier: 'TEP-42',
      status: 'backlog',
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      assigneeId: null,
      assigneeType: null,
    });
  });

  it('rejects malformed issue ids', async () => {
    const connector = makeConnector(runnerForIssues([]).run);
    await expect(connector.inspect('not-a-uuid')).rejects.toThrowError(/issueId/);
  });
});
