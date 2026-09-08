import { readdir, readFile, rm, stat, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, '..');
const cliPath = join(appRoot, 'src', 'cli.ts');
const vaultRoot = await mkdtemp(join(tmpdir(), 'paw-v02-synthetic-loop-'));
// Decision CLI `--input` payloads are staged outside the vault (TEP27-G4 Task 8).
const stagingRoot = await mkdtemp(join(tmpdir(), 'paw-v02-loop-inputs-'));
const startedAt = new Date().toISOString();
const events = [];

const TRACE_IDS = {
  inputRouting: 'dt_paw002inputrouting01',
  agentAdmission: 'dt_paw002agentadmiss001',
  resultAcceptance: 'dt_paw002resultaccept01',
  attentionPriority: 'dt_paw002attnpriority01',
};
const ACCEPTANCE_IDEMPOTENCY_KEY = 'paw002-result-acceptance-001';
const CORRECTION_IDEMPOTENCY_KEY = 'paw002-attention-correction-001';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCli(args, expectedExitCode = 0) {
  const environment = { ...process.env, ATL_VAULT_ROOT: vaultRoot };
  delete environment.ATL_ALLOW_REAL_WRITES;
  environment.ATL_MULTICA_BINARY = join(vaultRoot, '.missing-multica');
  const result = await execa('pnpm', ['exec', 'tsx', cliPath, ...args], {
    cwd: appRoot,
    env: environment,
    reject: false,
  });
  check(
    result.exitCode === expectedExitCode,
    `atl ${args.join(' ')} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
  );
  return result.stdout === '' ? null : JSON.parse(result.stdout);
}

async function write(relativePath, content) {
  const target = join(vaultRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return relativePath;
}

async function stageInput(name, payload) {
  const path = join(stagingRoot, `${name}.json`);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path;
}

async function createPolicy(policy) {
  const input = await stageInput(`policy-${policy.policy_id}-${policy.version}`, policy);
  return runCli(['decision', 'policy', 'create', '--input', input, '--json']);
}

async function createTrace(trace) {
  const input = await stageInput(`trace-${trace.trace_id}`, trace);
  return runCli(['decision', 'trace', 'create', '--input', input, '--json']);
}

function policyPath(policy) {
  return `07_System/Rules/Decision_Logic/${policy.dimension}/${policy.policy_id}_${policy.version}.md`;
}

function yearMonthOf(createdAt) {
  return `${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`;
}

function tracePath(trace) {
  return `07_System/Logs/Decision_Traces/${yearMonthOf(trace.created_at)}/${trace.trace_id}.md`;
}

function feedbackPath(sample) {
  return `07_System/Logs/Decision_Feedback/${yearMonthOf(sample.created_at)}/${sample.feedback_id}.md`;
}

function policyInput({
  policyId,
  version = 'v001',
  status = 'observing',
  dimension,
  question,
  rules,
  rationale,
}) {
  return {
    policy_id: policyId,
    version,
    status,
    dimension,
    decision_question: question,
    inputs: [
      { name: 'Stable source reference', source: 'synthetic_input' },
      { name: 'Accepted Goal and task context', source: 'goal:PAW-GOAL-002@0.1' },
      { name: 'Permission and acceptance boundary', source: 'PAW-GOAL-002@0.1' },
    ],
    sources: ['synthetic_input', 'PAW-GOAL-002@0.1'],
    rules: rules.map((statement, index) => ({ statement, priority: (index + 1) * 10 })),
    exceptions: [
      'Real external writes always require a separate current authorization.',
      'Synthetic evidence cannot prove a production integration.',
    ],
    outputs: ['An explainable state plus a Decision Trace reference.'],
    rationale,
    examples: [],
    counterexamples: [],
    metrics: ['trace_coverage', 'user_correction_rate', 'first_pass_acceptance_rate'],
    next_review_at: '2026-08-24',
    created_at: startedAt,
  };
}

function traceInput({
  traceId,
  policyRef,
  dimension,
  inputRefs,
  decision,
  reasoning,
  evidenceRefs,
  confidence,
}) {
  return {
    trace_id: traceId,
    policy_ref: policyRef,
    dimension,
    input_refs: inputRefs,
    decision,
    reasoning_summary: reasoning,
    evidence_refs: evidenceRefs,
    confidence,
    created_at: startedAt,
  };
}

async function findFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? findFiles(path) : [path];
  }));
  return nested.flat();
}

check(relative(tmpdir(), vaultRoot).startsWith('paw-v02-synthetic-loop-'), 'Vault must be under os.tmpdir()');

await runCli([
  'project', 'create',
  '--project-id', 'paw-v02-synthetic',
  '--name', 'PAW V0.2 synthetic validation',
  '--description', 'De-identified vertical slice for PAW-GOAL-002.',
  '--json',
]);
events.push({ stage: 'project_created', status: 'pass' });

const captured = await runCli([
  'task', 'capture',
  '--title', 'Validate the V0.2 synthetic workbench loop',
  '--body', 'Run a de-identified local loop and return auditable evidence.',
  '--origin', 'synthetic_goal_contract',
  '--source-date', '2026-08-17',
  '--source-key', 'goal:PAW-GOAL-002@0.1',
  '--priority', 'high',
  '--json',
]);
check(captured.status === 'inbox', 'Captured task must start in inbox');
events.push({ stage: 'input_routed', status: captured.status, taskId: captured.taskId });

const policies = [];
policies.push(await createPolicy(policyInput({
  policyId: 'policy.input-routing.synthetic',
  dimension: 'input-routing',
  question: 'Should a traceable synthetic input become a task candidate?',
  rules: [
    'Preserve source_key and create an Inbox candidate first.',
    'Do not authorize Agent execution during capture.',
  ],
  rationale: 'A traceable synthetic source becomes an Inbox candidate first; capture never implies execution authorization.',
})));
policies.push(await createPolicy(policyInput({
  policyId: 'policy.attention-priority.synthetic',
  dimension: 'attention-priority',
  question: 'Why should this candidate appear now?',
  rules: [
    'Require a current accepted Goal or time-sensitive evidence.',
    'Cards without reason, source, action, confidence and policy_ref cannot enter today-required.',
  ],
  rationale: 'Attention requires a current reason grounded in an accepted Goal or time-sensitive evidence.',
})));
policies.push(await createPolicy(policyInput({
  policyId: 'policy.agent-admission.synthetic',
  dimension: 'agent-admission',
  question: 'May an Agent claim this task?',
  rules: [
    'Confirmation and readiness are necessary but do not imply authorization.',
    'Only explicit authorization may produce agent_executable.',
  ],
  rationale: 'Agent admission is a separate explicit gate; readiness alone never authorizes a claim.',
})));
policies.push(await createPolicy(policyInput({
  policyId: 'policy.result-acceptance.synthetic',
  dimension: 'result-acceptance',
  question: 'Does the Artifact meet the accepted criteria?',
  rules: [
    'Every criterion needs an explicit status and evidence reference.',
    'Synthetic approval proves mechanics only, not production value.',
  ],
  rationale: 'Acceptance requires per-criterion evidence; synthetic approval proves mechanics only.',
})));
check(policies.every((policy) => policy.status === 'observing'), 'Synthetic policies must start observing');
events.push({ stage: 'policy_versions_created', status: 'pass', count: policies.length });

const traces = [];
traces.push(await createTrace(traceInput({
  traceId: TRACE_IDS.inputRouting,
  policyRef: 'policy.input-routing.synthetic@v001',
  dimension: 'input-routing',
  inputRefs: ['goal:PAW-GOAL-002@0.1', `task:${captured.taskId}`],
  decision: 'candidate_inbox',
  reasoning: 'The source is traceable but execution has not been confirmed or authorized.',
  evidenceRefs: ['source_key:goal:PAW-GOAL-002@0.1'],
  confidence: 'high',
})));
events.push({ stage: 'decision_trace_recorded', status: 'pass', traceId: TRACE_IDS.inputRouting });

const confirmed = await runCli([
  'task', 'confirm',
  '--legacy-local',
  '--task-id', captured.taskId,
  '--project-id', 'paw-v02-synthetic',
  '--objective', 'Produce a replayable V0.2 synthetic loop receipt.',
  '--acceptance-criterion', 'Archive one accepted Artifact.',
  '--acceptance-criterion', 'Persist separate ATL Audit and Decision Trace evidence.',
  '--priority', 'high',
  '--json',
]);
check(confirmed.status === 'ready' && confirmed.autoExecutable === false, 'Confirmation must not authorize execution');
events.push({ stage: 'candidate_confirmed', status: confirmed.status });

const unauthorized = await runCli([
  'task', 'next', '--claim',
  '--task-id', captured.taskId,
  '--agent', 'synthetic-executor',
  '--run-id', 'run-paw002-unauthorized',
  '--json',
], 1);
check(unauthorized.error?.code === 'task_not_eligible_for_claim', 'Unauthorized claim must be rejected');
events.push({ stage: 'unauthorized_claim_rejected', status: 'pass', code: unauthorized.error.code });

const authorized = await runCli([
  'task', 'authorize-agent', '--legacy-local', '--task-id', captured.taskId, '--json',
]);
check(authorized.status === 'agent_executable' && authorized.autoExecutable === true, 'Authorization must produce agent_executable');
events.push({ stage: 'agent_admitted', status: authorized.status });

traces.push(await createTrace(traceInput({
  traceId: TRACE_IDS.agentAdmission,
  policyRef: 'policy.agent-admission.synthetic@v001',
  dimension: 'agent-admission',
  inputRefs: [`task:${captured.taskId}`, 'goal:PAW-GOAL-002@0.1'],
  decision: 'agent_executable',
  reasoning: 'The unauthorized claim failed; confirmation, context and explicit authorization are now present.',
  evidenceRefs: ['error:task_not_eligible_for_claim', `task_status:${authorized.status}`],
  confidence: 'high',
})));
events.push({ stage: 'decision_trace_recorded', status: 'pass', traceId: TRACE_IDS.agentAdmission });

const claimed = await runCli([
  'task', 'next', '--claim',
  '--task-id', captured.taskId,
  '--agent', 'synthetic-executor',
  '--run-id', 'run-paw002-001',
  '--json',
]);
check(claimed.status === 'in_progress', 'Claimed task must be in_progress');
events.push({ stage: 'execution_started', status: claimed.status });

const resultPath = await write('synthetic-result.json', `${JSON.stringify({
  summary: 'The V0.2 synthetic workbench loop completed.',
  findings: [
    'Confirmation and Agent authorization are separate gates.',
    'Decision Trace is stored separately from ATL Audit.',
  ],
  evidence: [{
    title: 'PAW-GOAL-002 local contract',
    url: 'https://example.invalid/paw-goal-002-synthetic-evidence',
    accessedAt: startedAt,
  }],
  uncertainties: [
    'Real Staywork, DingTalk, Claudian and production Vault integrations remain unverified.',
  ],
  recommendedActions: [
    'Run the decision-domain loop against real examples once the pilot starts.',
  ],
  acceptance: [
    {
      criterion: 'Archive one accepted Artifact.',
      status: 'met',
      note: 'The Artifact is submitted for synthetic review.',
    },
    {
      criterion: 'Persist separate ATL Audit and Decision Trace evidence.',
      status: 'met',
      note: 'Both evidence families are written to distinct paths.',
    },
  ],
}, null, 2)}\n`);

const submitted = await runCli([
  'task', 'submit',
  '--task-id', captured.taskId,
  '--run-id', 'run-paw002-001',
  '--result', join(vaultRoot, resultPath),
  '--json',
]);
check(submitted.status === 'review' && submitted.artifactRefs.length === 1, 'Submission must create one review Artifact');
events.push({ stage: 'artifact_submitted', status: submitted.status, artifactRef: submitted.artifactRefs[0] });

const approved = await runCli([
  'task', 'review', '--task-id', captured.taskId, '--approve', '--json',
]);
check(approved.status === 'done', 'Approved task must be done');
events.push({ stage: 'result_accepted', status: approved.status });

traces.push(await createTrace(traceInput({
  traceId: TRACE_IDS.resultAcceptance,
  policyRef: 'policy.result-acceptance.synthetic@v001',
  dimension: 'result-acceptance',
  inputRefs: [`task:${captured.taskId}`, `artifact:${submitted.artifactRefs[0]}`],
  decision: 'accepted_synthetic',
  reasoning: 'The Artifact explicitly satisfies both accepted criteria; mechanics are proven, production value is not.',
  evidenceRefs: [`artifact:${submitted.artifactRefs[0]}`, `task_status:${approved.status}`],
  confidence: 'medium',
})));
events.push({ stage: 'decision_trace_recorded', status: 'pass', traceId: TRACE_IDS.resultAcceptance });

traces.push(await createTrace(traceInput({
  traceId: TRACE_IDS.attentionPriority,
  policyRef: 'policy.attention-priority.synthetic@v001',
  dimension: 'attention-priority',
  inputRefs: ['goal:PAW-GOAL-002@0.1', `task:${captured.taskId}`],
  decision: 'important_not_urgent',
  reasoning: 'The first synthetic classification missed the accepted Goal execution timing.',
  evidenceRefs: ['accepted_goal:PAW-GOAL-002@0.1'],
  confidence: 'medium',
})));
events.push({ stage: 'decision_trace_recorded', status: 'pass', traceId: TRACE_IDS.attentionPriority });

const approval = await runCli([
  'decision', 'feedback', 'record',
  '--trace', TRACE_IDS.resultAcceptance,
  '--kind', 'accepted',
  '--source-ref', `task:${captured.taskId}`,
  '--stability', 'single_exception',
  '--idempotency-key', ACCEPTANCE_IDEMPOTENCY_KEY,
  '--json',
]);
check(approval.created === true, 'Acceptance feedback must create a new sample');
events.push({
  stage: 'feedback_recorded',
  status: 'pass',
  traceId: TRACE_IDS.resultAcceptance,
  feedbackId: approval.sample.feedback_id,
});

const correctionArgs = [
  'decision', 'feedback', 'record',
  '--trace', TRACE_IDS.attentionPriority,
  '--kind', 'corrected',
  '--source-ref', 'goal:PAW-GOAL-002@0.1',
  '--correction-summary', 'Accepted Goal execution should appear under today_required.',
  '--stability', 'single_exception',
  '--idempotency-key', CORRECTION_IDEMPOTENCY_KEY,
  '--json',
];
const correction = await runCli(correctionArgs);
check(correction.created === true, 'Correction feedback must create a new sample');
const correctionReplay = await runCli(correctionArgs);
check(
  correctionReplay.created === false
    && correctionReplay.sample.feedback_id === correction.sample.feedback_id,
  'Idempotent replay must return the original sample',
);
events.push({
  stage: 'feedback_recorded',
  status: 'pass',
  traceId: TRACE_IDS.attentionPriority,
  feedbackId: correction.sample.feedback_id,
  replayCreatedAgain: correctionReplay.created,
});

const correctedTrace = await runCli(['decision', 'trace', 'get', TRACE_IDS.attentionPriority, '--json']);
check(correctedTrace.decision === 'important_not_urgent', 'Original decision must remain after feedback');
check(correctedTrace.user_feedback === 'corrected', 'Derived summary must reflect the correction kind');
check(correctedTrace.feedback_count === 1, 'Idempotent replay must not add a second sample');
check(correctedTrace.status === 'feedback_recorded', 'Trace status must derive from the sample set');
check(correctedTrace.feedback_summary_status === 'fresh', 'Rebuilt summary must be fresh');

const acceptedTrace = await runCli(['decision', 'trace', 'get', TRACE_IDS.resultAcceptance, '--json']);
check(acceptedTrace.user_feedback === 'accepted', 'Derived summary must reflect the acceptance kind');
check(acceptedTrace.feedback_count === 1, 'Acceptance trace must summarize exactly one sample');
events.push({ stage: 'derived_summaries_verified', status: 'pass', traces: 2 });

const consistency = await runCli(['decision', 'check-consistency', '--json']);
check(consistency.checked_traces === traces.length, 'Consistency check must cover every native trace');
check(consistency.issues.length === 0, 'Decision consistency must be clean');
events.push({ stage: 'consistency_clean', status: 'pass', checkedTraces: consistency.checked_traces });

const candidatePolicy = await createPolicy(policyInput({
  policyId: 'policy.attention-priority.synthetic',
  version: 'v002',
  status: 'draft',
  dimension: 'attention-priority',
  question: 'Why should an accepted Goal execution appear now?',
  rules: [
    'An accepted Goal with an active local verification window is a today-required candidate.',
    'Keep status observing until real examples and counterexamples are reviewed.',
  ],
  rationale: 'Draft candidate proposed by the synthetic correction; activation requires reviewed examples and counterexamples.',
}));
check(candidatePolicy.status === 'draft', 'The correction-proposed version must stay a draft');

const activePolicies = await runCli(['decision', 'policy', 'list', '--status', 'active', '--json']);
check(activePolicies.length === 0, 'No synthetic policy may be active');
const attentionVersions = await runCli([
  'decision', 'policy', 'list-versions', 'policy.attention-priority.synthetic', '--json',
]);
check(
  attentionVersions.map((version) => version.version).join(',') === 'v001,v002',
  'The correction must propose a new version, not mutate v001',
);
events.push({ stage: 'policy_candidate_drafted', status: 'pass', version: 'v002' });

const decisionQuery = await runCli(['decision', 'query', '--json']);
check(decisionQuery.items.length === traces.length, 'Unified query must return every native trace');
check(
  decisionQuery.items.every((item) => item.integrity_status === 'valid' && item.source === 'native'),
  'Every queried decision must be a valid native object',
);
check(decisionQuery.facets.trace_status.recorded === 2, 'Two traces must remain without feedback');
check(decisionQuery.facets.trace_status.feedback_recorded === 2, 'Two traces must carry feedback');
const correctedItem = decisionQuery.items.find((item) => item.trace_id === TRACE_IDS.attentionPriority);
check(correctedItem?.user_feedback === 'corrected', 'Query projection must carry the derived summary');
const unrelatedWarnings = decisionQuery.warnings.filter((warning) => !(
  warning.code === 'legacy_schema_unparseable'
  && warning.detail.includes('candidate.eval-attention-priority-001')
));
check(unrelatedWarnings.length === 0, 'Unified query must stay clean for decision objects');
events.push({ stage: 'decision_query_verified', status: 'pass', items: decisionQuery.items.length });

// Projection writes stay direct: the PRD scope covers Policy/Trace/Feedback only.
const attentionTraceRef = tracePath(correctedTrace);
const capabilityCandidatePath = await write(
  '07_System/Rules/Decision_Logic/capability-upgrade/candidate.eval-attention-priority-001.md',
  `---
type: capability_upgrade_candidate
candidate_id: candidate.eval-attention-priority-001
capability_type: eval
status: draft
source_trace_refs:
  - ${TRACE_IDS.attentionPriority}
proposed_at: ${startedAt}
---

# Attention priority Eval candidate

Add positive and counterexample fixtures for accepted Goal timing before promoting policy v002.
`,
);

const dashboardPath = await write(
  '00_Dashboard/每日驾驶舱-v0.2.md',
  `# 每日驾驶舱 V0.2 - Synthetic

## 状态摘要

- 本周目标：PAW-GOAL-002 synthetic loop
- 今日容量：synthetic fixture; no real calendar data
- Agent 状态：done
- 数据新鲜度：${startedAt}

## 今天必须处理

### Validate the V0.2 synthetic workbench loop

- 为什么现在出现：已接受 Goal 正在本次验证窗口执行
- 来源：goal:PAW-GOAL-002@0.1
- 目标影响：验证 V0.2 最小纵向切片
- 截止或时效：2026-08-17
- 建议动作：回读 Artifact、Trace 和验证 Receipt
- 置信度：high_for_mechanics
- policy_ref：policy.attention-priority.synthetic@v001
- decision_trace_ref：${attentionTraceRef}
- discussion_ref：claudian:synthetic/PAW-GOAL-002
`,
);

const policyPaths = policies.map((policy) => policyPath(policy));
const tracePaths = traces.map((trace) => tracePath(trace));
const candidatePolicyPath = policyPath(candidatePolicy);

const decisionIndexPath = await write(
  '00_Dashboard/决策逻辑索引.md',
  `# 决策逻辑索引 - Synthetic

## Policies

${[...policyPaths, candidatePolicyPath].map((path) => `- [[${path}]]`).join('\n')}

## Recent traces

${tracePaths.map((path) => `- [[${path}]]`).join('\n')}

## Pending CR

- [[${capabilityCandidatePath}]]
`,
);

const basePath = await write(
  '00_Dashboard/决策逻辑.base',
  `filters:
  and:
    - file.folder.startsWith("07_System/Rules/Decision_Logic")
views:
  - type: table
    name: Decision Policies
    order:
      - file.name
      - dimension
      - status
      - next_review_at
`,
);

const weeklyReviewPath = await write(
  '05_Reviews/Weekly/2026-W34.md',
  `# 2026-W34 - Synthetic

## 本周重点

- PAW-GOAL-002 V0.2 最小闭环
- discussion_ref: claudian:synthetic/PAW-GOAL-002

## 决策逻辑复盘

- Trace 覆盖：4/4 synthetic decisions
- 误判：accepted Goal execution was initially important_not_urgent
- 用户反馈：synthetic correction to today_required
- 原判断保留：yes
- 新规则候选：policy.attention-priority.synthetic@v002, status=draft
- 能力升级候选：candidate.eval-attention-priority-001, status=draft
- 自动生效：no
- 真实数据缺口：Staywork, DingTalk, Claudian, calendar capacity and production Vault remain unverified
`,
);

const finalTasks = await runCli(['task', 'list', '--json']);
check(finalTasks.length === 1 && finalTasks[0].status === 'done', 'Final task list must contain one done task');
const doctor = await runCli(['doctor', '--json']);
check(doctor.ok === true && doctor.issues.length === 0, 'ATL doctor must report a healthy Vault');

const allFiles = await findFiles(vaultRoot);
const auditFiles = allFiles.filter((path) => path.includes('/10_Tasks/Audit/') && path.endsWith('.jsonl'));
check(auditFiles.length > 0, 'ATL Audit evidence must exist');
check(tracePaths.every((path) => !path.includes('10_Tasks/Audit')), 'Decision Trace must not be stored as ATL Audit');

const archivePath = join(
  '10_Tasks',
  'Archive',
  approved.updatedAt.slice(0, 4),
  `${captured.taskId}.md`,
);
const feedbackPaths = [approval.sample, correction.sample].map((sample) => feedbackPath(sample));
const requiredPaths = [
  archivePath,
  `10_Tasks/${submitted.artifactRefs[0]}`,
  ...policyPaths,
  ...tracePaths,
  ...feedbackPaths,
  candidatePolicyPath,
  capabilityCandidatePath,
  dashboardPath,
  decisionIndexPath,
  basePath,
  weeklyReviewPath,
];
for (const path of requiredPaths) {
  check((await stat(join(vaultRoot, path))).isFile(), `Required evidence is missing: ${path}`);
}

const correctionSample = await readFile(join(vaultRoot, feedbackPaths[1]), 'utf8');
check(
  correctionSample.includes('Accepted Goal execution should appear under today_required.'),
  'Correction sample must be readable',
);

await rm(stagingRoot, { recursive: true, force: true });

const receiptPath = '07_System/Logs/Verification/PAW-GOAL-002-synthetic-loop.json';
const receipt = {
  schemaVersion: 'paw.v0.2.synthetic-loop/1',
  goalRef: 'PAW-GOAL-002@0.1',
  scope: 'synthetic_temporary_vault',
  startedAt,
  finishedAt: new Date().toISOString(),
  vaultRoot,
  finalState: 'synthetic_loop_verified',
  taskId: captured.taskId,
  artifactRef: submitted.artifactRefs[0],
  archivePath,
  auditRefs: auditFiles.map((path) => relative(vaultRoot, path)),
  decisionTraceRefs: tracePaths,
  policyRefs: [...policyPaths, candidatePolicyPath],
  dashboardRef: dashboardPath,
  weeklyReviewRef: weeklyReviewPath,
  capabilityUpgradeCandidateRef: capabilityCandidatePath,
  checks: {
    sourcePreserved: captured.sourceKey === 'goal:PAW-GOAL-002@0.1',
    confirmationDidNotAuthorize: confirmed.autoExecutable === false,
    unauthorizedClaimRejected: unauthorized.error.code === 'task_not_eligible_for_claim',
    explicitAgentAdmission: authorized.status === 'agent_executable',
    artifactSubmitted: submitted.status === 'review',
    resultAcceptedAndArchived: approved.status === 'done',
    atlAuditSeparateFromDecisionTrace: auditFiles.length > 0,
    feedbackPreservedOriginalDecision: correctedTrace.decision === 'important_not_urgent'
      && correctedTrace.user_feedback === 'corrected'
      && correctedTrace.feedback_count === 1,
    highImpactCandidateNotActivated: candidatePolicy.status === 'draft' && activePolicies.length === 0,
    doctorHealthy: doctor.ok,
  },
  events,
  limitations: [
    'No real ClawVault write.',
    'No GitHub, DingTalk, Yunxiao, Claudian, remote repository or deployment write.',
    'No real Staywork input or product acceptance.',
    'Policies, traces and feedback are first-class ATL objects written through the decision CLI, but the loop still runs only against a synthetic temporary vault.',
  ],
};
await write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath }, null, 2)}\n`);
