#!/usr/bin/env node
// PAW-GOAL-003 T2 synthetic action-roundtrip receipt (Task Contract artifact):
// drives the real ATL CLI (`multica ingest`, `multica reply`, `multica
// responses`) against a temp vault and the stateful fake Multica CLI, plus a
// stubbed DingTalk delivery that only captures the notification draft. No real
// Multica write, no real DingTalk message. Scenarios:
//   S1 event ingestion: a versioned needs_decision comment projects the task
//      with a pending action_request; a natural-language comment and a
//      wrong-task event never advance it; the stable-key notification draft
//      and message-id read-back are captured by the stub delivery.
//   S2 trusted reply: one DingTalk reply walks received -> atl_recorded ->
//      remote_response_confirmed -> supervisor_resumed; exactly one marker
//      comment (threaded on the event comment) and exactly one new run.
//   S3 crash replay: replaying the same stream event and re-running the
//      response continuation adds no second comment and no second run.
//   S4 untrusted reply: a foreign sender is rejected with zero remote writes.
//   S5 blocked event: recoverable blocked event ingests to blocked; a legal
//      rework reply returns the task to agent_executable and resumes.
//   S6 crash boundary (CR fix 2): the run dies between the task save and the
//      audit/ledger writes — the handled action_request carries the durable
//      stream-event marker, so the real reply command heals the ledger
//      without invalid_action and honors the no-rerun terminal step.
//   S7 run read-back failure (CR fix 3): a failed pre-comment runs read-back
//      stays remote_write_unknown with zero remote writes; the next real
//      reply reconciles the baseline and completes with one comment + run.
//   S8 supersession between crash and retry (TEP-50 fix 1): after the S6-style
//      crash, a NEWER event is ingested and replaces the handled request —
//      the retained handled_action_requests history keeps the evidence, and
//      the real reply heals the ORIGINAL stream event exactly once.
//   S9 uncertain comment confirmation (TEP-50 fix 2): the response comment
//      lands and triggers one run, but its confirmation is lost — the
//      persisted pre-comment baseline makes the retry find the marker, adopt
//      the triggered run, and trigger ZERO duplicate reruns.
// Usage: node scripts/run-multica-roundtrip-synthetic.mjs [--receipt <path>]
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

const args = process.argv.slice(2);
const receiptIndex = args.indexOf('--receipt');
const receiptPath = receiptIndex >= 0 ? args[receiptIndex + 1] : null;

const vaultRoot = await mkdtemp(join(tmpdir(), 'paw-t2-roundtrip-'));
const fixtureRoot = await mkdtemp(join(tmpdir(), 'paw-t2-fixture-'));
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
        ATL_DINGTALK_TRUSTED_SENDER_ID: TRUSTED_SENDER,
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: TRUSTED_CONVERSATION,
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

function runWithStdin(command, commandArgs, stdinPayload, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: appRoot,
      env: {
        ...process.env,
        ATL_VAULT_ROOT: vaultRoot,
        ATL_MULTICA_BINARY: join(appRoot, 'scripts', 'fake-multica-cli.mjs'),
        FAKE_MULTICA_STORE: fakeStorePath,
        ATL_DINGTALK_TRUSTED_SENDER_ID: TRUSTED_SENDER,
        ATL_DINGTALK_TRUSTED_CONVERSATION_ID: TRUSTED_CONVERSATION,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinPayload, 'utf8');
  });
}

async function atl(commandArgs, expectation) {
  const result = await run(process.execPath, [tsxPath, cliPath, ...commandArgs, '--json']);
  const step = { command: `pnpm atl ${commandArgs.join(' ')}`, exitCode: result.code };
  check(result.code === 0, `${step.command} failed (${result.code}): ${result.stderr}`);
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
  const step = {
    command: `pnpm atl multica reply --stdin-json (event ${streamEventId}, sender ${senderUserId})`,
    exitCode: result.code,
  };
  check(result.code === 0, `${step.command} failed (${result.code}): ${result.stderr}`);
  step.observed = JSON.parse(result.stdout);
  steps.push(step);
  return step.observed;
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

function needsDecisionEvent(taskId, eventId, occurredAt, options) {
  return {
    schema_version: 1,
    event_id: eventId,
    atl_task_id: taskId,
    state: 'needs_decision',
    summary: '选择 synthetic canary 的恢复策略',
    decision: {
      question: '真实 Vault 写入前选择恢复策略',
      options: options ?? [
        { id: 'retry_with_fixture', label: '使用合成数据重试' },
        { id: 'pause_goal', label: '暂停本 Goal' },
      ],
    },
    recoverability: null,
    artifact_refs: [],
    release: null,
    occurred_at: occurredAt,
  };
}

function blockedEvent(taskId, eventId, occurredAt) {
  return {
    schema_version: 1,
    event_id: eventId,
    atl_task_id: taskId,
    state: 'blocked',
    summary: '外部依赖不可用，需要人工恢复',
    decision: null,
    recoverability: {
      recoverable: true,
      resume_condition: 'dependency restored',
      last_safe_step: 'dispatch linked',
    },
    artifact_refs: [],
    release: null,
    occurred_at: occurredAt,
  };
}

async function seedLinkedIssue(taskId, comments) {
  const store = await readStore();
  const issue = {
    id: randomUUID(),
    identifier: 'TEP-201',
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: `T2 synthetic ${taskId}`,
    description: `[ATL_TASK_ID:atl:${taskId}]\n\nT2 roundtrip fixture`,
    status: 'in_progress',
    metadata: { atl_task_id: `atl:${taskId}` },
    created_at: '2026-08-20T09:00:00.000Z',
    number: 201,
    comments,
    runs: [{ id: 'run-0001', status: 'completed' }],
  };
  store.issues.push(issue);
  store.nextNumber = Math.max(store.nextNumber ?? 100, 201);
  store.nextComment = (store.nextComment ?? 0) + comments.length;
  await writeStore(store);
  return issue.id;
}

function linkedTaskFrontmatter(taskId, issueId) {
  return [
    '---',
    'type: task',
    'schema_version: 1',
    `task_id: ${taskId}`,
    `title: 'T2 synthetic ${taskId}'`,
    'status: agent_executable',
    'review_state: confirmed',
    `project_id: ${PROJECT_ID}`,
    'task_type: development',
    'objective: Prove the human action roundtrip contract',
    'acceptance_criteria:',
    '  - One trusted reply reaches the original task exactly once',
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
    'execution_link:',
    '  schema_version: 1',
    '  provider: multica',
    `  idempotency_key: atl:${taskId}`,
    `  workspace_id: ${WORKSPACE_ID}`,
    `  project_id: ${PROJECT_ID}`,
    `  issue_id: ${issueId}`,
    "  issue_identifier: 'TEP-201'",
    '  dispatch_state: linked',
    '  remote_state: active',
    '  last_comment_id: null',
    '  last_event_id: null',
    '  summary: null',
    '  artifact_refs: []',
    "  last_attempt_at: '2026-08-20T09:00:00.000Z'",
    '  last_synced_at: null',
    '---',
    '',
    `Synthetic development task ${taskId} for PAW-GOAL-003 T2.`,
    '',
  ].join('\n');
}

async function writeTask(taskId, issueId) {
  const directory = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${taskId}.md`), linkedTaskFrontmatter(taskId, issueId), 'utf8');
}

async function readTask(taskId) {
  const path = join(vaultRoot, '10_Tasks', 'Active', PROJECT_ID, `${taskId}.md`);
  return readFile(path, 'utf8');
}

async function readLedger(name) {
  const path = join(vaultRoot, '.atl-runtime', name);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// The DingTalk leg is stubbed: this inline tsx program drives the real
// notifyMulticaAction service with an in-memory delivery that only captures
// the draft (Permissions: "测试默认 stub"), then prints the record + draft.
async function notificationDraft(taskId, title, eventId, state) {
  const program = `
import { join } from 'node:path';
import { notifyMulticaAction } from ${JSON.stringify(join(appRoot, 'src', 'services', 'notify-multica-action.js'))};
import { FileMulticaActionNotificationLedger } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'file-multica-action-notification-ledger.js'))};

const ledger = new FileMulticaActionNotificationLedger(join(${JSON.stringify(vaultRoot)}, '.atl-runtime'));
const delivery = {
  async send(message) {
    return { taskId: null, messageId: 'synthetic-ding-msg-0001' };
  },
};
const record = await notifyMulticaAction(
  { ledger, delivery, clock: () => new Date('2026-08-20T12:00:00.000Z') },
  {
    taskId: ${JSON.stringify(taskId)},
    taskTitle: ${JSON.stringify(title)},
    issueIdentifier: 'TEP-201',
    event: {
      schemaVersion: 1,
      eventId: ${JSON.stringify(eventId)},
      atlTaskId: ${JSON.stringify(taskId)},
      state: ${JSON.stringify(state)},
      summary: '选择 synthetic canary 的恢复策略',
      decision: {
        question: '真实 Vault 写入前选择恢复策略',
        options: [{ id: 'retry_with_fixture', label: '使用合成数据重试' }],
      },
      recoverability: null,
      artifactRefs: [],
      release: null,
      occurredAt: '2026-08-20T10:00:00.000Z',
    },
  },
);
console.log(JSON.stringify(record));
`;
  const programPath = join(fixtureRoot, 'notification-draft.mts');
  await writeFile(programPath, program, 'utf8');
  const result = await run(process.execPath, [tsxPath, programPath], {
    env: { ATL_VAULT_ROOT: vaultRoot },
  });
  check(result.code === 0, `notification draft failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// Shared prologue for the failure-injection programs: a real ServiceContext
// on the synthetic vault plus the real connector against the fake CLI.
function failureProgramPrologue() {
  return `
import { join } from 'node:path';
import { MulticaCliConnector } from ${JSON.stringify(join(appRoot, 'src', 'connectors', 'multica-cli-connector.js'))};
import { processMulticaReply } from ${JSON.stringify(join(appRoot, 'src', 'services', 'process-multica-reply.js'))};
import { FileMulticaResponseLedger } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'file-multica-response-ledger.js'))};
import { MarkdownTaskRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-task-repository.js'))};
import { MarkdownArtifactRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-artifact-repository.js'))};
import { MarkdownProjectRepository } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'markdown-project-repository.js'))};
import { FileAuditLog } from ${JSON.stringify(join(appRoot, 'src', 'storage', 'audit-log.js'))};
import { createTaskId } from ${JSON.stringify(join(appRoot, 'src', 'services', 'service-context.js'))};

const vaultRoot = ${JSON.stringify(vaultRoot)};
const runtimeRoot = join(vaultRoot, '.atl-runtime');
const ctx = {
  tasks: new MarkdownTaskRepository(vaultRoot),
  artifacts: new MarkdownArtifactRepository(vaultRoot),
  projects: new MarkdownProjectRepository(vaultRoot),
  audit: new FileAuditLog(vaultRoot, { timeZone: 'Asia/Shanghai' }),
  clock: () => new Date(),
  id: () => createTaskId(),
};
const connector = new MulticaCliConnector({
  binaryPath: ${JSON.stringify(join(appRoot, 'scripts', 'fake-multica-cli.mjs'))},
  profile: 'desktop-api.multica.ai',
  workspaceId: ${JSON.stringify(WORKSPACE_ID)},
  projectId: ${JSON.stringify(PROJECT_ID)},
  callTimeoutMs: 20_000,
});
const trustPolicy = {
  trustedSenderUserId: ${JSON.stringify(TRUSTED_SENDER)},
  trustedConversationId: ${JSON.stringify(TRUSTED_CONVERSATION)},
};
`;
}

const replyInputLiteral = (taskId, streamEventId, action) => `
const input = {
  streamEventId: ${JSON.stringify(streamEventId)},
  senderUserId: ${JSON.stringify(TRUSTED_SENDER)},
  conversationId: ${JSON.stringify(TRUSTED_CONVERSATION)},
  message: ${JSON.stringify(`${action} ${taskId}`)},
};
`;

// S6 (CR fix 2): inject a crash exactly at the reviewed boundary — the task
// save landed, then the process dies before BOTH the audit append and the
// ledger step save. The program reports the durable state it left behind.
async function crashAfterTaskSave(taskId, streamEventId, action) {
  const program = `${failureProgramPrologue()}
${replyInputLiteral(taskId, streamEventId, action)}
const realLedger = new FileMulticaResponseLedger(runtimeRoot);
const crashingLedger = Object.create(realLedger);
crashingLedger.save = async (record) => {
  if (record.step !== 'received') {
    throw new Error('simulated crash: process died after the task write');
  }
  return realLedger.save(record);
};
const realAudit = ctx.audit;
const failingAudit = Object.create(realAudit);
failingAudit.append = async (event) => {
  if (event.event === 'multica.action_recorded') {
    throw new Error('simulated crash: the audit append never ran');
  }
  return realAudit.append(event);
};
let threw = null;
try {
  await processMulticaReply({ ...ctx, audit: failingAudit }, {
    ledger: crashingLedger,
    connector,
    trustPolicy,
  }, input);
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
const task = await ctx.tasks.get(${JSON.stringify(taskId)});
const ledgerRecord = await realLedger.get(${JSON.stringify(streamEventId)});
const audits = await ctx.audit.listForTask(${JSON.stringify(taskId)});
console.log(JSON.stringify({
  threw,
  taskStatus: task.status,
  actionRequestStatus: task.actionRequest?.status ?? null,
  handledStreamEventId: task.actionRequest?.handledStreamEventId ?? null,
  handledTerminalStep: task.actionRequest?.handledTerminalStep ?? null,
  ledgerStep: ledgerRecord?.step ?? null,
  recordedAudits: audits.filter((event) => (
    event.event === 'multica.action_recorded'
    && event.details?.streamEventId === ${JSON.stringify(streamEventId)}
  )).length,
}));
`;
  const programPath = join(fixtureRoot, 'crash-after-task-save.mts');
  await writeFile(programPath, program, 'utf8');
  const result = await run(process.execPath, [tsxPath, programPath], {
    env: { ATL_VAULT_ROOT: vaultRoot },
  });
  check(result.code === 0, `S6 crash injection failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// S7 (CR fix 3): inject a failed pre-comment runs read-back and report the
// preserved remote_write_unknown outcome with zero remote writes.
async function runReadBackFailure(taskId, streamEventId, action) {
  const program = `${failureProgramPrologue()}
${replyInputLiteral(taskId, streamEventId, action)}
const flakyConnector = Object.create(connector);
flakyConnector.runIds = async () => {
  const error = new Error('read-back lost') as Error & { code?: string };
  (error as { code?: string }).code = 'multica_call_timed_out';
  throw error;
};
const ledger = new FileMulticaResponseLedger(runtimeRoot);
const outcome = await processMulticaReply(ctx, {
  ledger,
  connector: flakyConnector,
  trustPolicy,
}, input);
const record = await ledger.get(${JSON.stringify(streamEventId)});
console.log(JSON.stringify({
  status: outcome.status,
  reason: outcome.status === 'remote_write_unknown' ? outcome.reason : null,
  ledgerStep: record?.step ?? null,
  remoteWriteUnknown: record?.remoteWriteUnknown ?? null,
  responseCommentId: record?.responseCommentId ?? null,
}));
`;
  const programPath = join(fixtureRoot, 'run-read-back-failure.mts');
  await writeFile(programPath, program, 'utf8');
  const result = await run(process.execPath, [tsxPath, programPath], {
    env: { ATL_VAULT_ROOT: vaultRoot },
  });
  check(result.code === 0, `S7 read-back injection failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// S9 (TEP-50 fix 2): the response comment LANDS in the fake store, then its
// confirmation is lost — the runner throws after the add and again on the
// marker-scan heal, so appendResponse can only report remote_write_unknown.
async function uncertainCommentLanding(taskId, streamEventId, action) {
  const program = `${failureProgramPrologue()}
${replyInputLiteral(taskId, streamEventId, action)}
const fakeBinary = ${JSON.stringify(join(appRoot, 'scripts', 'fake-multica-cli.mjs'))};
const fakeStore = ${JSON.stringify(fakeStorePath)};
const passThroughRunner = async (request) => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fakeBinary, ...request.args], {
    env: { ...process.env, FAKE_MULTICA_STORE: fakeStore },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => undefined);
  child.stdin.end(request.stdin ?? '', 'utf8');
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    throw new Error('fake CLI exited with ' + exitCode + ': ' + stderr.slice(0, 200));
  }
  return { stdout, stderr };
};
let faultHealScan = false;
const faultingRunner = async (request) => {
  const args = request.args;
  if (args.includes('comment') && args.includes('add')) {
    await passThroughRunner(request);
    faultHealScan = true;
    throw new Error('simulated loss: comment confirmation lost after the write landed');
  }
  if (args.includes('comment') && args.includes('list') && faultHealScan) {
    faultHealScan = false;
    throw new Error('simulated loss: marker heal scan unavailable');
  }
  return passThroughRunner(request);
};
const faultConnector = new MulticaCliConnector({
  binaryPath: fakeBinary,
  profile: 'desktop-api.multica.ai',
  workspaceId: ${JSON.stringify(WORKSPACE_ID)},
  projectId: ${JSON.stringify(PROJECT_ID)},
  callTimeoutMs: 20_000,
  runner: faultingRunner,
});
const ledger = new FileMulticaResponseLedger(runtimeRoot);
const outcome = await processMulticaReply(ctx, {
  ledger,
  connector: faultConnector,
  trustPolicy,
}, input);
const record = await ledger.get(${JSON.stringify(streamEventId)});
console.log(JSON.stringify({
  status: outcome.status,
  reason: outcome.status === 'remote_write_unknown' ? outcome.reason : null,
  ledgerStep: record?.step ?? null,
  baselineRunIds: record?.baselineRunIds ?? null,
  runIds: record?.runIds ?? null,
  remoteWriteUnknown: record?.remoteWriteUnknown ?? null,
  responseCommentId: record?.responseCommentId ?? null,
}));
`;
  const programPath = join(fixtureRoot, 'uncertain-comment-landing.mts');
  await writeFile(programPath, program, 'utf8');
  const result = await run(process.execPath, [tsxPath, programPath], {
    env: { ATL_VAULT_ROOT: vaultRoot },
  });
  check(result.code === 0, `S9 uncertain-landing injection failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function appendEventComment(issueId, commentId, payload, createdAt) {
  const store = await readStore();
  const issue = store.issues.find((candidate) => candidate.id === issueId);
  check(issue !== undefined, `appendEventComment: issue ${issueId} missing`);
  issue.comments = [...(issue.comments ?? []), {
    id: commentId,
    parent_id: null,
    body: eventBody(payload),
    created_at: createdAt,
    author_type: 'agent',
  }];
  store.nextComment = (store.nextComment ?? 0) + 1;
  await writeStore(store);
}

// The landed comment triggered one remote supervisor run (the platform, not
// ATL, starts it) — seeded straight into the fake store.
async function appendTriggeredRun(issueId, runId) {
  const store = await readStore();
  const issue = store.issues.find((candidate) => candidate.id === issueId);
  check(issue !== undefined, `appendTriggeredRun: issue ${issueId} missing`);
  issue.runs = [...(issue.runs ?? []), { id: runId, status: 'queued' }];
  await writeStore(store);
}

function issueStoreSummary(store, issueId) {
  const issue = store.issues.find((candidate) => candidate.id === issueId);
  return {
    comments: issue?.comments?.length ?? 0,
    runs: issue?.runs?.length ?? 0,
  };
}

try {
  // S1 — versioned event projection with the notification stub.
  const s1Task = 'task-20260820-synr001';
  const s1Issue = await seedLinkedIssue(s1Task, [
    { id: 'cmt-0001', parent_id: null, body: '普通进度评论：今天完成了 schema 设计。', created_at: '2026-08-20T09:30:00.000Z', author_type: 'agent' },
    { id: 'cmt-0002', parent_id: null, body: eventBody(needsDecisionEvent(s1Task, 'evt-s1-0001', '2026-08-20T10:00:00.000Z')), created_at: '2026-08-20T10:00:00.000Z', author_type: 'agent' },
    { id: 'cmt-0003', parent_id: null, body: eventBody(needsDecisionEvent('task-20260820-other99', 'evt-s1-0002', '2026-08-20T10:05:00.000Z')), created_at: '2026-08-20T10:05:00.000Z', author_type: 'agent' },
  ]);
  await writeTask(s1Task, s1Issue);

  const s1 = await atl(['multica', 'ingest', '--task-id', s1Task], 'one projected event, natural language and wrong task rejected');
  check(s1.status === 'ingested', `S1: ingest status ${s1.status}`);
  const projected = s1.outcomes.filter((outcome) => outcome.action === 'projected');
  const rejected = s1.outcomes.filter((outcome) => outcome.action === 'rejected');
  check(projected.length === 1 && projected[0].eventId === 'evt-s1-0001', 'S1: exactly one projected event');
  check(rejected.some((outcome) => (outcome.reason ?? '').includes('task_mismatch')), 'S1: wrong-task event rejected');

  let rawTask = await readTask(s1Task);
  check(/status: waiting_for_decision/.test(rawTask), 'S1: task must be waiting_for_decision');
  check(/action_id: action:task-20260820-synr001:evt-s1-0001/.test(rawTask), 'S1: action_request projected');
  check(/select:retry_with_fixture/.test(rawTask), 'S1: option action listed');

  const draft = await notificationDraft(s1Task, `T2 synthetic ${s1Task}`, 'evt-s1-0001', 'needs_decision');
  check(draft.status === 'sent' && draft.messageId === 'synthetic-ding-msg-0001', 'S1: stub notification sent with read-back id');
  check(draft.idempotencyKey === `multica:${s1Task}:evt-s1-0001:needs_decision`, 'S1: stable notification key');
  check(draft.draftText.includes('select:retry_with_fixture'), 'S1: draft lists the legal action');

  // S2 — one trusted reply walks all four steps with one comment and one run.
  const before = await readStore();
  const beforeRuns = before.issues.find((issue) => issue.id === s1Issue)?.runs?.length ?? 0;
  const s2 = await atlReply('stream-syn-0001', TRUSTED_SENDER, `select:retry_with_fixture ${s1Task}`);
  check(s2.status === 'completed' && s2.step === 'supervisor_resumed', `S2: outcome ${s2.status}/${s2.step}`);
  rawTask = await readTask(s1Task);
  check(/status: agent_executable/.test(rawTask), 'S2: select returns the task to agent_executable');
  check(/status: handled/.test(rawTask), 'S2: action_request handled');

  let store = await readStore();
  const issue = store.issues.find((candidate) => candidate.id === s1Issue);
  const markerComments = (issue.comments ?? []).filter(
    (comment) => comment.body.includes('[ATL_RESPONSE:stream-syn-0001]'),
  );
  check(markerComments.length === 1, `S2: expected 1 marker comment, got ${markerComments.length}`);
  check(markerComments[0]?.parent_id === 'cmt-0002', 'S2: response threads on the event comment');
  check((issue.runs ?? []).length === beforeRuns + 1, 'S2: exactly one new run after rerun trigger');

  const s2Ledger = await readLedger('multica-responses.json');
  const s2Record = s2Ledger?.records?.find((record) => record.streamEventId === 'stream-syn-0001');
  check(s2Record?.step === 'supervisor_resumed', 'S2: ledger terminal step');
  check(s2Record?.responseCommentId === markerComments[0]?.id, 'S2: comment id read back into ledger');

  // S3 — crash replay: the same stream event cannot duplicate comment or run.
  const replay = await atlReply('stream-syn-0001', TRUSTED_SENDER, `select:retry_with_fixture ${s1Task}`);
  check(replay.status === 'completed', 'S3: replay is idempotent');
  const continuation = await atl(['multica', 'responses'], 'continuation finds nothing to do');
  check(continuation.processed === 0, 'S3: no mid-ledger replies remain');
  store = await readStore();
  const issueAfterReplay = store.issues.find((candidate) => candidate.id === s1Issue);
  check(
    (issueAfterReplay.comments ?? []).filter((comment) => comment.body.includes('[ATL_RESPONSE:stream-syn-0001]')).length === 1,
    'S3: still exactly one marker comment',
  );
  check((issueAfterReplay.runs ?? []).length === beforeRuns + 1, 'S3: still exactly one new run');

  // S4 — an untrusted sender is rejected without any remote write.
  const commentCountBefore = (issueAfterReplay.comments ?? []).length;
  const runCountBefore = (issueAfterReplay.runs ?? []).length;
  const s4 = await atlReply('stream-syn-0002', 'foreign-staff', `select:retry_with_fixture ${s1Task}`);
  check(s4.status === 'rejected' && s4.reason === 'untrusted_source', `S4: outcome ${s4.status}/${s4.reason}`);
  store = await readStore();
  const issueAfterUntrusted = store.issues.find((candidate) => candidate.id === s1Issue);
  check((issueAfterUntrusted.comments ?? []).length === commentCountBefore, 'S4: no comment written');
  check((issueAfterUntrusted.runs ?? []).length === runCountBefore, 'S4: no run triggered');

  // S5 — recoverable blocked event ingests to blocked; legal rework resumes.
  const s5Task = 'task-20260820-synr002';
  const s5Store = await readStore();
  const s5Issue = {
    id: randomUUID(),
    identifier: 'TEP-202',
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: `T2 synthetic ${s5Task}`,
    description: `[ATL_TASK_ID:atl:${s5Task}]\n\nT2 roundtrip fixture`,
    status: 'in_progress',
    metadata: { atl_task_id: `atl:${s5Task}` },
    created_at: '2026-08-20T09:00:00.000Z',
    number: 202,
    comments: [
      { id: 'cmt-0101', parent_id: null, body: eventBody(blockedEvent(s5Task, 'evt-s5-0001', '2026-08-20T11:00:00.000Z')), created_at: '2026-08-20T11:00:00.000Z', author_type: 'agent' },
    ],
    runs: [{ id: 'run-0101', status: 'completed' }],
  };
  s5Store.issues.push(s5Issue);
  s5Store.nextComment = (s5Store.nextComment ?? 0) + 1;
  await writeStore(s5Store);
  await writeTask(s5Task, s5Issue.id);

  const s5Ingest = await atl(['multica', 'ingest', '--task-id', s5Task], 'blocked event projects to blocked');
  check(s5Ingest.outcomes.some((outcome) => outcome.action === 'projected' && outcome.state === 'blocked'), 'S5: blocked projected');
  rawTask = await readTask(s5Task);
  check(/status: blocked/.test(rawTask), 'S5: task blocked');

  const s5Reply = await atlReply('stream-syn-0003', TRUSTED_SENDER, `rework ${s5Task}`);
  check(s5Reply.status === 'completed' && s5Reply.step === 'supervisor_resumed', `S5: outcome ${s5Reply.status}/${s5Reply.step}`);
  rawTask = await readTask(s5Task);
  check(/status: agent_executable/.test(rawTask), 'S5: rework returns the task to agent_executable');

  // S6 — CR fix 2 failure injection: crash between the task save and the
  // audit/ledger writes, then heal through the real reply command. The seed
  // timestamp must sit inside the overlap window, which is anchored to the
  // real clock of the earlier ingests.
  const s6At = new Date().toISOString();
  await appendEventComment(
    s1Issue,
    'cmt-0201',
    needsDecisionEvent(s1Task, 'evt-s6-0001', s6At),
    s6At,
  );
  const s6Ingest = await atl(['multica', 'ingest', '--task-id', s1Task], 'fresh pending request for the crash boundary');
  check(s6Ingest.outcomes.some((outcome) => outcome.action === 'projected' && outcome.eventId === 'evt-s6-0001'), 'S6: fresh needs_decision projected');
  rawTask = await readTask(s1Task);
  check(/status: waiting_for_decision/.test(rawTask), 'S6: task waiting for the injected crash');

  const s6Before = issueStoreSummary(await readStore(), s1Issue);
  const s6Crash = await crashAfterTaskSave(s1Task, 'stream-syn-0006', 'block');
  check(s6Crash.threw !== null && s6Crash.threw.includes('simulated crash'), 'S6: the run died right after the task write');
  check(s6Crash.actionRequestStatus === 'handled', 'S6: action_request handled before the crash');
  check(s6Crash.handledStreamEventId === 'stream-syn-0006', 'S6: durable stream-event marker on the task');
  check(s6Crash.handledTerminalStep === 'completed_without_resume', 'S6: terminal step persisted with the transition');
  check(s6Crash.ledgerStep === 'received', 'S6: ledger stuck at received');
  check(s6Crash.recordedAudits === 0, 'S6: audit append never landed');

  const s6Healed = await atlReply('stream-syn-0006', TRUSTED_SENDER, `block ${s1Task}`);
  check(s6Healed.status === 'completed' && s6Healed.step === 'completed_without_resume', `S6: heal outcome ${s6Healed.status}/${s6Healed.step}`);
  const s6After = issueStoreSummary(await readStore(), s1Issue);
  check(s6After.comments === s6Before.comments + 1, 'S6: exactly one response comment after the heal');
  check(s6After.runs === s6Before.runs, 'S6: block heals without any rerun');
  const s6Ledger = await readLedger('multica-responses.json');
  const s6Record = s6Ledger?.records?.find((record) => record.streamEventId === 'stream-syn-0006');
  check(s6Record?.step === 'completed_without_resume', 'S6: healed ledger terminal step');

  // S7 — CR fix 3 failure injection: the pre-comment runs read-back fails;
  // the outcome stays remote_write_unknown and the next real reply
  // reconciles the baseline before the comment/rerun decisions.
  await appendEventComment(
    s5Issue.id,
    'cmt-0202',
    needsDecisionEvent(s5Task, 'evt-s7-0001', new Date().toISOString()),
    new Date().toISOString(),
  );
  const s7Ingest = await atl(['multica', 'ingest', '--task-id', s5Task], 'fresh pending request for the read-back failure');
  check(s7Ingest.outcomes.some((outcome) => outcome.action === 'projected' && outcome.eventId === 'evt-s7-0001'), 'S7: fresh needs_decision projected');

  const s7Before = issueStoreSummary(await readStore(), s5Issue.id);
  const s7Failure = await runReadBackFailure(s5Task, 'stream-syn-0007', 'select:retry_with_fixture');
  check(s7Failure.status === 'remote_write_unknown', `S7: outcome ${s7Failure.status}`);
  check((s7Failure.reason ?? '').includes('run baseline read-back'), 'S7: reason names the failed baseline read-back');
  check(s7Failure.ledgerStep === 'atl_recorded', 'S7: ledger holds at atl_recorded');
  check(s7Failure.responseCommentId === null, 'S7: no comment written on the unproven baseline');
  const s7During = issueStoreSummary(await readStore(), s5Issue.id);
  check(s7During.comments === s7Before.comments && s7During.runs === s7Before.runs, 'S7: zero remote writes while the read-back is unknown');

  const s7Recovered = await atlReply('stream-syn-0007', TRUSTED_SENDER, `select:retry_with_fixture ${s5Task}`);
  check(s7Recovered.status === 'completed' && s7Recovered.step === 'supervisor_resumed', `S7: recovered outcome ${s7Recovered.status}/${s7Recovered.step}`);
  const s7After = issueStoreSummary(await readStore(), s5Issue.id);
  check(s7After.comments === s7Before.comments + 1, 'S7: exactly one response comment after recovery');
  check(s7After.runs === s7Before.runs + 1, 'S7: exactly one new run after recovery — a real diff, not a fabricated baseline');
  const s7Ledger = await readLedger('multica-responses.json');
  const s7Record = s7Ledger?.records?.find((record) => record.streamEventId === 'stream-syn-0007');
  check(s7Record?.step === 'supervisor_resumed' && s7Record?.remoteWriteUnknown === null, 'S7: recovered ledger is terminal and clean');

  // S8 — TEP-50 fix 1 failure injection: the crash leaves only the handled
  // Task write, then a NEWER event is ingested and REPLACES the handled
  // request before the retry. The retained handled_action_requests history
  // keeps the durable evidence; the real reply heals the ORIGINAL stream
  // event exactly once (one comment, one rerun, newer request still pending).
  const s8Task = 'task-20260820-synr003';
  const s8Issue = await seedLinkedIssue(s8Task, [
    { id: 'cmt-0301', parent_id: null, body: eventBody(needsDecisionEvent(s8Task, 'evt-s8-0001', '2026-08-20T12:00:00.000Z')), created_at: '2026-08-20T12:00:00.000Z', author_type: 'agent' },
  ]);
  await writeTask(s8Task, s8Issue);
  const s8Ingest = await atl(['multica', 'ingest', '--task-id', s8Task], 'pending request for the supersession crash boundary');
  check(s8Ingest.outcomes.some((outcome) => outcome.action === 'projected' && outcome.eventId === 'evt-s8-0001'), 'S8: original event projected');

  const s8Crash = await crashAfterTaskSave(s8Task, 'stream-syn-0008', 'select:retry_with_fixture');
  check(s8Crash.threw !== null && s8Crash.threw.includes('simulated crash'), 'S8: the run died right after the task write');
  check(s8Crash.actionRequestStatus === 'handled', 'S8: action_request handled before the crash');
  check(s8Crash.handledStreamEventId === 'stream-syn-0008', 'S8: durable stream-event marker on the task');
  check(s8Crash.handledTerminalStep === 'supervisor_resumed', 'S8: terminal step persisted with the transition');
  check(s8Crash.ledgerStep === 'received', 'S8: ledger stuck at received');
  check(s8Crash.recordedAudits === 0, 'S8: audit append never landed');

  // The newer event offers a DIFFERENT option set, so the original reply
  // action is illegal for it — only retained evidence can heal the retry.
  const s8NewerAt = new Date().toISOString();
  await appendEventComment(
    s8Issue,
    'cmt-0302',
    needsDecisionEvent(s8Task, 'evt-s8-0002', s8NewerAt, [
      { id: 'switch_strategy', label: '切换恢复策略' },
    ]),
    s8NewerAt,
  );
  const s8Supersede = await atl(['multica', 'ingest', '--task-id', s8Task], 'newer event replaces the handled request');
  check(s8Supersede.outcomes.some((outcome) => outcome.action === 'projected' && outcome.eventId === 'evt-s8-0002'), 'S8: newer event projected');
  rawTask = await readTask(s8Task);
  check(/action_id: action:task-20260820-synr003:evt-s8-0002/.test(rawTask), 'S8: current action_request is the newer event');
  check(/handled_action_requests:/.test(rawTask) && /handled_stream_event_id: stream-syn-0008/.test(rawTask), 'S8: replaced handled request retained in the durable history');

  // Baseline for the heal diff: the crash and the supersede wrote no response
  // comment and triggered no run.
  const s8Before = issueStoreSummary(await readStore(), s8Issue);

  const s8Healed = await atlReply('stream-syn-0008', TRUSTED_SENDER, `select:retry_with_fixture ${s8Task}`);
  check(s8Healed.status === 'completed' && s8Healed.step === 'supervisor_resumed', `S8: heal outcome ${s8Healed.status}/${s8Healed.step}`);
  const s8After = issueStoreSummary(await readStore(), s8Issue);
  check(s8After.comments === s8Before.comments + 1, 'S8: exactly one response comment for the healed original event');
  check(s8After.runs === s8Before.runs + 1, 'S8: exactly one rerun for the healed original event');
  const s8Ledger = await readLedger('multica-responses.json');
  const s8Record = s8Ledger?.records?.find((record) => record.streamEventId === 'stream-syn-0008');
  check(s8Record?.eventId === 'evt-s8-0001', 'S8: healed record carries the ORIGINAL event id');
  check(s8Record?.step === 'supervisor_resumed', 'S8: healed ledger terminal step');
  rawTask = await readTask(s8Task);
  check(/action_id: action:task-20260820-synr003:evt-s8-0002/.test(rawTask) && /status: pending/.test(rawTask), 'S8: newer request stays pending for its own decision cycle');
  const s8Replay = await atlReply('stream-syn-0008', TRUSTED_SENDER, `select:retry_with_fixture ${s8Task}`);
  check(s8Replay.status === 'completed', 'S8: replay of the healed stream event is idempotent');
  const s8Final = issueStoreSummary(await readStore(), s8Issue);
  check(s8Final.comments === s8Before.comments + 1 && s8Final.runs === s8Before.runs + 1, 'S8: replay added no second comment and no second rerun');

  // S9 — TEP-50 fix 2 failure injection: the response comment lands and its
  // run starts, but the confirmation is remote_write_unknown. The retry finds
  // the marker, reuses the PERSISTED pre-comment baseline, adopts the
  // comment-triggered run, and triggers zero duplicate reruns.
  const s9Task = 'task-20260820-synr004';
  const s9Issue = await seedLinkedIssue(s9Task, [
    { id: 'cmt-0401', parent_id: null, body: eventBody(needsDecisionEvent(s9Task, 'evt-s9-0001', '2026-08-20T13:00:00.000Z')), created_at: '2026-08-20T13:00:00.000Z', author_type: 'agent' },
  ]);
  await writeTask(s9Task, s9Issue);
  const s9Ingest = await atl(['multica', 'ingest', '--task-id', s9Task], 'pending request for the uncertain comment confirmation');
  check(s9Ingest.outcomes.some((outcome) => outcome.action === 'projected' && outcome.eventId === 'evt-s9-0001'), 'S9: needs_decision projected');

  const s9Before = issueStoreSummary(await readStore(), s9Issue);
  const s9Unknown = await uncertainCommentLanding(s9Task, 'stream-syn-0009', 'select:retry_with_fixture');
  check(s9Unknown.status === 'remote_write_unknown', `S9: outcome ${s9Unknown.status}`);
  check((s9Unknown.reason ?? '').includes('comment add'), 'S9: reason names the uncertain comment add');
  check(s9Unknown.ledgerStep === 'atl_recorded', 'S9: ledger holds at atl_recorded');
  check(JSON.stringify(s9Unknown.baselineRunIds) === JSON.stringify(['run-0001']), `S9: pre-comment baseline persisted before the write (${JSON.stringify(s9Unknown.baselineRunIds)})`);
  check(JSON.stringify(s9Unknown.runIds) === JSON.stringify([]), 'S9: no run diff recorded yet');
  const s9During = issueStoreSummary(await readStore(), s9Issue);
  check(s9During.comments === s9Before.comments + 1, 'S9: the comment landed despite the unknown confirmation');

  // The landed comment triggered exactly one remote run before the retry.
  await appendTriggeredRun(s9Issue, 'run-comment-triggered');
  const s9Triggered = issueStoreSummary(await readStore(), s9Issue);
  check(s9Triggered.runs === s9Before.runs + 1, 'S9: exactly one comment-triggered run');

  const s9Recovered = await atlReply('stream-syn-0009', TRUSTED_SENDER, `select:retry_with_fixture ${s9Task}`);
  check(s9Recovered.status === 'completed' && s9Recovered.step === 'supervisor_resumed', `S9: retry outcome ${s9Recovered.status}/${s9Recovered.step}`);
  const s9After = issueStoreSummary(await readStore(), s9Issue);
  check(s9After.comments === s9Before.comments + 1, 'S9: still exactly one response comment — the marker was found');
  check(s9After.runs === s9Triggered.runs, `S9: zero duplicate reruns on retry (${s9Before.runs} -> ${s9Triggered.runs} -> ${s9After.runs})`);
  const s9Ledger = await readLedger('multica-responses.json');
  const s9Record = s9Ledger?.records?.find((record) => record.streamEventId === 'stream-syn-0009');
  check(s9Record?.step === 'supervisor_resumed', 'S9: retry reaches the terminal resume step');
  check(JSON.stringify(s9Record?.baselineRunIds) === JSON.stringify(['run-0001']), 'S9: ledger kept the pre-comment baseline');
  check((s9Record?.runIds ?? []).includes('run-comment-triggered'), 'S9: the comment-triggered run is the adopted supervisor run');
  check(s9Record?.remoteWriteUnknown === null, 'S9: retry cleared the unknown');

  const receipt = {
    schema_version: 1,
    task: 'PAW-GOAL-003-T2',
    kind: 'synthetic_action_roundtrip_receipt',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    vault_root: vaultRoot,
    fake_multica_store: fakeStorePath,
    delivery: 'stubbed (no real DingTalk write, marker comment and run diff observed in the fake store)',
    steps,
    assertions: {
      s1_projection: 'needs_decision projected once; natural language ignored; wrong-task rejected',
      s1_notification: `stable key multica:${s1Task}:evt-s1-0001:needs_decision; messageId synthetic-ding-msg-0001`,
      s2_four_steps: 'received -> atl_recorded -> remote_response_confirmed -> supervisor_resumed; one marker comment threaded on the event comment; exactly one new run',
      s3_replay: 'replay + responses continuation: still one marker comment and one new run',
      s4_untrusted: 'foreign sender rejected with zero remote writes',
      s5_blocked_rework: 'recoverable blocked -> blocked; legal rework -> agent_executable + supervisor resumed',
      s6_crash_boundary: 'task save landed with handled_stream_event_id + handled_terminal_step; audit and ledger writes lost; real reply heals to completed_without_resume with no rerun',
      s7_run_read_back_failure: 'failed pre-comment runs read-back stays remote_write_unknown with zero remote writes; next real reply reconciles the baseline and completes with one comment + one new run',
      s8_supersession_heal: 'after the crash a newer event replaced the handled request (retained in handled_action_requests); the real reply healed the ORIGINAL stream event exactly once — one comment, one rerun, newer request still pending, idempotent replay',
      s9_uncertain_comment_confirmation: 'comment landed and triggered one run while its confirmation was remote_write_unknown; the persisted pre-comment baseline made the retry find the marker, adopt the triggered run, and add zero duplicate reruns',
    },
  };

  if (receiptPath !== null) {
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`receipt written: ${receiptPath}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
} finally {
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
}
