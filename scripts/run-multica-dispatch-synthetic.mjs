// PAW-GOAL-003 T1 synthetic dispatch receipt (Task Contract artifact):
// drives the real ATL CLI (`task authorize-development`, `multica dispatch`,
// `multica reconcile`) against a temp vault and a stateful fake Multica CLI,
// then asserts the unique-dispatch invariants across five scenarios:
//   S1 fresh create binds exactly one issue (0 -> 1)
//   S2 create-then-crash recovery rebinds the same issue via the description
//      marker (still exactly one issue for that task)
//   S3 duplicate remote metadata stops automatic execution (duplicate_conflict)
//   S4 reconciliation syncs the bound link without re-dispatching
//   S5 FIX-3: concurrent manual dispatches against a lease older than 120s
//      still produce exactly one remote ensure (one linked, one fail-closed)
// Usage: node scripts/run-multica-dispatch-synthetic.mjs [--receipt <path>]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, '..');
// pnpm's .bin/tsx shim is a shell script; run the tsx CLI entry with node.
const tsxPath = join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = join(appRoot, 'src', 'cli.ts');

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';

const args = process.argv.slice(2);
const receiptIndex = args.indexOf('--receipt');
const receiptPath = receiptIndex >= 0 ? args[receiptIndex + 1] : null;

const vaultRoot = await mkdtemp(join(tmpdir(), 'paw-t1-dispatch-'));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'paw-t1-fixture-'));
const fakeStorePath = join(fixtureRoot, 'multica-store.json');
const startedAt = new Date().toISOString();
const steps = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: appRoot,
      env: {
        ...process.env,
        ATL_VAULT_ROOT: vaultRoot,
        ATL_MULTICA_BINARY: join(appRoot, 'scripts', 'fake-multica-cli.mjs'),
        FAKE_MULTICA_STORE: fakeStorePath,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function atl(commandArgs, expectation) {
  const result = await run(process.execPath, [tsxPath, cliPath, ...commandArgs, '--json']);
  const step = {
    command: `pnpm atl ${commandArgs.join(' ')}`,
    exitCode: result.code,
  };
  check(result.code === 0, `${step.command} failed (${result.code}): ${result.stderr}`);
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    check(false, `${step.command} emitted invalid JSON: ${result.stdout.slice(0, 400)}`);
  }
  if (expectation !== undefined) {
    step.expectation = expectation;
    step.observed = payload;
  }
  steps.push(step);
  return payload;
}

async function atlFails(commandArgs) {
  const result = await run(process.execPath, [tsxPath, cliPath, ...commandArgs, '--json']);
  check(result.code === 1, `expected failure exited with ${result.code}`);
  const payload = JSON.parse(result.stdout);
  check(payload.ok === false, 'expected an error envelope');
  steps.push({
    command: `pnpm atl ${commandArgs.join(' ')}`,
    exitCode: result.code,
    expectation: 'fail closed',
    observed: payload,
  });
  return payload.error;
}

// FIX-3 (S5): spawn several manual dispatch processes simultaneously. The
// durable lease in the vault frontmatter (guarded by the cross-process task
// lock) must arbitrate them to exactly one remote ensure.
async function atlParallel(commands, expectation) {
  const results = await Promise.all(
    commands.map((commandArgs) => run(process.execPath, [tsxPath, cliPath, ...commandArgs, '--json'])),
  );
  for (const result of results) {
    check(result.code === 0, `parallel atl failed (${result.code}): ${result.stderr}`);
  }
  const payloads = results.map((result) => JSON.parse(result.stdout));
  steps.push({
    command: `pnpm atl ${commands[0].join(' ')} x${commands.length} (concurrent)`,
    exitCode: results.map((result) => result.code),
    expectation,
    observed: payloads,
  });
  return payloads;
}

async function readStore() {
  try {
    return JSON.parse(await readFile(fakeStorePath, 'utf8'));
  } catch {
    return { issues: [], nextNumber: 100 };
  }
}

function developmentTaskFrontmatter(taskId, options = {}) {
  const status = options.status ?? 'ready';
  const executionLink = options.staleExecutionLinkAt === undefined ? [] : [
    'execution_link:',
    '  schema_version: 1',
    '  provider: multica',
    `  idempotency_key: atl:${taskId}`,
    `  workspace_id: ${WORKSPACE_ID}`,
    `  project_id: ${PROJECT_ID}`,
    '  issue_id: null',
    '  issue_identifier: null',
    '  dispatch_state: resolving_remote',
    '  remote_state: null',
    '  last_comment_id: null',
    '  last_event_id: null',
    '  summary: null',
    '  artifact_refs: []',
    `  last_attempt_at: '${options.staleExecutionLinkAt}'`,
    '  last_synced_at: null',
  ];
  return [
    '---',
    'type: task',
    'schema_version: 1',
    `task_id: ${taskId}`,
    `title: 'T1 synthetic ${taskId}'`,
    `status: ${status}`,
    'review_state: confirmed',
    `project_id: ${PROJECT_ID}`,
    'task_type: development',
    'objective: Prove the unique Multica dispatch contract',
    'acceptance_criteria:',
    '  - Exactly one remote issue per authorized task',
    'auto_executable: false',
    'permission_profile: repo_delivery',
    'execution_target: multica',
    'context_refs:',
    '  - docs/PROJECT/goals/PAW-GOAL-003-real-multica-loop-v0.4.md',
    `source_key: synthetic:${taskId}`,
    'origin: synthetic',
    'priority: normal',
    'attempts: 0',
    'claim: null',
    'artifact_refs: []',
    'review_feedback: null',
    "ready_at: '2026-08-20T00:00:00.000Z'",
    "created_at: '2026-08-20T00:00:00.000Z'",
    "updated_at: '2026-08-20T00:00:00.000Z'",
    ...executionLink,
    '---',
    '',
    `Synthetic development task ${taskId} for PAW-GOAL-003 T1.`,
    '',
  ].join('\n');
}

async function writeTask(taskId, options = {}) {
  const directory = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${taskId}.md`), developmentTaskFrontmatter(taskId, options), 'utf8');
}

async function readTaskLink(taskId) {
  const directory = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID);
  const raw = await readFile(join(directory, `${taskId}.md`), 'utf8');
  const match = /dispatch_state:\s*(\S+)/.exec(raw);
  const issueMatch = /issue_id:\s*([0-9a-f-]+)/.exec(raw);
  return {
    dispatchState: match?.[1] ?? null,
    issueId: issueMatch?.[1] ?? null,
  };
}

function issueCountFor(store, idempotencyKey) {
  const byMetadata = store.issues.filter(
    (issue) => issue.metadata?.atl_task_id === idempotencyKey,
  ).length;
  const byMarker = store.issues.filter(
    (issue) => (issue.description ?? '').includes(`[ATL_TASK_ID:${idempotencyKey}]`),
  ).length;
  return { byMetadata, byMarker, total: store.issues.length };
}

try {
  // S1 — fresh authorize dispatches immediately and creates exactly one issue.
  const s1Task = 'task-20260820-synth001';
  await writeTask(s1Task);
  const authorized = await atl(
    ['task', 'authorize-development', '--task-id', s1Task],
    'linked with exactly one created issue',
  );
  check(authorized.task.status === 'agent_executable', 'S1: task must be agent_executable');
  check(authorized.dispatch.status === 'linked', 'S1: dispatch must link');
  let store = await readStore();
  let counts = issueCountFor(store, `atl:${s1Task}`);
  check(counts.byMetadata === 1, `S1: expected 1 issue with metadata, got ${counts.byMetadata}`);
  check(counts.byMarker === 1, 'S1: created issue must carry the description marker');
  let link = await readTaskLink(s1Task);
  check(link.dispatchState === 'linked', `S1: frontmatter dispatch_state=${link.dispatchState}`);
  const s1IssueId = authorized.dispatch.issueId;

  // Re-running the same authorization path must be idempotent (already_linked).
  const again = await atl(
    ['multica', 'dispatch', '--task-id', s1Task],
    'already_linked without a second create',
  );
  check(again.status === 'already_linked', `S1 rerun: ${again.status}`);
  store = await readStore();
  counts = issueCountFor(store, `atl:${s1Task}`);
  check(counts.byMarker === 1, 'S1 rerun: no second create allowed');

  // S2 — create succeeded, metadata write was lost: recovery rebinds the same
  // issue through the description marker scan without creating another one.
  // CR fix 2: filler issues push the crashed target onto the second list
  // page, so the receipt proves the marker scan recovers beyond page one.
  const s2Task = 'task-20260820-synth002';
  await writeTask(s2Task);
  const crashStore = await readStore();
  const fillerCount = 55;
  for (let index = 0; index < fillerCount; index += 1) {
    crashStore.nextNumber = (crashStore.nextNumber ?? 100) + 1;
    crashStore.issues.push({
      id: randomUUID(),
      identifier: `TEP-${crashStore.nextNumber}`,
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      title: `T1 filler board issue ${index}`,
      description: `Unrelated board filler ${index}; it carries no ATL marker.`,
      status: 'backlog',
      metadata: {},
      created_at: new Date().toISOString(),
      number: crashStore.nextNumber,
    });
  }
  crashStore.nextNumber = (crashStore.nextNumber ?? 100) + 1;
  const crashedIssueId = randomUUID();
  const crashedIssueIndex = crashStore.issues.length;
  crashStore.issues.push({
    id: crashedIssueId,
    identifier: `TEP-${crashStore.nextNumber}`,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: 'T1 synthetic recovered',
    description: `Earlier create survived the crash; the metadata write did not.\n[ATL_TASK_ID:atl:${s2Task}]`,
    status: 'backlog',
    metadata: {},
    created_at: new Date().toISOString(),
    number: crashStore.nextNumber,
  });
  await writeFile(fakeStorePath, `${JSON.stringify(crashStore, null, 2)}\n`, 'utf8');
  const recoveredPage = Math.floor(crashedIssueIndex / 50) + 1;
  check(recoveredPage >= 2, `S2 setup: target must land beyond page 1, got page ${recoveredPage}`);
  // The task is still `ready` (never authorized), so dispatch must fail
  // closed before any remote call — authorization is the dispatch trigger.
  const refused = await atlFails(['multica', 'dispatch', '--task-id', s2Task]);
  check(
    refused.code === 'development_dispatch_not_admitted',
    `S2 pre-check: expected fail-closed admission, got ${refused.code}`,
  );
  const authorizedS2 = await atl(
    ['task', 'authorize-development', '--task-id', s2Task],
    'authorization triggers marker recovery of the same issue',
  );
  check(authorizedS2.dispatch.status === 'linked', `S2: ${authorizedS2.dispatch.status}`);
  check(
    authorizedS2.dispatch.issueId === crashedIssueId,
    'S2: recovery must bind the pre-existing issue, not create a new one',
  );
  store = await readStore();
  counts = issueCountFor(store, `atl:${s2Task}`);
  check(counts.byMarker === 1 && counts.byMetadata === 1, 'S2: exactly one issue after recovery');

  // S3 — duplicate remote metadata stops automatic execution.
  const s3Task = 'task-20260820-synth003';
  await writeTask(s3Task);
  const duplicateStore = await readStore();
  for (let index = 0; index < 2; index += 1) {
    duplicateStore.nextNumber = (duplicateStore.nextNumber ?? 100) + 1;
    duplicateStore.issues.push({
      id: randomUUID(),
      identifier: `TEP-${duplicateStore.nextNumber}`,
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      title: 'T1 duplicate candidate',
      description: `[ATL_TASK_ID:atl:${s3Task}]`,
      status: 'backlog',
      metadata: { atl_task_id: `atl:${s3Task}` },
      created_at: new Date().toISOString(),
      number: duplicateStore.nextNumber,
    });
  }
  await writeFile(fakeStorePath, `${JSON.stringify(duplicateStore, null, 2)}\n`, 'utf8');
  const conflicted = await atl(
    ['task', 'authorize-development', '--task-id', s3Task],
    'duplicate_conflict with zero additional creates',
  );
  check(
    conflicted.dispatch.status === 'duplicate_conflict',
    `S3: ${conflicted.dispatch.status}`,
  );
  link = await readTaskLink(s3Task);
  check(link.dispatchState === 'duplicate_conflict', `S3: frontmatter ${link.dispatchState}`);
  store = await readStore();
  check(store.issues.length === duplicateStore.issues.length, 'S3: no extra issue created');

  // S4 — reconciliation syncs bound links without re-dispatching.
  const reconciled = await atl(
    ['multica', 'reconcile'],
    'syncs the two bound links, skips the conflict',
  );
  const outcomeByTask = new Map(reconciled.outcomes.map((outcome) => [outcome.taskId, outcome]));
  check(outcomeByTask.get(s1Task)?.action === 'synced', 'S4: first link must sync');
  check(outcomeByTask.get(s2Task)?.action === 'synced', 'S4: recovered link must sync');
  check(
    outcomeByTask.get(s3Task)?.action === 'skipped_conflict',
    'S4: conflict must be skipped, not retried',
  );
  store = await readStore();
  check(
    store.issues.length === duplicateStore.issues.length,
    `S4: total issues must stay ${duplicateStore.issues.length}, got ${store.issues.length}`,
  );
  link = await readTaskLink(s1Task);
  check(link.issueId === s1IssueId, 'S4: link must stay bound to the original issue');

  // S5 — FIX-3 (TEP-45 P1): a lease older than 120s no longer hides a live
  // dispatcher, and the remote ensure itself can no longer outlive its lease.
  // Two concurrent manual dispatch processes against the stale lease must
  // arbitrate to exactly one remote ensure: one linked outcome, one
  // fail-closed outcome (in_flight, or already_linked if the winner finished
  // first), and exactly one created issue.
  const s5Task = 'task-20260820-synth005';
  const staleAttemptAt = new Date(Date.now() - 121_000).toISOString();
  await writeTask(s5Task, {
    status: 'agent_executable',
    staleExecutionLinkAt: staleAttemptAt,
  });
  const dispatchedPair = await atlParallel(
    [
      ['multica', 'dispatch', '--task-id', s5Task],
      ['multica', 'dispatch', '--task-id', s5Task],
    ],
    'exactly one linked outcome, one fail-closed outcome, one created issue',
  );
  const linkedOutcomes = dispatchedPair.filter((payload) => payload.status === 'linked');
  const failClosedOutcomes = dispatchedPair.filter(
    (payload) => payload.status === 'in_flight' || payload.status === 'already_linked',
  );
  check(linkedOutcomes.length === 1, `S5: expected exactly one linked, got ${dispatchedPair.map((p) => p.status).join(',')}`);
  check(failClosedOutcomes.length === 1, `S5: expected one fail-closed outcome, got ${dispatchedPair.map((p) => p.status).join(',')}`);
  store = await readStore();
  const s5Counts = issueCountFor(store, `atl:${s5Task}`);
  check(
    s5Counts.byMarker === 1 && s5Counts.byMetadata === 1,
    `S5: exactly one issue for the task, got ${JSON.stringify(s5Counts)}`,
  );
  const s5Link = await readTaskLink(s5Task);
  check(s5Link.dispatchState === 'linked', `S5: frontmatter dispatch_state=${s5Link.dispatchState}`);

  const receipt = {
    receipt_type: 'paw-goal-003-t1-synthetic-dispatch',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    vault_root: vaultRoot,
    fake_multica_store: fakeStorePath,
    connector: 'MulticaCliConnector (spawn, absolute binary, explicit profile/workspace)',
    fix_round: {
      round: 2,
      review_sources: [
        'TEP-43 receipt PAW-GOAL-003-T1-CR-f7f151ae-20260820-01',
        'TEP-44 independent CR on f7f151aef42e73de96f05774f0f92dbd824f9521',
        'TEP-45 independent CR on 5b87170d658fd865e15d39241aace5b6690afeac (human gate PAW-GOAL-003-T1-cycle-limit)',
      ],
      fixes: [
        'single-flight in-flight lease across the remote ensure (concurrent dispatch)',
        'context path containment: canonical resolve + symlink resolution',
        'strict bounded --max-tasks (1..10)',
        'marker/metadata recovery scans every page or reports remote_write_unknown',
        '120s reconciliation budget propagated into every CLI call',
        'FIX-3: lease-bounded ensure deadline for every entry point — the remote ensure terminates strictly inside the 120s single-flight lease, so no entry can race a live dispatcher after 120s',
      ],
    },
    scenarios: {
      s1_unique_create: { task: s1Task, issueId: s1IssueId, issueCount: 1 },
      s2_marker_recovery: { task: s2Task, issueId: crashedIssueId, issueCount: 1, recoveredFromPage: recoveredPage },
      s3_duplicate_conflict: { task: s3Task, candidateCount: 2, created: 0 },
      s4_reconcile_sync: { synced: [s1Task, s2Task], skippedConflict: [s3Task] },
      s5_over_120s_single_ensure: {
        task: s5Task,
        staleLeaseAgeSeconds: 121,
        concurrentManualDispatches: 2,
        linked: linkedOutcomes.length,
        failClosed: failClosedOutcomes.map((payload) => payload.status).join(','),
        issueCount: s5Counts.byMarker,
      },
    },
    invariants: {
      exactlyOneIssuePerAuthorizedTask: true,
      noAssigneeNoAutoStartOnCreate: true,
      localRunnerNeverClaimedMulticaTasks: true,
      over120sConcurrentDispatchSingleEnsure: true,
    },
    steps,
  };
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptPath !== null) {
    await writeFile(receiptPath, serialized, 'utf8');
    process.stdout.write(`receipt written: ${receiptPath}\n`);
  } else {
    process.stdout.write(serialized);
  }
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`synthetic dispatch loop failed: ${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
}
