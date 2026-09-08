#!/usr/bin/env node
// PAW-GOAL-003 T3 synthetic release-readback receipt (Task Contract artifact):
// drives the real ATL CLI (`multica ingest`, `multica reply`, `multica
// release`) against a temp vault, the stateful fake Multica CLI, a temp plugin
// directory and the REAL fixed verification suite on the candidate worktree.
// No real Multica write, no real DingTalk message, no real GitHub call — the
// merge/live evidence arrives as files exactly the way the authorized release
// step will deliver them. Scenarios:
//   R1 RC projection + approve: a versioned release_candidate_ready comment
//      projects review + a pending approve action_request; the trusted
//      DingTalk approve reply walks to release_operator_started while the
//      task stays in review (never auto-done).
//   R2 live canary: a linked synthetic task consumes a terminal completed
//      event and stays in review — Multica `done` alone is never product
//      acceptance; the canary refs become the live-verification evidence.
//   R3 stale event: a newer RC event (different event id / head SHA) in the
//      current-event file rejects the acceptance as stale with ZERO
//      verification commands executed.
//   R4 head-SHA mismatch (service level, scripted runner): the candidate
//      worktree head no longer equals the accepted SHA — stale, no publish.
//   R5 verification failure (service level): a failing fixed command stops
//      the release before merge and install.
//   R6 rollback drill (service level): a failed live verification restores
//      the backed-up plugin byte-for-byte and keeps the failure receipt.
//   R9 triple post-passed failure (service level, CR2 TEP-55 P1): the passed
//      receipt is durable, then the task projection fails, the rollback
//      source fails without touching the installed bytes, and the terminal
//      rolled_back ledger overwrite fails too — the independent invalidation
//      record must survive, read back, and make the next replay reject.
//   R10 four-way post-passed failure (service level, CR3 TEP-56 P1): the
//      invalidation record write fails TOO — ledger still passed, bytes
//      unchanged, invalidation store empty. The write-ahead projection
//      marker (armed before the passed receipt persisted, resolved only
//      after a confirmed done projection) must survive pending, read back,
//      and make the next healthy replay reject.
//   R7 the real release: the REAL fixed suite (test/typecheck/lint/build/
//      verify:v0.2-loop/git diff --check) runs on the candidate worktree,
//      then merge evidence -> backup -> install -> canary evidence -> receipt
//      metadata write (T3.1 trusted channel: no comment, no run) -> stubbed
//      DingTalk notice -> task done -> four-system read-back -> passed
//      receipt.
//   R8 replay: re-running release on the passed acceptance replays the
//      receipt without a second receipt write.
// Usage: node scripts/run-multica-release-synthetic.mjs --head-sha <sha> \
//   [--workdir <path>] [--receipt <path>]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, '..');
const tsxPath = join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = join(appRoot, 'src', 'cli.ts');

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const TRUSTED_SENDER = 'synthetic-self-staff';
const TRUSTED_CONVERSATION = 'synthetic-self-conversation';
const REPOSITORY = 'PANGKAIFENG/personal-ai-workbench';
const PR_REF = '16';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
// Test-only escape hatch: stop before the real fixed-verification release so
// the fast scenarios can be smoke-checked without the full pnpm suite. The
// receipt is NOT valid for the task artifact in this mode.
const skipRealRelease = args.includes('--skip-real-release');
const receiptPath = argValue('--receipt');
const headSha = argValue('--head-sha');
if (headSha === null || !/^[0-9a-f]{40}$/.test(headSha)) {
  throw new Error('--head-sha <40-hex sha> is required (the immutable candidate)');
}
const workDir = argValue('--workdir') ?? resolve(appRoot, '..', '..');

const vaultRoot = await mkdtemp(join(tmpdir(), 'paw-t3-release-'));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'paw-t3-fixture-'));
const fakeStorePath = join(fixtureRoot, 'multica-store.json');
const pluginRoot = join(fixtureRoot, 'plugin');
const startedAt = new Date().toISOString();
const steps = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    ATL_VAULT_ROOT: vaultRoot,
    ATL_MULTICA_BINARY: join(appRoot, 'scripts', 'fake-multica-cli.mjs'),
    FAKE_MULTICA_STORE: fakeStorePath,
    ATL_DINGTALK_TRUSTED_SENDER_ID: TRUSTED_SENDER,
    ATL_DINGTALK_TRUSTED_CONVERSATION_ID: TRUSTED_CONVERSATION,
    ATL_RELEASE_DINGTALK_STUB: '1',
    ...extra,
  };
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? appRoot,
      env: baseEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

function runWithStdin(command, commandArgs, stdinPayload, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: appRoot,
      env: baseEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinPayload, 'utf8');
  });
}

async function atl(commandArgs, expectation, options = {}) {
  const result = await run(
    process.execPath,
    [tsxPath, cliPath, ...commandArgs, '--json'],
    options,
  );
  const step = { command: `pnpm atl ${commandArgs.join(' ')}`, exitCode: result.code };
  check(
    result.code === 0,
    `${step.command} failed (${result.code}): ${result.stderr.slice(0, 400)} ${result.stdout.slice(0, 400)}`,
  );
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    check(false, `${step.command} emitted invalid JSON: ${result.stdout.slice(0, 400)}`);
  }
  step.expectation = expectation;
  step.observed = payload;
  steps.push(step);
  return payload;
}

async function atlReply(streamEventId, senderUserId, message) {
  const payload = JSON.stringify({
    eventId: streamEventId,
    senderUserId,
    conversationId: TRUSTED_CONVERSATION,
    message,
  });
  const result = await runWithStdin(
    process.execPath,
    [tsxPath, cliPath, 'multica', 'reply', '--stdin-json', '--json'],
    payload,
  );
  check(result.code === 0, `multica reply failed (${result.code}): ${result.stderr}`);
  const observed = JSON.parse(result.stdout);
  steps.push({
    command: `pnpm atl multica reply --stdin-json (event ${streamEventId}, sender ${senderUserId})`,
    exitCode: result.code,
    expectation: 'four-step response ledger',
    observed,
  });
  return observed;
}

async function readStore() {
  try {
    return JSON.parse(await readFile(fakeStorePath, 'utf8'));
  } catch {
    return { issues: [], nextNumber: 100 };
  }
}

async function writeStore(store) {
  await writeFile(fakeStorePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function eventBody(payload) {
  return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function rcEventPayload(taskId, eventId, occurredAt, overrides = {}) {
  return {
    schema_version: 1,
    event_id: eventId,
    atl_task_id: taskId,
    state: 'release_candidate_ready',
    summary: `Fresh CR passed on immutable candidate ${headSha.slice(0, 10)}`,
    decision: null,
    recoverability: null,
    artifact_refs: ['docs/HANDOFF/PAW-GOAL-003-T3.md'],
    release: { repository: REPOSITORY, issue: null, pr: PR_REF, head_sha: headSha },
    occurred_at: occurredAt,
    ...overrides,
  };
}

function completedEventPayload(taskId, eventId, occurredAt) {
  return {
    schema_version: 1,
    event_id: eventId,
    atl_task_id: taskId,
    state: 'completed',
    summary: 'Synthetic canary completed its loop',
    decision: null,
    recoverability: null,
    artifact_refs: [],
    release: null,
    occurred_at: occurredAt,
  };
}

async function seedLinkedIssue(taskId, issueNumber, comments, overrides = {}) {
  const store = await readStore();
  const issue = {
    id: randomUUID(),
    identifier: `TEP-${issueNumber}`,
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: `T3 synthetic ${taskId}`,
    description: `[ATL_TASK_ID:atl:${taskId}]\n\nT3 release fixture`,
    status: 'in_progress',
    metadata: { atl_task_id: `atl:${taskId}` },
    created_at: '2026-08-21T00:00:00.000Z',
    number: issueNumber,
    comments,
    runs: [{ id: 'run-0001', status: 'completed' }],
    ...overrides,
  };
  store.issues.push(issue);
  store.nextNumber = Math.max(store.nextNumber ?? 100, issueNumber);
  store.nextComment = (store.nextComment ?? 0) + comments.length;
  await writeStore(store);
  return issue;
}

function linkedTaskFrontmatter(taskId, issueId, issueNumber, overrides = {}) {
  const lines = [
    '---',
    'type: task',
    'schema_version: 1',
    `task_id: ${taskId}`,
    `title: 'T3 synthetic ${taskId}'`,
    'status: agent_executable',
    'review_state: confirmed',
    `project_id: ${PROJECT_ID}`,
    'task_type: development',
    'objective: Prove the RC release and read-back contract',
    'acceptance_criteria:',
    '  - Release Receipt complete and consistent with the accepted RC SHA',
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
    "ready_at: '2026-08-21T00:00:00.000Z'",
    "created_at: '2026-08-21T00:00:00.000Z'",
    "updated_at: '2026-08-21T00:00:00.000Z'",
    'execution_link:',
    '  schema_version: 1',
    '  provider: multica',
    `  idempotency_key: atl:${taskId}`,
    `  workspace_id: ${WORKSPACE_ID}`,
    `  project_id: ${PROJECT_ID}`,
    `  issue_id: ${issueId}`,
    `  issue_identifier: 'TEP-${issueNumber}'`,
    '  dispatch_state: linked',
    '  remote_state: active',
    '  last_comment_id: null',
    '  last_event_id: null',
    '  summary: null',
    '  artifact_refs: []',
    "  last_attempt_at: '2026-08-21T00:00:00.000Z'",
    '  last_synced_at: null',
    ...(overrides.actionRequestLines ?? []),
    '---',
    '',
    `Synthetic development task ${taskId} for PAW-GOAL-003 T3.`,
    '',
  ];
  return lines.join('\n');
}

// The approve already walked the four-step ledger (R1 does that for the main
// task through the real reply command); stale tasks start post-approve with a
// handled action_request so the scenarios exercise the release currency gate.
function handledApproveLines(taskId, eventId, streamEventId) {
  return [
    'action_request:',
    '  schema_version: 1',
    `  action_id: action:${taskId}:${eventId}`,
    `  event_id: ${eventId}`,
    '  type: release_candidate_ready',
    '  status: handled',
    '  title: RC 待验收：接受并发布',
    '  summary: handled approve fixture',
    '  allowed_actions:',
    '    - approve',
    '    - rework',
    '    - block',
    '    - cancel',
    '  multica_issue: TEP-301',
    `  github_pr: '16'`,
    `  head_sha: '${headSha}'`,
    '  notification_id: msg-notify-0001',
    `  handled_stream_event_id: ${streamEventId}`,
    '  handled_terminal_step: release_operator_started',
  ];
}

async function writeTask(taskId, issueId, issueNumber, overrides = {}) {
  const directory = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${taskId}.md`),
    linkedTaskFrontmatter(taskId, issueId, issueNumber, overrides),
    'utf8',
  );
}

async function readTaskFile(taskId) {
  const path = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${taskId}.md`);
  return readFile(path, 'utf8');
}

async function readTaskFileAnyStatus(taskId) {
  const candidates = [
    join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${taskId}.md`),
    join(vaultRoot, '10_Tasks', 'Archive', String(new Date().getFullYear()), `${taskId}.md`),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // Try the next lifecycle location.
    }
  }
  return null;
}

async function readLedger(name) {
  const path = join(vaultRoot, '.atl-runtime', name);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function issueStoreSummary(store, issueId) {
  const issue = store.issues.find((candidate) => candidate.id === issueId);
  return {
    comments: issue?.comments?.length ?? 0,
    runs: issue?.runs?.length ?? 0,
  };
}

async function preparePluginDirectories() {
  const buildDir = join(workDir, 'apps', 'agent-task-loop', 'build', 'obsidian-plugin');
  const pluginDir = join(pluginRoot, 'plugins', 'agent-task-loop');
  const backupRoot = join(pluginRoot, 'backups');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'manifest.json'), `${JSON.stringify({ id: 'agent-task-loop', version: '0.8.0' })}\n`);
  await writeFile(join(pluginDir, 'main.js'), 'old plugin main bytes');
  return { buildDir, pluginDir, backupRoot };
}

function serviceLevelProgram(body, eventFilePath) {
  return `
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runReleaseOperator } from ${JSON.stringify(join(appRoot, 'src', 'services', 'release-operator.js'))};
import { FileReleaseReceiptLedger } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'file-release-receipt-ledger.js'))};
import { FileReleaseInvalidationLedger } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'file-release-invalidation-ledger.js'))};
import { FileReleaseProjectionMarkerStore } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'file-release-projection-marker.js'))};
import { MulticaCliConnector } from ${JSON.stringify(join(appRoot, 'src', 'connectors', 'multica-cli-connector.js'))};
import { MarkdownTaskRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-task-repository.js'))};
import { MarkdownArtifactRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-artifact-repository.js'))};
import { MarkdownProjectRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-project-repository.js'))};
import { FileAuditLog } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'audit-log.js'))};
import { parseMulticaEventComment } from ${JSON.stringify(join(appRoot, 'src', 'domain', 'multica-event.js'))};

const vaultRoot = ${JSON.stringify(vaultRoot)};
const workDir = ${JSON.stringify(workDir)};
const ctx = {
  tasks: new MarkdownTaskRepository(vaultRoot),
  artifacts: new MarkdownArtifactRepository(vaultRoot),
  projects: new MarkdownProjectRepository(vaultRoot),
  audit: new FileAuditLog(vaultRoot, { timeZone: 'Asia/Shanghai' }),
  clock: () => new Date(),
  id: () => 'task-20260821-svclevel0',
};
const connector = new MulticaCliConnector({
  binaryPath: ${JSON.stringify(join(appRoot, 'scripts', 'fake-multica-cli.mjs'))},
  profile: 'desktop-api.multica.ai',
  workspaceId: ${JSON.stringify(WORKSPACE_ID)},
  projectId: ${JSON.stringify(PROJECT_ID)},
  callTimeoutMs: 20_000,
});
const ledger = new FileReleaseReceiptLedger(join(vaultRoot, '.atl-runtime'));
const invalidations = new FileReleaseInvalidationLedger(join(vaultRoot, '.atl-runtime'));
const projectionMarkers = new FileReleaseProjectionMarkerStore(join(vaultRoot, '.atl-runtime'));
const eventPayload = await readFile(${JSON.stringify(eventFilePath)}, 'utf8');
const fence = String.fromCharCode(96).repeat(3);
const currentEvent = parseMulticaEventComment('svc', fence + 'json\\n' + eventPayload + '\\n' + fence).events[0];
const RUNNER_PLACEHOLDER = null;
${body}
`;
}

async function runServiceScenario(name, payload, runnerLiteral, body) {
  const eventFilePath = join(fixtureRoot, `${name}-event.json`);
  const programPath = join(fixtureRoot, `${name}.mts`);
  await writeFile(eventFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(
    programPath,
    serviceLevelProgram(body, eventFilePath).replace(
      'const RUNNER_PLACEHOLDER = null;',
      `const verificationRunner = ${runnerLiteral};`,
    ),
    'utf8',
  );
  const result = await run(process.execPath, [tsxPath, programPath]);
  check(result.code === 0, `${name} failed: ${result.stderr.slice(0, 600)}`);
  return JSON.parse(result.stdout);
}

try {
  check(
    Number.parseInt(/^v(\d+)/.exec(process.version)?.[1] ?? '0', 10) >= 24,
    `Node 24+ required, running ${process.version}`,
  );

  const pluginDirs = await preparePluginDirectories();

  // R1 — RC event projects review + pending approve; the trusted approve reply
  // reaches release_operator_started and the task STAYS in review.
  const mainTask = 'task-20260821-rels0001';
  const mainIssue = await seedLinkedIssue(mainTask, 301, [
    {
      id: 'cmt-0001',
      parent_id: null,
      body: eventBody(rcEventPayload(mainTask, 'evt-rc-main01', '2026-08-21T01:00:00.000Z')),
      created_at: '2026-08-21T01:00:00.000Z',
      author_type: 'agent',
    },
  ]);
  await writeTask(mainTask, mainIssue.id, 301);

  const r1Ingest = await atl(['multica', 'ingest', '--task-id', mainTask], 'RC event projects review + pending approve');
  check(r1Ingest.outcomes.some((outcome) => (
    outcome.action === 'projected' && outcome.state === 'release_candidate_ready'
  )), 'R1: RC event projected');
  let rawTask = await readTaskFile(mainTask);
  check(/status: review/.test(rawTask), 'R1: task in review after RC event');
  check(/action_id: action:task-20260821-rels0001:evt-rc-main01/.test(rawTask), 'R1: pending approve request projected');
  check(/approve/.test(rawTask), 'R1: approve is a legal action');

  const r1Reply = await atlReply('stream-approve-0001', TRUSTED_SENDER, `approve ${mainTask}`);
  check(
    r1Reply.status === 'completed' && r1Reply.step === 'release_operator_started',
    `R1: reply outcome ${r1Reply.status}/${r1Reply.step}`,
  );
  rawTask = await readTaskFileAnyStatus(mainTask) ?? '';
  check(/status: review/.test(rawTask), 'R1: approve keeps the task in review');
  check(/handled_terminal_step: release_operator_started/.test(rawTask), 'R1: terminal step recorded');

  // R2 — live canary: a linked synthetic task consumes a terminal completed
  // event and stays in review (never auto-done); its refs are the live
  // verification evidence.
  const canaryTask = 'task-20260821-canary01';
  const canaryIssue = await seedLinkedIssue(canaryTask, 302, [
    {
      id: 'cmt-0101',
      parent_id: null,
      body: eventBody(completedEventPayload(canaryTask, 'evt-canary01', '2026-08-21T01:30:00.000Z')),
      created_at: '2026-08-21T01:30:00.000Z',
      author_type: 'agent',
    },
  ]);
  await writeTask(canaryTask, canaryIssue.id, 302);
  const canaryIngest = await atl(['multica', 'ingest', '--task-id', canaryTask], 'terminal completed event keeps the canary in review');
  check(canaryIngest.outcomes.some((outcome) => outcome.action === 'projected'), 'R2: canary event projected');
  const canaryRaw = await readTaskFile(canaryTask);
  check(/status: review/.test(canaryRaw), 'R2: completed event projects review, never auto-done');

  const liveEvidence = {
    canaryTaskId: canaryTask,
    multicaIssueId: canaryIssue.id,
    multicaRunId: 'run-0001',
    dingTalkMessageId: 'synthetic-ding-msg-canary',
    dingTalkStreamEventId: 'stream-approve-0001',
    passed: true,
    summary: 'canary consumed its terminal event and stayed in review until this release receipt',
  };

  // Evidence files the authorized release step would hand over.
  const mergeEvidence = {
    repository: REPOSITORY,
    pr: PR_REF,
    headSha,
    mergeSha: 'f'.repeat(40),
    prStatus: 'merged',
    issueStatus: 'closed',
  };
  const evidenceFile = join(fixtureRoot, 'release-evidence.json');
  await writeFile(evidenceFile, `${JSON.stringify({ github: mergeEvidence, live: liveEvidence }, null, 2)}\n`);
  const currentEventFile = join(fixtureRoot, 'current-event.json');
  await writeFile(
    currentEventFile,
    `${JSON.stringify(rcEventPayload(mainTask, 'evt-rc-main01', '2026-08-21T01:00:00.000Z'), null, 2)}\n`,
  );

  const releaseArgs = [
    'multica', 'release',
    '--task-id', mainTask,
    '--current-event-file', currentEventFile,
    '--fresh-review-ref', 'TEP-51',
    '--evidence-file', evidenceFile,
    '--workdir', workDir,
    '--plugin-dir', pluginDirs.pluginDir,
    '--backup-root', pluginDirs.backupRoot,
  ];
  const releaseArgsFor = (taskId, eventFile) => [
    'multica', 'release',
    '--task-id', taskId,
    '--current-event-file', eventFile,
    '--fresh-review-ref', 'TEP-51',
    '--evidence-file', evidenceFile,
    '--workdir', workDir,
    '--plugin-dir', pluginDirs.pluginDir,
    '--backup-root', pluginDirs.backupRoot,
  ];

  // R3 — stale event: the CURRENT release event moved on (newer event id +
  // head SHA); the acceptance is stale and NOTHING runs — not even the head
  // check, which is asserted by wall time and the receipt's null verification.
  const staleTask = 'task-20260821-rels0002';
  const staleIssue = await seedLinkedIssue(staleTask, 303, [
    {
      id: 'cmt-0201',
      parent_id: null,
      body: eventBody(rcEventPayload(staleTask, 'evt-rc-stale1', '2026-08-21T01:00:00.000Z')),
      created_at: '2026-08-21T01:00:00.000Z',
      author_type: 'agent',
    },
  ]);
  await writeTask(staleTask, staleIssue.id, 303, {
    actionRequestLines: handledApproveLines(staleTask, 'evt-rc-stale1', 'stream-approve-0002'),
  });
  // Bring the stale task into review the way the approve transition would.
  const staleTaskPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${staleTask}.md`);
  await writeFile(staleTaskPath, (await readFile(staleTaskPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');

  const staleEventFile = join(fixtureRoot, 'stale-event.json');
  await writeFile(
    staleEventFile,
    `${JSON.stringify(rcEventPayload(staleTask, 'evt-rc-stale2', '2026-08-21T03:00:00.000Z', {
      release: { repository: REPOSITORY, issue: null, pr: PR_REF, head_sha: 'e'.repeat(40) },
    }), null, 2)}\n`,
  );
  const staleStarted = Date.now();
  const r3 = await atl(
    releaseArgsFor(staleTask, staleEventFile),
    'stale current event rejects the acceptance without executing anything',
  );
  check(r3.status === 'not_released' && r3.receipt.status === 'stale_rejected', `R3: outcome ${JSON.stringify(r3).slice(0, 200)}`);
  check((r3.receipt.rejectionReason ?? '').includes('stale_event'), 'R3: reason names the stale event');
  check(r3.receipt.verification === null, 'R3: no verification ran');
  check(Date.now() - staleStarted < 30_000, 'R3: stale rejection is fast (no fixed suite)');
  const staleRaw = await readTaskFile(staleTask);
  check(/status: review/.test(staleRaw), 'R3: stale task untouched in review');

  // R4 — head-SHA mismatch at the verification boundary (scripted runner).
  const headMismatchTask = 'task-20260821-rels0003';
  const headMismatchIssue = await seedLinkedIssue(headMismatchTask, 304, []);
  await writeTask(headMismatchTask, headMismatchIssue.id, 304, {
    actionRequestLines: handledApproveLines(headMismatchTask, 'evt-rc-head01', 'stream-approve-0003'),
  });
  const headMismatchPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${headMismatchTask}.md`);
  await writeFile(headMismatchPath, (await readFile(headMismatchPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');

  const r4 = await runServiceScenario(
    'r4-head-mismatch',
    rcEventPayload(headMismatchTask, 'evt-rc-head01', '2026-08-21T01:00:00.000Z'),
    `{
      run: async (argv) => ({
        command: argv.join(' '),
        exitCode: 0,
        stdout: argv[1] === 'rev-parse' ? '9'.repeat(40) : argv[1] === 'status' ? '' : 'ok',
        stderr: '',
        durationMs: 1,
      }),
    }`,
    `
const outcome = await runReleaseOperator(ctx, {
  ledger,
  invalidations,
  projectionMarkers,
  connector,
  ports: {
    verificationRunner,
    nodeVersion: process.version,
    workDir,
    mergeAcceptedPr: async () => { throw new Error('must not merge on a stale head'); },
    liveVerification: async () => { throw new Error('must not run the canary on a stale head'); },
    notifyDingTalk: async () => ({ messageId: 'must-not-send' }),
  },
}, {
  taskId: ${JSON.stringify(headMismatchTask)},
  currentEvent,
  freshReviewRef: 'TEP-51',
  vaultRoot,
  plugin: {
    pluginDir: ${JSON.stringify(join(pluginRoot, 'plugins', 'r4-plugin'))},
    backupRoot: ${JSON.stringify(join(pluginRoot, 'r4-backups'))},
  },
});
console.log(JSON.stringify(outcome));
`,
  );
  check(r4.status === 'not_released' && r4.receipt.status === 'stale_rejected', `R4: outcome ${r4.receipt?.status}`);
  check(r4.receipt.verification.headCheck.matched === false, 'R4: head check recorded the mismatch');
  check(r4.receipt.verification.commands.length === 0, 'R4: zero fixed commands ran');
  steps.push({
    command: 'service level: release operator with drifted worktree head',
    exitCode: 0,
    expectation: 'stale_head_sha: worktree head differs from the accepted SHA',
    observed: r4,
  });

  // R5 — fixed verification failure stops before merge and install.
  const verifyFailTask = 'task-20260821-rels0004';
  const verifyFailIssue = await seedLinkedIssue(verifyFailTask, 305, []);
  await writeTask(verifyFailTask, verifyFailIssue.id, 305, {
    actionRequestLines: handledApproveLines(verifyFailTask, 'evt-rc-verf01', 'stream-approve-0004'),
  });
  const verifyFailPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${verifyFailTask}.md`);
  await writeFile(verifyFailPath, (await readFile(verifyFailPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');

  const r5 = await runServiceScenario(
    'r5-verification-failure',
    rcEventPayload(verifyFailTask, 'evt-rc-verf01', '2026-08-21T01:00:00.000Z'),
    `{
      run: async (argv) => ({
        command: argv.join(' '),
        exitCode: argv.includes('typecheck') ? 1 : 0,
        stdout: argv[1] === 'rev-parse' ? ${JSON.stringify(headSha)} : argv[1] === 'status' ? '' : 'ok',
        stderr: 'simulated typecheck failure',
        durationMs: 1,
      }),
    }`,
    `
let merged = false;
const outcome = await runReleaseOperator(ctx, {
  ledger,
  invalidations,
  projectionMarkers,
  connector,
  ports: {
    verificationRunner,
    nodeVersion: process.version,
    workDir,
    mergeAcceptedPr: async () => { merged = true; throw new Error('unreachable'); },
    liveVerification: async () => { throw new Error('unreachable'); },
    notifyDingTalk: async () => ({ messageId: 'unreachable' }),
  },
}, {
  taskId: ${JSON.stringify(verifyFailTask)},
  currentEvent,
  freshReviewRef: 'TEP-51',
  vaultRoot,
  plugin: {
    pluginDir: ${JSON.stringify(join(pluginRoot, 'plugins', 'r5-plugin'))},
    backupRoot: ${JSON.stringify(join(pluginRoot, 'r5-backups'))},
  },
});
const task = await ctx.tasks.get(${JSON.stringify(verifyFailTask)});
console.log(JSON.stringify({ outcome, merged, taskStatus: task.status }));
`,
  );
  check(r5.outcome.receipt.status === 'verification_failed', `R5: status ${r5.outcome.receipt.status}`);
  check(r5.merged === false && r5.outcome.receipt.merge === null, 'R5: no merge on a failed suite');
  check(r5.outcome.receipt.plugin === null, 'R5: no plugin install on a failed suite');
  check(r5.outcome.receipt.verification.commands.at(-1).command.includes('typecheck'), 'R5: suite stopped at the failing command');
  check(r5.taskStatus === 'review', 'R5: task stays in review');
  steps.push({
    command: 'service level: release operator with a failing fixed command',
    exitCode: 0,
    expectation: 'verification_failed before merge/install',
    observed: r5,
  });

  // R6 — rollback drill: a failed live verification restores the backed-up
  // plugin byte-for-byte and keeps the rolled_back receipt.
  const rollbackTask = 'task-20260821-rels0005';
  const rollbackIssue = await seedLinkedIssue(rollbackTask, 306, []);
  await writeTask(rollbackTask, rollbackIssue.id, 306, {
    actionRequestLines: handledApproveLines(rollbackTask, 'evt-rc-roll01', 'stream-approve-0005'),
  });
  const rollbackTaskPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${rollbackTask}.md`);
  await writeFile(rollbackTaskPath, (await readFile(rollbackTaskPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');
  const rollbackPluginDir = join(pluginRoot, 'plugins', 'r6-plugin');
  await mkdir(rollbackPluginDir, { recursive: true });
  await writeFile(join(rollbackPluginDir, 'manifest.json'), `${JSON.stringify({ id: 'agent-task-loop', version: '0.8.0' })}\n`);
  await writeFile(join(rollbackPluginDir, 'main.js'), 'pre-install main bytes');

  const r6 = await runServiceScenario(
    'r6-rollback-drill',
    rcEventPayload(rollbackTask, 'evt-rc-roll01', '2026-08-21T01:00:00.000Z'),
    `{
      run: async (argv) => ({
        command: argv.join(' '),
        exitCode: 0,
        stdout: argv[1] === 'rev-parse' ? ${JSON.stringify(headSha)} : argv[1] === 'status' ? '' : 'ok',
        stderr: '',
        durationMs: 1,
      }),
    }`,
    `
const pluginDir = ${JSON.stringify(rollbackPluginDir)};
const outcome = await runReleaseOperator(ctx, {
  ledger,
  invalidations,
  projectionMarkers,
  connector,
  ports: {
    verificationRunner,
    nodeVersion: process.version,
    workDir,
    mergeAcceptedPr: async () => ({
      repository: ${JSON.stringify(REPOSITORY)},
      pr: ${JSON.stringify(PR_REF)},
      headSha: ${JSON.stringify(headSha)},
      mergeSha: 'f'.repeat(40),
      prStatus: 'merged',
      issueStatus: 'closed',
    }),
    liveVerification: async () => ({
      canaryTaskId: 'task-20260821-canary01',
      multicaIssueId: ${JSON.stringify(canaryIssue.id)},
      multicaRunId: null,
      dingTalkMessageId: null,
      dingTalkStreamEventId: null,
      passed: false,
      summary: 'synthetic live loop failed after install',
    }),
    notifyDingTalk: async () => ({ messageId: 'unreachable' }),
  },
}, {
  taskId: ${JSON.stringify(rollbackTask)},
  currentEvent,
  freshReviewRef: 'TEP-51',
  vaultRoot,
  plugin: {
    pluginDir,
    backupRoot: ${JSON.stringify(join(pluginRoot, 'r6-backups'))},
  },
});
const mainAfterRollback = await readFile(join(pluginDir, 'main.js'), 'utf8');
console.log(JSON.stringify({
  status: outcome.receipt.status,
  rejectionReason: outcome.receipt.rejectionReason,
  rollbackFiles: outcome.receipt.plugin.rollback.restoredFiles.map((file) => file.path),
  mainAfterRollback,
}));
`,
  );
  check(r6.status === 'rolled_back', `R6: status ${r6.status}`);
  check(r6.rollbackFiles.includes('main.js'), 'R6: rollback restored main.js');
  check(r6.mainAfterRollback === 'pre-install main bytes', 'R6: plugin restored byte-for-byte');
  steps.push({
    command: 'service level: rollback drill after a failed live verification',
    exitCode: 0,
    expectation: 'rolled_back receipt + byte-equal plugin restore',
    observed: r6,
  });

  // R9 — triple post-passed failure (CR2 TEP-55 sole P1): the passed receipt
  // is durable, then the task projection fails, the rollback source fails
  // WITHOUT touching the installed bytes, and the terminal rolled_back
  // ledger overwrite fails too. The ledger still says passed and the plugin
  // still hashes to the receipt — only the invalidation record (a durable
  // store independent of the receipt ledger) can keep the next replay from
  // projecting the review task done.
  const invalidationTask = 'task-20260821-rels0006';
  const invalidationIssue = await seedLinkedIssue(invalidationTask, 307, []);
  await writeTask(invalidationTask, invalidationIssue.id, 307, {
    actionRequestLines: handledApproveLines(invalidationTask, 'evt-rc-inv01', 'stream-approve-0006'),
  });
  const invalidationTaskPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${invalidationTask}.md`);
  await writeFile(invalidationTaskPath, (await readFile(invalidationTaskPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');
  const invalidationPluginDir = join(pluginRoot, 'plugins', 'r9-plugin');
  await mkdir(invalidationPluginDir, { recursive: true });
  await writeFile(join(invalidationPluginDir, 'manifest.json'), `${JSON.stringify({ id: 'agent-task-loop', version: '0.8.0' })}\n`);
  await writeFile(join(invalidationPluginDir, 'main.js'), 'pre-install main bytes');
  const r9BackupRoot = join(pluginRoot, 'r9-backups');

  const r9 = await runServiceScenario(
    'r9-triple-post-passed-failure',
    rcEventPayload(invalidationTask, 'evt-rc-inv01', '2026-08-21T01:00:00.000Z'),
    `{
      run: async (argv) => ({
        command: argv.join(' '),
        exitCode: 0,
        stdout: argv[1] === 'rev-parse' ? ${JSON.stringify(headSha)} : argv[1] === 'status' ? '' : 'ok',
        stderr: '',
        durationMs: 1,
      }),
    }`,
    `
const { readdir, rm } = await import('node:fs/promises');
const pluginDir = ${JSON.stringify(invalidationPluginDir)};
const backupRoot = ${JSON.stringify(r9BackupRoot)};
const passingPorts = {
  verificationRunner,
  nodeVersion: process.version,
  workDir,
  mergeAcceptedPr: async () => ({
    repository: ${JSON.stringify(REPOSITORY)},
    pr: ${JSON.stringify(PR_REF)},
    headSha: ${JSON.stringify(headSha)},
    mergeSha: 'e'.repeat(40),
    prStatus: 'merged',
    issueStatus: 'closed',
  }),
  liveVerification: async () => ({
    canaryTaskId: 'task-20260821-canary01',
    multicaIssueId: ${JSON.stringify(canaryIssue.id)},
    multicaRunId: null,
    dingTalkMessageId: null,
    dingTalkStreamEventId: null,
    passed: true,
    summary: 'canary projected its terminal event and read back every system',
  }),
  notifyDingTalk: async () => ({ messageId: 'release-notice-stub-inv' }),
};
const releaseInput = {
  taskId: ${JSON.stringify(invalidationTask)},
  currentEvent,
  freshReviewRef: 'TEP-51',
  vaultRoot,
  plugin: {
    pluginDir,
    backupRoot,
  },
};
// Failure 1 of 3 — task store: the done projection cannot land; it first
// destroys the rollback source so the drill cannot restore a single byte.
const rejectingTasks = new Proxy(ctx.tasks, {
  get(target, property) {
    if (property === 'save') {
      return async (task) => {
        if (task.status === 'done') {
          for (const entry of await readdir(backupRoot)) {
            await rm(join(backupRoot, entry), { recursive: true, force: true });
          }
          throw new Error('task store locked');
        }
        return target.save(task);
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
// Failure 3 of 3 — terminal ledger save: the passed save lands, the
// rolled_back overwrite does not.
const terminalSaveFailingLedger = {
  get: (acceptanceId) => ledger.get(acceptanceId),
  list: () => ledger.list(),
  save: (receipt) => {
    if (receipt.status === 'rolled_back') {
      throw new Error('ledger disk full on overwrite');
    }
    return ledger.save(receipt);
  },
};
const outcome = await runReleaseOperator({ ...ctx, tasks: rejectingTasks }, {
  ledger: terminalSaveFailingLedger,
  invalidations,
  projectionMarkers,
  connector,
  ports: passingPorts,
}, releaseInput);
const acceptanceId = outcome.receipt.acceptanceId;
const ledgerRow = await ledger.get(acceptanceId);
// Durable terminal evidence must read back through a FRESH store instance.
const freshInvalidations = new FileReleaseInvalidationLedger(join(vaultRoot, '.atl-runtime'));
const record = await freshInvalidations.get(acceptanceId);
const mainBytes = await readFile(join(pluginDir, 'main.js'), 'utf8');
const buildMainBytes = await readFile(join(workDir, 'apps', 'agent-task-loop', 'build', 'obsidian-plugin', 'main.js'), 'utf8');
const replay = await runReleaseOperator(ctx, {
  ledger,
  invalidations: freshInvalidations,
  projectionMarkers,
  connector,
  ports: passingPorts,
}, releaseInput);
const task = await ctx.tasks.get(${JSON.stringify(invalidationTask)});
console.log(JSON.stringify({
  status: outcome.receipt.status,
  reason: outcome.receipt.rejectionReason,
  ledgerStatus: ledgerRow === null ? null : ledgerRow.status,
  mainBytes,
  buildMainBytes,
  invalidation: record,
  replayStatus: replay.status,
  replayReason: replay.status === 'rejected' ? replay.reason : null,
  taskStatus: task.status,
}));
`,
  );
  check(r9.status === 'rolled_back', `R9: status ${r9.status}`);
  check(
    r9.reason.includes('final task projection') && r9.reason.includes('rollback drill failed'),
    `R9: both failures reach the terminal reason (${r9.reason?.slice(0, 160)})`,
  );
  check(r9.ledgerStatus === 'passed', 'R9: the stale passed receipt is still the durable ledger row');
  check(r9.mainBytes === r9.buildMainBytes, 'R9: installed bytes unchanged — the receipt hashes still match');
  check(
    r9.invalidation !== null
      && r9.invalidation.terminalStatus === 'rolled_back'
      && r9.invalidation.reason.includes('final task projection')
      && r9.invalidation.rollbackRestoredFiles === null
      && r9.invalidation.rollbackFailureNote !== null,
    'R9: durable terminal evidence reads back from the independent invalidation store',
  );
  check(r9.replayStatus === 'rejected', `R9: replay rejects the invalidated passed receipt (${r9.replayStatus})`);
  check(r9.taskStatus === 'review', 'R9: the task stays non-done after the replay attempt');
  steps.push({
    command: 'service level: triple post-passed failure (task store + rollback source + terminal ledger)',
    exitCode: 0,
    expectation: 'stale passed receipt stranded; independent invalidation record read back; replay rejected; task non-done',
    observed: r9,
  });

  // R10 — the four-way post-passed failure (CR3 TEP-56 sole P1): the CR2
  // triple failure PLUS the invalidation record write failing too. Every
  // durable invalidation signal is gone — the ledger still says passed, the
  // installed plugin still hashes to the receipt, and the invalidation store
  // reads back clean and empty. Only the write-ahead projection marker
  // (armed BEFORE the passed receipt persisted, resolved only after a
  // confirmed done projection) keeps the next healthy replay from
  // projecting the review task done.
  const fourWayTask = 'task-20260821-rels0007';
  const fourWayIssue = await seedLinkedIssue(fourWayTask, 308, []);
  await writeTask(fourWayTask, fourWayIssue.id, 308, {
    actionRequestLines: handledApproveLines(fourWayTask, 'evt-rc-four01', 'stream-approve-0007'),
  });
  const fourWayTaskPath = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${fourWayTask}.md`);
  await writeFile(fourWayTaskPath, (await readFile(fourWayTaskPath, 'utf8')).replace('status: agent_executable', 'status: review'), 'utf8');
  const fourWayPluginDir = join(pluginRoot, 'plugins', 'r10-plugin');
  await mkdir(fourWayPluginDir, { recursive: true });
  await writeFile(join(fourWayPluginDir, 'manifest.json'), `${JSON.stringify({ id: 'agent-task-loop', version: '0.8.0' })}\n`);
  await writeFile(join(fourWayPluginDir, 'main.js'), 'pre-install main bytes');
  const fourWayBackupRoot = join(pluginRoot, 'r10-backups');

  const r10 = await runServiceScenario(
    'r10-four-way-post-passed-failure',
    rcEventPayload(fourWayTask, 'evt-rc-four01', '2026-08-21T01:00:00.000Z'),
    `{
      run: async (argv) => ({
        command: argv.join(' '),
        exitCode: 0,
        stdout: argv[1] === 'rev-parse' ? ${JSON.stringify(headSha)} : argv[1] === 'status' ? '' : 'ok',
        stderr: '',
        durationMs: 1,
      }),
    }`,
    `
const { readdir, rm } = await import('node:fs/promises');
const pluginDir = ${JSON.stringify(fourWayPluginDir)};
const backupRoot = ${JSON.stringify(fourWayBackupRoot)};
const passingPorts = {
  verificationRunner,
  nodeVersion: process.version,
  workDir,
  mergeAcceptedPr: async () => ({
    repository: ${JSON.stringify(REPOSITORY)},
    pr: ${JSON.stringify(PR_REF)},
    headSha: ${JSON.stringify(headSha)},
    mergeSha: 'e'.repeat(40),
    prStatus: 'merged',
    issueStatus: 'closed',
  }),
  liveVerification: async () => ({
    canaryTaskId: 'task-20260821-canary01',
    multicaIssueId: ${JSON.stringify(canaryIssue.id)},
    multicaRunId: null,
    dingTalkMessageId: null,
    dingTalkStreamEventId: null,
    passed: true,
    summary: 'canary projected its terminal event and read back every system',
  }),
  notifyDingTalk: async () => ({ messageId: 'release-notice-stub-fourway' }),
};
const releaseInput = {
  taskId: ${JSON.stringify(fourWayTask)},
  currentEvent,
  freshReviewRef: 'TEP-51',
  vaultRoot,
  plugin: {
    pluginDir,
    backupRoot,
  },
};
// Failure 1 of 4 — task store: the done projection cannot land; it first
// destroys the rollback source so the drill cannot restore a single byte
// (failure 2 of 4) without touching the installed bytes.
const rejectingTasks = new Proxy(ctx.tasks, {
  get(target, property) {
    if (property === 'save') {
      return async (task) => {
        if (task.status === 'done') {
          for (const entry of await readdir(backupRoot)) {
            await rm(join(backupRoot, entry), { recursive: true, force: true });
          }
          throw new Error('task store locked');
        }
        return target.save(task);
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
// Failure 3 of 4 — terminal ledger save: the passed save lands, the
// rolled_back overwrite does not.
const terminalSaveFailingLedger = {
  get: (acceptanceId) => ledger.get(acceptanceId),
  list: () => ledger.list(),
  save: (receipt) => {
    if (receipt.status === 'rolled_back') {
      throw new Error('ledger disk full on overwrite');
    }
    return ledger.save(receipt);
  },
};
// Failure 4 of 4 — invalidation record: the independent CR2 fallback write
// fails as well, so the store reads back clean and empty.
const failingInvalidations = {
  get: (acceptanceId) => invalidations.get(acceptanceId),
  record: async () => {
    throw new Error('invalidation disk full');
  },
};
const outcome = await runReleaseOperator({ ...ctx, tasks: rejectingTasks }, {
  ledger: terminalSaveFailingLedger,
  invalidations: failingInvalidations,
  projectionMarkers,
  connector,
  ports: passingPorts,
}, releaseInput);
const acceptanceId = outcome.receipt.acceptanceId;
const ledgerRow = await ledger.get(acceptanceId);
// Every fallback must read back through FRESH store instances.
const freshInvalidations = new FileReleaseInvalidationLedger(join(vaultRoot, '.atl-runtime'));
const freshMarkers = new FileReleaseProjectionMarkerStore(join(vaultRoot, '.atl-runtime'));
const invalidationRecord = await freshInvalidations.get(acceptanceId);
const marker = await freshMarkers.get(acceptanceId);
const mainBytes = await readFile(join(pluginDir, 'main.js'), 'utf8');
const buildMainBytes = await readFile(join(workDir, 'apps', 'agent-task-loop', 'build', 'obsidian-plugin', 'main.js'), 'utf8');
const replay = await runReleaseOperator(ctx, {
  ledger,
  invalidations: freshInvalidations,
  projectionMarkers: freshMarkers,
  connector,
  ports: passingPorts,
}, releaseInput);
const task = await ctx.tasks.get(${JSON.stringify(fourWayTask)});
console.log(JSON.stringify({
  status: outcome.receipt.status,
  reason: outcome.receipt.rejectionReason,
  ledgerStatus: ledgerRow === null ? null : ledgerRow.status,
  mainBytes,
  buildMainBytes,
  invalidationRecord,
  marker,
  replayStatus: replay.status,
  replayReason: replay.status === 'rejected' ? replay.reason : null,
  taskStatus: task.status,
}));
`,
  );
  check(r10.status === 'rolled_back', `R10: status ${r10.status}`);
  check(
    r10.reason.includes('final task projection')
      && r10.reason.includes('invalidation record save failed')
      && r10.reason.includes('rollback drill failed'),
    `R10: all failures reach the terminal reason (${r10.reason?.slice(0, 200)})`,
  );
  check(r10.ledgerStatus === 'passed', 'R10: the stale passed receipt is still the durable ledger row');
  check(r10.mainBytes === r10.buildMainBytes, 'R10: installed bytes unchanged — the receipt hashes still match');
  check(r10.invalidationRecord === null, 'R10: the invalidation store reads back EMPTY — the four-way lie');
  check(
    r10.marker !== null
      && r10.marker.state === 'pending'
      && r10.marker.projectedAt === null,
    'R10: the write-ahead projection marker survives PENDING through a fresh store read',
  );
  check(r10.replayStatus === 'rejected', `R10: healthy replay rejects on the pending marker (${r10.replayStatus})`);
  check(
    (r10.replayReason ?? '').includes('still pending'),
    `R10: rejection names the unresolved projection marker (${r10.replayReason?.slice(0, 120)})`,
  );
  check(r10.taskStatus === 'review', 'R10: the task stays non-done after the replay attempt');
  steps.push({
    command: 'service level: four-way post-passed failure (task store + rollback source + terminal ledger + invalidation write)',
    exitCode: 0,
    expectation: 'every invalidation signal gone; pending write-ahead marker survives and reads back; healthy replay rejected; task non-done',
    observed: r10,
  });

  // R7 — the real release through the real CLI: the REAL fixed suite runs on
  // the candidate worktree at the accepted head SHA.
  if (skipRealRelease) {
    process.stdout.write('skip-real-release mode: stopped before R7/R8\n');
  }
  // T3.1 baseline: the receipt must land through issue METADATA — the issue's
  // comment and run counts may not move across the release.
  const storeBeforeRelease = await readStore();
  const beforeReleaseSummary = issueStoreSummary(storeBeforeRelease, mainIssue.id);
  const r7 = skipRealRelease
    ? null
    : await atl(releaseArgs, 'real fixed verification + merge + backup/install + canary + receipts + done');
  if (!skipRealRelease) {
    check(
      r7.status === 'released' && r7.receipt.status === 'passed',
      `R7: outcome ${JSON.stringify({
        status: r7.status,
        receiptStatus: r7.receipt?.status,
        rejectionReason: r7.receipt?.rejectionReason,
        verification: r7.receipt?.verification,
      }).slice(0, 4_000)}`,
    );
    check(r7.receipt.verification.headCheck.matched === true, 'R7: worktree head equals the accepted SHA');
    check(
      r7.receipt.verification.commands.map((command) => command.command).join(' | ').includes('verify:v0.2-loop')
        && r7.receipt.verification.commands.every((command) => command.exitCode === 0),
      'R7: every fixed command passed',
    );
    const buildManifest = JSON.parse(await readFile(join(pluginDirs.buildDir, 'manifest.json'), 'utf8'));
    check(r7.receipt.plugin.install.version === buildManifest.version, 'R7: plugin version read back');
    check(r7.receipt.plugin.rollback === null, 'R7: no rollback on the passing path');
    check(r7.receipt.readBack.atl.taskStatus === 'done', 'R7: ATL read-back shows done');
    check(r7.receipt.readBack.dingtalk.messageId.startsWith('release-notice-stub-'), 'R7: DingTalk stub notice read back');

    const storeAfterRelease = await readStore();
    const mainIssueAfterRelease = storeAfterRelease.issues
      .find((issue) => issue.id === mainIssue.id);
    const mainSummary = issueStoreSummary(storeAfterRelease, mainIssue.id);
    // T3.1: the receipt went through the trusted metadata channel — no
    // comment was added, no run was created, and the controlled key reads
    // back the exact versioned receipt reference.
    check(
      mainSummary.comments === beforeReleaseSummary.comments,
      `R7: release added no comment (${beforeReleaseSummary.comments} -> ${mainSummary.comments})`,
    );
    check(
      mainSummary.runs === beforeReleaseSummary.runs,
      `R7: release created no run (${beforeReleaseSummary.runs} -> ${mainSummary.runs})`,
    );
    check(
      (mainIssueAfterRelease.comments ?? []).every(
        (comment) => !comment.body.includes('[ATL_RELEASE_RECEIPT'),
      ),
      'R7: no release receipt marker comment exists',
    );
    check(
      r7.receipt.readBack.multica.receiptMetadataKey === 'atl_release_receipt',
      'R7: receipt read-back names the controlled metadata key',
    );
    const receiptMetadataValue = mainIssueAfterRelease.metadata?.atl_release_receipt;
    check(typeof receiptMetadataValue === 'string', 'R7: release receipt metadata key present');
    check(
      receiptMetadataValue === r7.receipt.readBack.multica.receiptMetadataValue,
      'R7: receipt metadata value read back exactly',
    );
    const receiptReference = JSON.parse(receiptMetadataValue);
    check(
      receiptReference.schema_version === 1
        && receiptReference.receipt_id === r7.receipt.receiptId
        && typeof receiptReference.body === 'string',
      'R7: metadata value is a versioned receipt reference',
    );
    const installedMain = await readFile(join(pluginDirs.pluginDir, 'main.js'), 'utf8');
    const buildMain = await readFile(join(pluginDirs.buildDir, 'main.js'), 'utf8');
    check(installedMain === buildMain, 'R7: installed plugin bytes are the build bytes');
    const backupDirReceipt = r7.receipt.plugin.backup;
    check(backupDirReceipt.files.length >= 2, 'R7: pre-install plugin files were backed up');

    // The released task moved to Archive and carries the completed remote state.
    const releasedRaw = await readTaskFileAnyStatus(mainTask);
    check(releasedRaw !== null && /status: done/.test(releasedRaw), 'R7: released task is done');
    check(/remote_state: completed/.test(releasedRaw), 'R7: execution link completed');

    // R8 — replay: the passed acceptance replays without a second receipt
    // write and without re-running the fixed suite.
    const beforeReplaySummary = issueStoreSummary(await readStore(), mainIssue.id);
    const metadataBeforeReplay = JSON.stringify(mainIssueAfterRelease.metadata);
    const r8 = await atl(releaseArgs, 'passed acceptance replays from the ledger');
    check(r8.status === 'replayed' && r8.receipt.status === 'passed', `R8: outcome ${r8.status}`);
    const storeAfterReplay = await readStore();
    const replaySummary = issueStoreSummary(storeAfterReplay, mainIssue.id);
    check(replaySummary.comments === beforeReplaySummary.comments, 'R8: replay added no comment');
    check(replaySummary.runs === beforeReplaySummary.runs, 'R8: replay created no run');
    const issueAfterReplay = storeAfterReplay.issues.find((issue) => issue.id === mainIssue.id);
    check(
      JSON.stringify(issueAfterReplay.metadata) === metadataBeforeReplay,
      'R8: replay left the receipt metadata byte-identical',
    );
  }

  const receipts = await readLedger('multica-release-receipts.json');
  check(
    (receipts?.receipts ?? []).every((receipt) => ['passed', 'stale_rejected', 'verification_failed', 'rolled_back'].includes(receipt.status)),
    'every persisted receipt is terminal and schema-valid',
  );
  const invalidationLedgerFile = await readLedger('multica-release-invalidations.json');
  check(
    (invalidationLedgerFile?.records ?? []).length === 1
      && invalidationLedgerFile.records[0].terminalStatus === 'rolled_back',
    'the independent invalidation ledger holds exactly the R9 terminal record',
  );
  const projectionMarkerFile = await readLedger('multica-release-projection-markers.json');
  const persistedMarkers = projectionMarkerFile?.markers ?? [];
  check(
    persistedMarkers.filter((marker) => marker.state === 'pending').length === 2,
    'the write-ahead projection marker store holds exactly the two unresolved R9/R10 markers',
  );
  if (!skipRealRelease) {
    check(
      persistedMarkers.some((marker) => marker.state === 'projected' && marker.projectedAt !== null),
      'the R7 real release resolved its marker only after the confirmed projection',
    );
  }

  const receipt = {
    schema_version: 1,
    task: 'PAW-GOAL-003-T3',
    kind: 'synthetic_release_readback_receipt',
    head_sha: headSha,
    workdir: workDir,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    vault_root: vaultRoot,
    fake_multica_store: fakeStorePath,
    plugin_dirs: pluginDirs,
    delivery: 'stubbed DingTalk notice; merge/live evidence files; real fixed verification suite',
    steps,
    assertions: {
      r1_rc_projection_and_approve: 'RC event projected review + pending approve; trusted approve reached release_operator_started; task stayed in review',
      r2_live_canary: 'linked canary consumed a terminal completed event and stayed in review — Multica done alone never completes ATL',
      r3_stale_event: 'newer current RC event rejected the acceptance as stale with zero verification commands and the task untouched',
      r4_head_sha_mismatch: 'drifted worktree head recorded mismatched=false, zero fixed commands, stale_rejected',
      r5_verification_failure: 'failing fixed command stopped the release before merge and install; task stayed in review',
      r6_rollback_drill: 'failed live verification restored the backed-up plugin byte-for-byte and kept the rolled_back receipt',
      r9_triple_post_passed_failure: 'passed receipt stranded by task-store + rollback-source + terminal-ledger failures; the independent invalidation record survived and read back; replay rejected the invalidated receipt; the task stayed non-done',
      r10_four_way_post_passed_failure: 'invalidation write failed too — every invalidation signal gone; the write-ahead projection marker stayed pending, read back through a fresh store, and the healthy replay was rejected; the task stayed non-done',
      r7_real_release: skipRealRelease
        ? 'SKIPPED (--skip-real-release smoke mode)'
        : `real fixed suite (${r7.receipt.verification.commands.length} commands) passed on the candidate; merge read-back, backup, install, canary, receipt metadata write (comments and runs unchanged), stub notice, task done, four-system read-back complete`,
      r8_replay: skipRealRelease
        ? 'SKIPPED (--skip-real-release smoke mode)'
        : 'replayed the passed receipt without a second receipt write or a second suite run; comments, runs and metadata byte-identical',
    },
  };

  if (receiptPath !== null) {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`receipt written: ${receiptPath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
} finally {
  if (process.env.PAW_T3_KEEP_VAULTS === '1') {
    process.stdout.write(`vault kept: ${vaultRoot}\nfixture kept: ${fixtureRoot}\n`);
  } else {
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
